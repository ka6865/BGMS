import { describe, expect, it } from "vitest";
import { runLolRankingSnapshot, type RankingDependencies } from "../scripts/lol_ranking_snapshot";
import { riotIdHmac } from "@/lib/lol/ranking";

const secret = "s".repeat(40);
const puuid = (n: number) => `puuid-${n}-${"b".repeat(20)}`;
const challenger = { queue: "RANKED_SOLO_5x5", tier: "CHALLENGER", entries: [
  { puuid: puuid(1), leaguePoints: 1200, wins: 10, losses: 5, inactive: false, rank: "I" },
  { puuid: puuid(2), leaguePoints: 1100, wins: 9, losses: 6, inactive: false, rank: "I" },
] };
const grandmaster = { queue: "RANKED_SOLO_5x5", tier: "GRANDMASTER", entries: [
  { puuid: puuid(3), leaguePoints: 500, wins: 3, losses: 2, inactive: false, rank: "I" },
] };
const names: Record<string, { gameName: string; tagLine: string }> = {
  [puuid(1)]: { gameName: "Alpha", tagLine: "KR1" },
  [puuid(2)]: { gameName: "Bravo", tagLine: "KR2" },
  [puuid(3)]: { gameName: "Charlie", tagLine: "KR3" },
};
const masteryRow = (championId: number, championPoints: number) => ({ championId, championPoints, championLevel: 7, puuid: "x", tokensEarned: 0 });

type Setup = { failAccount?: string[]; congestedOnce?: string[]; excluded?: string[]; mastery?: Record<string, unknown> };

function makeDeps(setup: Setup = {}) {
  const calls: Array<{ host: string; path: string }> = [];
  const saved: unknown[] = [];
  const congestedSeen = new Set<string>();
  const deps: RankingDependencies = {
    request: async (host, path) => {
      calls.push({ host, path });
      if (path.includes("/lol/league/v4/challengerleagues")) return challenger;
      if (path.includes("/lol/league/v4/grandmasterleagues")) return grandmaster;
      const id = decodeURIComponent(path.split("/").find(part => part.startsWith("puuid-")) ?? "");
      if (path.includes("/riot/account/v1/")) {
        if (setup.failAccount?.includes(id)) throw Object.assign(new Error("not_found"), { kind: "not_found" });
        if (setup.congestedOnce?.includes(id) && !congestedSeen.has(id)) {
          congestedSeen.add(id);
          throw Object.assign(new Error("congested"), { kind: "congested" });
        }
        return { puuid: id, ...names[id] };
      }
      if (path.includes("/champion-masteries/")) {
        return setup.mastery?.[id] ?? [masteryRow(266, 500000), masteryRow(1, 100)];
      }
      throw new Error(`unexpected ${path}`);
    },
    save: async input => { saved.push(input); },
    excludedKeys: async () => setup.excluded ?? [],
    hmacSecret: secret,
    sleep: async () => {},
    now: () => new Date("2026-10-30T20:00:00Z"),
  };
  return { deps, calls, saved };
}

