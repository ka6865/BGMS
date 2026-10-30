import { describe, expect, it } from "vitest";
import { LolRankingKeyError, runLolRankingSnapshot, type RankingDependencies } from "../scripts/lol_ranking_snapshot";
import type { AccountState, RankingStore } from "@/lib/lol/ranking";
import { accountHmac, riotIdHmac, type SeasonCursor } from "@/lib/lol/ranking";

// 가짜 Riot 응답과 메모리 저장소로 수집기 흐름을 검증한다. 실제 Riot 호출은 하지 않는다.
const secret = "s".repeat(40);
const SEASON = "2026-01-08T00:00:00+09:00";
const SEASON_END = "2026-04-20T00:00:00+09:00";
const T0 = Date.parse(SEASON);
const HOUR = 3600_000;
const NOW0 = T0 + 30 * HOUR;
const puuid: Record<"A" | "B" | "C", string> = { A: "puuid-A-aaaaaaaaaaaaaaaaaaaa", B: "puuid-B-bbbbbbbbbbbbbbbbbbbb", C: "puuid-C-cccccccccccccccccccc" };
const names: Record<string, string> = { [puuid.A]: "Alpha", [puuid.B]: "Beta", [puuid.C]: "Gamma" };

type Match = { id: string; ts: number; queue: number; duration: number; participants: Array<{ puuid: string; championId: number; win: boolean }> };

// A는 266으로 20판(15승), B는 266으로 3판, C는 1로 2판이 세지는 경기다. A에는 큐 450과 다시하기도 하나씩 있다.
function fixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 20; i += 1) {
    const participants = [{ puuid: puuid.A, championId: 266, win: i % 4 !== 0 }];
    if (i <= 2) participants.push({ puuid: puuid.B, championId: 266, win: i % 2 === 0 });
    if (i === 1 || i === 2) participants.push({ puuid: puuid.C, championId: 1, win: true });
    matches.push({ id: `KR_${i}`, ts: T0 + (i + 1) * HOUR, queue: 420, duration: 1800, participants });
  }
  matches.push({ id: "KR_Q", ts: T0 + 21 * HOUR, queue: 450, duration: 1800, participants: [{ puuid: puuid.A, championId: 266, win: true }] });
  matches.push({ id: "KR_R", ts: T0 + 22 * HOUR, queue: 420, duration: 100, participants: [{ puuid: puuid.A, championId: 266, win: true }] });
  return matches;
}

const EXPECTED = { A: { 266: { games: 20, wins: 15 } }, B: { 266: { games: 3, wins: 2 } }, C: { 1: { games: 2, wins: 2 } } } as const;