describe("랭킹·장인 수집기", () => {
  it("dry-run은 명단 2회와 호출만 하고 저장하지 않는다", async () => {
    const { deps, calls, saved } = makeDeps();
    const result = await runLolRankingSnapshot(deps, ["--dry-run"], false);
    expect(result.dryRun).toBe(true);
    expect(result.published).toBe(false);
    expect(saved).toHaveLength(0);
    expect(calls.filter(call => call.path.includes("/league/v4/"))).toHaveLength(2);
    expect(result.counts).toMatchObject({ candidates: 3, resolved: 3, unresolved: 0, masteryCompleted: 3, rows: 3 });
  });

  it("결과에 PUUID가 들어가지 않는다", async () => {
    const { deps } = makeDeps();
    const result = await runLolRankingSnapshot(deps, ["--dry-run"], false);
    expect(JSON.stringify(result)).not.toMatch(/puuid-/);
  });

  it("apply는 게시 조건을 넘으면 한 번만 저장하고 PUUID 없는 행을 넘긴다", async () => {
    const { deps, saved } = makeDeps();
    const result = await runLolRankingSnapshot(deps, ["--apply"], true);
    expect(result.published).toBe(true);
    expect(saved).toHaveLength(1);
    const payload = JSON.stringify(saved[0]);
    expect(payload).not.toContain("puuid");
    expect(payload).toContain("Alpha#KR1");
    expect((saved[0] as { playerCount: number }).playerCount).toBe(3);
  });

  it("Riot ID 해석률이 95% 미만이면 저장하지 않는다(부분 실패)", async () => {
    const { deps, saved } = makeDeps({ failAccount: [puuid(2)] });
    const result = await runLolRankingSnapshot(deps, ["--apply"], true);
    expect(result.published).toBe(false);
    expect(result.reasons.join(" ")).toContain("Riot ID 해석률");
    expect(saved).toHaveLength(0);
  });

  it("숙련도 응답이 잘못되면 그 계정만 장인에서 빠지고 완료율 기준으로 게시를 막는다", async () => {
    const bad = { [puuid(1)]: [{ championId: 1, championLevel: 1 }] };
    const { deps, saved } = makeDeps({ mastery: bad });
    const result = await runLolRankingSnapshot(deps, ["--apply"], true);
    expect(result.counts.masteryCompleted).toBe(2);
    expect(result.published).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("혼잡 응답은 짧게 기다렸다가 다시 보내 해석에 성공한다", async () => {
    const waits: number[] = [];
    const { deps } = makeDeps({ congestedOnce: [puuid(3)] });
    deps.sleep = async ms => { waits.push(ms); };
    const result = await runLolRankingSnapshot(deps, ["--dry-run"], false);
    expect(waits).toEqual([1000]);
    expect(result.counts.resolved).toBe(3);
  });

  it("제외 목록의 계정은 게시 행과 장인 항목에서 모두 빠진다", async () => {
    const excludedKey = riotIdHmac("Bravo", "KR2", secret);
    const { deps, saved } = makeDeps({ excluded: [excludedKey] });
    const result = await runLolRankingSnapshot(deps, ["--apply"], true);
    expect(result.counts.excluded).toBe(1);
    expect(result.published).toBe(true);
    expect(JSON.stringify(saved[0])).not.toContain("Bravo#KR2");
    expect((saved[0] as { playerCount: number }).playerCount).toBe(2);
  });

  it("쓰기 플래그가 없으면 --apply를 거절한다", async () => {
    const { deps } = makeDeps();
    await expect(runLolRankingSnapshot(deps, ["--apply"], false)).rejects.toThrow("LOL_RANKING_ENABLED");
  });

  it("쓰기에 제외 목록 키가 없으면 거절한다", async () => {
    const { deps } = makeDeps();
    deps.hmacSecret = undefined;
    await expect(runLolRankingSnapshot(deps, ["--apply"], true)).rejects.toThrow("LOL_RANKING_HMAC_KEY");
  });

  it("명단 응답이 잘못되면 실패하고 저장하지 않는다", async () => {
    const { deps, saved } = makeDeps();
    deps.request = async (_host, path) => path.includes("challenger") ? { queue: "RANKED_SOLO_5x5", tier: "CHALLENGER", entries: [{ leaguePoints: 1 }] } : grandmaster;
    await expect(runLolRankingSnapshot(deps, ["--apply"], true)).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });
});

describe("제외 등록 CLI 경로", () => {
  it("dry-run은 저장하지 않고, apply는 Riot ID HMAC만 넘긴다", async () => {
    const { runLolRankingExclude } = await import("../scripts/lol_ranking_exclude");
    const sent: string[] = [];
    const deps = { secret, add: async (hmac: string) => { sent.push(hmac); return 2; } };
    expect(await runLolRankingExclude(deps, ["Alpha#KR1", "--dry-run"])).toEqual({ dryRun: true, removed: null });
    expect(sent).toHaveLength(0);
    expect(await runLolRankingExclude(deps, ["Alpha#KR1", "--apply"])).toEqual({ dryRun: false, removed: 2 });
    expect(sent).toEqual([riotIdHmac("Alpha", "KR1", secret)]);
    expect(sent[0]).not.toContain("Alpha");
  });

  it("형식이 잘못되었거나 키가 없으면 거절한다", async () => {
    const { runLolRankingExclude } = await import("../scripts/lol_ranking_exclude");
    const add = async () => 0;
    await expect(runLolRankingExclude({ add, secret }, ["no-tag", "--dry-run"])).rejects.toThrow("게임이름#태그");
    await expect(runLolRankingExclude({ add, secret: undefined }, ["A#B", "--dry-run"])).rejects.toThrow("LOL_RANKING_HMAC_KEY");
  });
});