function fakeRiot(opts: { matches?: Match[]; failAccount?: string[]; keyError?: boolean; malformed?: string[] } = {}) {
  const matches = opts.matches ?? fixture();
  const detailCalls = new Map<string, number>();
  const calls: string[] = [];
  const request = async (_host: "kr" | "asia", path: string): Promise<unknown> => {
    calls.push(path);
    if (opts.keyError) throw Object.assign(new Error("key"), { kind: "key_or_permission" });
    if (path.includes("/lol/league/v4/challengerleagues")) return { queue: "RANKED_SOLO_5x5", tier: "CHALLENGER", entries: [
      { puuid: puuid.A, leaguePoints: 1200, wins: 15, losses: 5 }, { puuid: puuid.B, leaguePoints: 1100, wins: 2, losses: 1 } ] };
    if (path.includes("/lol/league/v4/grandmasterleagues")) return { queue: "RANKED_SOLO_5x5", tier: "GRANDMASTER", entries: [
      { puuid: puuid.C, leaguePoints: 500, wins: 2, losses: 0 } ] };
    const account = path.match(/accounts\/by-puuid\/([^/?]+)$/);
    if (account) {
      const id = decodeURIComponent(account[1]);
      if (opts.failAccount?.includes(id)) throw Object.assign(new Error("nf"), { kind: "not_found" });
      return { puuid: id, gameName: names[id], tagLine: "KR1" };
    }
    const ids = path.match(/by-puuid\/([^/]+)\/ids\?.*startTime=(\d+)&start=(\d+)&count=(\d+)/);
    if (ids) {
      const id = decodeURIComponent(ids[1]);
      const from = Number(ids[2]) * 1000;
      const start = Number(ids[3]);
      const count = Number(ids[4]);
      const list = matches.filter(m => m.participants.some(p => p.puuid === id) && m.ts >= from).sort((a, b) => b.ts - a.ts);
      return list.slice(start, start + count).map(m => m.id);
    }
    const detail = path.match(/\/lol\/match\/v5\/matches\/([^/?]+)$/);
    if (detail) {
      const id = detail[1];
      detailCalls.set(id, (detailCalls.get(id) ?? 0) + 1);
      if (opts.malformed?.includes(id)) return { info: "broken" };
      const m = matches.find(item => item.id === id)!;
      return { metadata: { matchId: m.id }, info: { gameStartTimestamp: m.ts, queueId: m.queue, gameDuration: m.duration, participants: m.participants } };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { request, detailCalls, calls };
}

// 메모리 저장소. 커밋은 읽은 커서와 같을 때만 반영하는 실제 RPC 계약을 흉내 낸다.
function memoryStore() {
  const accounts = new Map<string, { season: string; state: AccountState; listed: string }>();
  const counts = new Map<string, Map<number, { games: number; wins: number }>>();
  const excluded = new Set<string>();
  const saved: { ranking: Array<{ rows: unknown[]; playerCount: number }>; master: Array<{ seasonKey: string; coverage: number; champions: unknown[] }>; purged: string[] } = {
    ranking: [], master: [], purged: [],
  };
  const keyOf = (season: string, hmac: string) => `${season}|${hmac}`;
  const store: RankingStore = {
    getAccountStates: async (season, keys) => keys.flatMap(key => {
      const row = accounts.get(keyOf(season, key));
      return row ? [row.state] : [];
    }),
    upsertAccount: async input => {
      if (excluded.has(input.riotIdHmac)) throw new Error("excluded account");
      const k = keyOf(input.seasonKey, input.accountHmac);
      const prev = accounts.get(k);
      accounts.set(k, { season: input.seasonKey, listed: input.listedAt, state: {
        accountHmac: input.accountHmac, riotId: input.riotId, riotIdHmac: input.riotIdHmac,
        resolvedAt: input.resolvedAt ?? prev?.state.resolvedAt ?? null, cursor: prev?.state.cursor ?? null, checkedAt: prev?.state.checkedAt ?? null,
      } });
    },
    commitProgress: async input => {
      const k = keyOf(input.seasonKey, input.accountHmac);
      const row = accounts.get(k);
      if (!row) throw new Error("season account missing");
      if ((row.state.cursor?.ms ?? null) !== input.expectedCursorMs) return "stale";
      const map = counts.get(k) ?? new Map<number, { games: number; wins: number }>();
      for (const delta of input.deltas) {
        const current = map.get(delta.championId) ?? { games: 0, wins: 0 };
        map.set(delta.championId, { games: current.games + delta.games, wins: current.wins + delta.wins });
      }
      counts.set(k, map);
      row.state = { ...row.state, cursor: input.cursor ?? row.state.cursor, checkedAt: input.checkedAt };
      return "ok";
    },
    listChampionCounts: async (season, keys) => keys.flatMap(key => [...(counts.get(keyOf(season, key)) ?? new Map()).entries()]
      .map(([championId, value]) => ({ accountHmac: key, championId, games: value.games, wins: value.wins }))),
    excludedKeys: async () => [...excluded],
    saveRankingPublication: async input => { saved.ranking.push({ rows: input.rows, playerCount: input.playerCount }); },
    saveMasterPublication: async input => { saved.master.push({ seasonKey: input.seasonKey, coverage: input.coverage, champions: input.champions }); },
    purgeExpiredSeasons: async nowIso => { saved.purged.push(nowIso); return 0; },
  };
  return { store, saved, excluded, counts, accounts };
}

function deps(over: Partial<RankingDependencies> & { riot?: ReturnType<typeof fakeRiot>; store: RankingStore; nowMs?: () => number }) {
  const nowMs = over.nowMs ?? (() => NOW0);
  return {
    request: over.riot?.request ?? fakeRiot().request,
    secret,
    seasonStart: SEASON,
    seasonEnd: SEASON_END,
    maxCalls: 10_000,
    checkIntervalHours: 0,
    sleep: async () => {},
    now: () => new Date(nowMs()),
    ...over,
  } as RankingDependencies;
}

const countsOf = (m: ReturnType<typeof memoryStore>, name: keyof typeof EXPECTED, season = "2026-01-08") => {
  const key = accountHmac(puuid[name], secret);
  return Object.fromEntries([...(m.counts.get(`${season}|${key}`) ?? new Map()).entries()]) as Record<number, { games: number; wins: number }>;
};

describe("장인 수집기: 시즌 누적과 게시", () => {
  it("dry-run은 저장하지 않고 읽기 결과만 돌려준다(시즌 종료 없이도 가능)", async () => {
    const m = memoryStore();
    const riot = fakeRiot();
    const result = await runLolRankingSnapshot(deps({ riot, store: m.store, seasonEnd: undefined }), ["--dry-run"], false);
    expect(result.dryRun).toBe(true);
    expect(result.published).toEqual({ ranking: false, master: false });
    expect(m.saved.ranking).toHaveLength(0);
    expect(m.saved.master).toHaveLength(0);
    expect(m.counts.size).toBe(0);
  });

  it("apply는 대상 계정별 챔피언 판수를 정확히 더하고 명단과 장인을 게시한다", async () => {
    const m = memoryStore();
    const result = await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], true);
    expect(countsOf(m, "A")).toEqual(EXPECTED.A);
    expect(countsOf(m, "B")).toEqual(EXPECTED.B);
    expect(countsOf(m, "C")).toEqual(EXPECTED.C);
    expect(result.published).toEqual({ ranking: true, master: true });
    expect(m.saved.ranking[0].rows).toHaveLength(3);
    expect(m.saved.master[0].champions).toEqual([expect.objectContaining({ champion_id: 266, eligible_count: 1 })]);
    expect(m.saved.master[0].coverage).toBe(100);
    expect(m.saved.purged).toHaveLength(1);
  });

  it("같은 실행을 다시 해도 판수가 늘지 않는다(멱등)", async () => {
    const m = memoryStore();
    await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], true);
    const second = await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, nowMs: () => NOW0 + HOUR }), ["--apply"], true);
    expect(countsOf(m, "A")).toEqual(EXPECTED.A);
    expect(countsOf(m, "B")).toEqual(EXPECTED.B);
    expect(second.counts.countedMatches).toBe(0);
  });

  it("한 경기는 같은 실행 안에서 한 번만 상세를 받고, 여러 대상 계정에 각각 한 번씩 반영된다", async () => {
    const m = memoryStore();
    const riot = fakeRiot();
    await runLolRankingSnapshot(deps({ riot, store: m.store }), ["--apply"], true);
    expect(Math.max(...riot.detailCalls.values())).toBe(1);
    expect(riot.detailCalls.get("KR_1")).toBe(1);
    expect(countsOf(m, "B")[266].games).toBe(3);
    expect(countsOf(m, "C")[1].games).toBe(2);
  });

  it("호출 상한에 닿으면 저장하고 멈추며, 다음 실행이 이어받아 최종 판수가 같다", async () => {
    const full = memoryStore();
    await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: full.store }), ["--apply"], true);

    const m = memoryStore();
    let exhaustedRuns = 0;
    for (let round = 0; round < 40; round += 1) {
      const result = await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, maxCalls: 9, nowMs: () => NOW0 + round * HOUR }), ["--apply"], true);
      if (result.budget.exhausted) exhaustedRuns += 1;
      else break;
    }
    expect(exhaustedRuns).toBeGreaterThan(0);
    expect(countsOf(m, "A")).toEqual(countsOf(full, "A"));
    expect(countsOf(m, "B")).toEqual(countsOf(full, "B"));
    expect(countsOf(m, "C")).toEqual(countsOf(full, "C"));
  });

  it("시즌이 바뀌면 이전 누적과 섞이지 않는다", async () => {
    const m = memoryStore();
    await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], true);
    await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, seasonStart: "2026-04-01T00:00:00+09:00", seasonEnd: "2026-07-01T00:00:00+09:00" }), ["--apply"], true);
    expect(countsOf(m, "A", "2026-01-08")).toEqual(EXPECTED.A);
    expect(countsOf(m, "A", "2026-04-01")).toEqual({});
  });

  it("제외된 Riot ID는 명단과 장인에서 빠지고 작업 행도 만들어지지 않는다", async () => {
    const m = memoryStore();
    m.excluded.add(riotIdHmac("Beta", "KR1", secret));
    await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], true);
    const names = (m.saved.ranking[0].rows as Array<{ riot_id: string }>).map(row => row.riot_id);
    expect(names).not.toContain("Beta#KR1");
    expect(countsOf(m, "B")).toEqual({});
  });

  it("커서가 바뀌었으면(stale) 그 계정은 건너뛰고 판수를 더하지 않는다", async () => {
    const m = memoryStore();
    const inner = m.store.commitProgress;
    let first = true;
    m.store.commitProgress = async input => {
      if (first && input.accountHmac === accountHmac(puuid.A, secret)) { first = false; return "stale"; }
      return inner(input);
    };
    const result = await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], true);
    expect(result.counts.staleSkipped).toBe(1);
    expect(countsOf(m, "A")).toEqual({});
  });

  it("누락 경기(잘못된 상세)는 건너뛰고 실행은 끝까지 간다", async () => {
    const m = memoryStore();
    const result = await runLolRankingSnapshot(deps({ riot: fakeRiot({ malformed: ["KR_0"] }), store: m.store }), ["--apply"], true);
    expect(result.counts.skippedMatches).toBeGreaterThan(0);
    expect(countsOf(m, "A")).toEqual({ 266: { games: 19, wins: 15 } });
  });

  it("명단 해석률이 95% 미만이면 명단은 바꾸지 않고 장인은 게시한다", async () => {
    const m = memoryStore();
    const result = await runLolRankingSnapshot(deps({ riot: fakeRiot({ failAccount: [puuid.C] }), store: m.store }), ["--apply"], true);
    expect(result.published.ranking).toBe(false);
    expect(result.reasons.join(" ")).toContain("Riot ID 해석률");
    expect(m.saved.ranking).toHaveLength(0);
    expect(result.published.master).toBe(true);
  });

  it("Riot 키 오류면 실행을 멈추고 명단을 게시하지 않는다", async () => {
    const m = memoryStore();
    await expect(runLolRankingSnapshot(deps({ riot: fakeRiot({ keyError: true }), store: m.store }), ["--apply"], true))
      .rejects.toBeInstanceOf(LolRankingKeyError);
    expect(m.saved.ranking).toHaveLength(0);
  });

  it("게시본에는 PUUID나 키가 들어가지 않는다", async () => {
    const m = memoryStore();
    await runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], true);
    const json = JSON.stringify([m.saved.ranking, m.saved.master]);
    expect(json).not.toMatch(/puuid|hmac|-aaaa|-bbbb|-cccc/);
  });
});

describe("장인 수집기: 설정 거절", () => {
  it("쓰기는 시즌 종료 시각이 있어야 한다", async () => {
    const m = memoryStore();
    await expect(runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, seasonEnd: undefined }), ["--apply"], true)).rejects.toThrow("LOL_SEASON_END");
  });

  it("시즌 시작 시각이 없으면 dry-run도 실패한다", async () => {
    const m = memoryStore();
    await expect(runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, seasonStart: undefined }), ["--dry-run"], false)).rejects.toThrow("LOL_SEASON_START");
  });

  it("쓰기에 제외 목록 키가 없으면 거절한다", async () => {
    const m = memoryStore();
    await expect(runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, secret: undefined }), ["--apply"], true)).rejects.toThrow("LOL_RANKING_HMAC_KEY");
  });

  it("쓰기 플래그가 없으면 --apply를 거절하고, 호출 상한은 1 이상이어야 한다", async () => {
    const m = memoryStore();
    await expect(runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store }), ["--apply"], false)).rejects.toThrow("LOL_RANKING_ENABLED");
    await expect(runLolRankingSnapshot(deps({ riot: fakeRiot(), store: m.store, maxCalls: 0 }), ["--dry-run"], false)).rejects.toThrow("LOL_RANKING_MAX_CALLS");
  });
});

// 커서 타입이 수집기 계약과 맞는지 확인한다.
const _cursorShape: SeasonCursor = { ms: 1, ids: [] };
void _cursorShape;

describe("삭제 요청 제외 CLI 경로", () => {
  it("dry-run은 저장하지 않고, apply는 Riot ID HMAC과 표시 이름만 넘긴다", async () => {
    const { runLolRankingExclude } = await import("../scripts/lol_ranking_exclude");
    const sent: Array<[string, string]> = [];
    const d = { secret, add: async (hmac: string, riotId: string) => { sent.push([hmac, riotId]); return 2; } };
    expect(await runLolRankingExclude(d, ["Alpha#KR1", "--dry-run"])).toEqual({ dryRun: true, removed: null });
    expect(sent).toHaveLength(0);
    expect(await runLolRankingExclude(d, ["Alpha#KR1", "--apply"])).toEqual({ dryRun: false, removed: 2 });
    expect(sent).toEqual([[riotIdHmac("Alpha", "KR1", secret), "Alpha#KR1"]]);
  });

  it("형식이 잘못되었거나 키가 없으면 거절한다", async () => {
    const { runLolRankingExclude } = await import("../scripts/lol_ranking_exclude");
    const add = async () => 0;
    await expect(runLolRankingExclude({ add, secret }, ["no-tag", "--dry-run"])).rejects.toThrow("게임이름#태그");
    await expect(runLolRankingExclude({ add, secret: undefined }, ["A#B", "--dry-run"])).rejects.toThrow("LOL_RANKING_HMAC_KEY");
  });
});
