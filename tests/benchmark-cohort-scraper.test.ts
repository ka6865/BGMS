import { describe, expect, it, vi } from "vitest";
import {
  COHORT_RETIRE_AFTER_DAYS,
  MATCH_API_INTERVAL_MS,
  PUBG_PLAYER_BATCH_SIZE,
  PUBG_RATE_LIMITED_INTERVAL_MS,
  rateLimitWaitMs,
  readLeaderboardEntries,
  mergeRankedEntries,
  runEliteScraper,
  selectCollectionTargets,
  type CohortMember,
  type EliteScraperConfig,
  type EliteScraperStore,
  type HttpResponse,
} from "../scripts/scrape_elite";
import { RESULT_VERSION, POPULATION_EVIDENCE_VERSION } from "../lib/pubg-analysis/constants";
import { BENCHMARK_FILTER_VERSION, BENCHMARK_POPULATION_EVIDENCE_VERSION } from "../lib/pubg-analysis/benchmarkLookup";
import type { PrivatePlayer } from "../lib/pubg/privatePlayers";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const config: EliteScraperConfig = {
  leaderboardDepth: 2,
  dailyLimit: 30,
  matchLimit: 1,
  matchApiHeaders: { Authorization: "Bearer scraper" },
  forceApiHeaders: { Authorization: "Bearer scraper", "X-BGMS-Admin-Token": "admin" },
};

function member(index: number, overrides: Partial<CohortMember> = {}): CohortMember {
  return {
    account_id: `account.m${index}`,
    nickname: `LeaderName${index}`,
    collected_player_ids: [],
    last_ranked_at: "2026-10-29T00:00:00.000Z",
    last_collected_at: null,
    retired_at: null,
    ...overrides,
  };
}

function httpError(status: number, headers: Record<string, unknown> = {}) {
  return Object.assign(new Error(`status ${status}`), { response: { status, headers, data: {} } });
}

function createHarness(options: {
  members?: CohortMember[];
  privatePlayers?: PrivatePlayer[];
  pubg?: (url: string) => HttpResponse | Error;
  match?: (url: string) => HttpResponse | Error;
  existing?: (matchId: string, playerId: string) => { fullResult: unknown; benchmark: unknown };
} = {}) {
  let clock = NOW;
  const members = options.members ?? [];
  const calls: { pubg: Array<{ url: string; at: number }>; match: Array<{ url: string; headers: Record<string, string> }> } = { pubg: [], match: [] };
  const store = {
    readPrivatePlayers: vi.fn(async () => options.privatePlayers ?? []),
    upsertRanked: vi.fn<EliteScraperStore["upsertRanked"]>(async () => undefined),
    retireStale: vi.fn<EliteScraperStore["retireStale"]>(async () => 0),
    removeMembers: vi.fn<EliteScraperStore["removeMembers"]>(async () => undefined),
    listActive: vi.fn(async (limit: number) => members.slice(0, limit)),
    markCollected: vi.fn<EliteScraperStore["markCollected"]>(async () => undefined),
    readExistingAnalysis: vi.fn(async (matchId: string, playerId: string) => options.existing?.(matchId, playerId) ?? { fullResult: null, benchmark: null }),
  } satisfies EliteScraperStore;
  const defaultPubg = (url: string): HttpResponse => {
    if (url.endsWith("/seasons")) return { status: 200, data: { data: [{ id: "season-1", attributes: { isCurrentSeason: true } }] } };
    if (url.includes("/leaderboards/")) return { status: 200, data: { included: [] } };
    const ids = decodeURIComponent(url.split("filter[playerIds]=")[1] ?? "").split(",");
    return {
      status: 200,
      data: {
        data: ids.map((id) => ({
          id,
          attributes: { name: `Current_${id.slice("account.".length)}` },
          relationships: { matches: { data: [{ id: `match-${id}` }, { id: "older" }] } },
        })),
      },
    };
  };
  const deps = {
    store,
    now: () => clock,
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    pubgGet: vi.fn(async (url: string) => {
      calls.pubg.push({ url, at: clock });
      const response = (options.pubg ?? defaultPubg)(url);
      if (response instanceof Error) throw response;
      return response;
    }),
    matchGet: vi.fn(async (url: string, headers: Record<string, string>) => {
      calls.match.push({ url, headers });
      const response = options.match?.(url) ?? { status: 200, data: {} };
      if (response instanceof Error) throw response;
      return response;
    }),
  };
  return { deps, store, calls, defaultPubg };
}

describe("벤치마커 명단 선택", () => {
  it("은퇴자·비공개 요청자를 빼고 가장 오래 수집하지 않은 순으로 고른다", () => {
    const members = [
      member(1, { last_collected_at: "2026-10-28T00:00:00.000Z" }),
      member(2, { last_collected_at: null, last_ranked_at: "2026-10-01T00:00:00.000Z" }),
      member(3, { last_collected_at: null, last_ranked_at: "2026-10-29T00:00:00.000Z" }),
      member(4, { last_collected_at: "2026-10-20T00:00:00.000Z" }),
      member(5, { retired_at: "2026-10-01T00:00:00.000Z" }),
      member(6, { last_collected_at: null }),
    ];
    const privatePlayers: PrivatePlayer[] = [{
      platform: "steam", nickname: "Whatever", lower_nickname: "whatever", account_id: "account.m6", created_at: "2026-01-01T00:00:00.000Z",
    }];
    expect(selectCollectionTargets(members, privatePlayers, 3).map((row) => row.account_id))
      .toEqual(["account.m3", "account.m2", "account.m4"]);
  });

  it("리더보드는 순위순 상위 인원만 읽고 여러 모드의 같은 계정은 최고 순위 하나로 합친다", () => {
    const payload = { included: [
      { type: "player", id: "account.b", attributes: { name: "B", rank: 2 } },
      { type: "player", id: "account.a", attributes: { name: "A", rank: 1 } },
      { type: "player", id: "account.c", attributes: { name: "C", rank: 3 } },
      { type: "player", id: "not-account", attributes: { name: "X", rank: 4 } },
    ] };
    const squad = readLeaderboardEntries(payload, "squad", 2);
    expect(squad.map((entry) => entry.accountId)).toEqual(["account.a", "account.b"]);
    const merged = mergeRankedEntries([...squad, { accountId: "account.b", nickname: "B", rank: 1, gameMode: "duo" }]);
    expect(merged.find((entry) => entry.accountId === "account.b")?.gameMode).toBe("duo");
  });

  it("Retry-After 초·날짜와 X-RateLimit-Reset을 대기 시간으로 바꾸고 60초로 제한한다", () => {
    expect(rateLimitWaitMs({ "Retry-After": "7" }, NOW)).toBe(7_000);
    expect(rateLimitWaitMs({ "retry-after": new Date(NOW + 3_000).toUTCString() }, NOW)).toBe(3_000);
    expect(rateLimitWaitMs({ "x-ratelimit-reset": String(NOW / 1_000 + 20) }, NOW)).toBe(20_000);
    expect(rateLimitWaitMs({ "retry-after": "600" }, NOW)).toBe(60_000);
    expect(rateLimitWaitMs(undefined, NOW)).toBe(60_000);
  });
});

describe("벤치마커 수집 실행", () => {
  it("30명을 10명씩 묶어 플레이어를 조회하고 PUBG 한도 호출만 6초 간격으로 보낸다", async () => {
    const members = Array.from({ length: 30 }, (_, index) => member(index));
    const { deps, calls, store } = createHarness({ members });
    const result = await runEliteScraper(deps, config);

    const playerCalls = calls.pubg.filter((call) => call.url.includes("/players?"));
    // 전: seasons 1 + leaderboards 6 + players 30 = 37회, 후: 1 + 6 + 3 = 10회
    expect(calls.pubg).toHaveLength(10);
    expect(playerCalls).toHaveLength(30 / PUBG_PLAYER_BATCH_SIZE);
    for (let index = 1; index < calls.pubg.length; index += 1) {
      expect(calls.pubg[index].at - calls.pubg[index - 1].at).toBeGreaterThanOrEqual(PUBG_RATE_LIMITED_INTERVAL_MS);
    }
    const matchSleeps = deps.sleep.mock.calls.filter(([ms]) => ms === MATCH_API_INTERVAL_MS);
    expect(matchSleeps).toHaveLength(29);
    expect(MATCH_API_INTERVAL_MS).toBeLessThanOrEqual(1_000);
    expect(result.counters).toEqual({ succeeded: 30, skipped: 0, failed: 0, rateLimited: 0 });
    const [cutoffIso, nowIso] = store.retireStale.mock.calls[0];
    expect(Date.parse(nowIso) - Date.parse(cutoffIso)).toBe(COHORT_RETIRE_AFTER_DAYS * 86_400_000);
  });

  it("리더보드 이름이 아니라 플레이어 응답의 현재 이름으로 분석하고 명단에 이름을 먼저 남긴다", async () => {
    const { deps, calls, store } = createHarness({ members: [member(1, { collected_player_ids: ["leadername1"] })] });
    await runEliteScraper(deps, config);
    expect(calls.match).toHaveLength(1);
    expect(calls.match[0].url).toContain("nickname=Current_m1");
    expect(calls.match[0].url).not.toContain("LeaderName1");
    expect(calls.match[0].url).toContain("source=scraper");
    expect(store.markCollected).toHaveBeenCalledWith("account.m1", expect.objectContaining({
      nickname: "Current_m1",
      collectedPlayerIds: ["leadername1", "current_m1"],
    }));
    expect(store.markCollected.mock.invocationCallOrder[0]).toBeLessThan(deps.matchGet.mock.invocationCallOrder[0]);
  });

  it("리더보드 429는 그 모드만 건너뛰고 Retry-After만큼 기다린 뒤 수집을 계속하며 은퇴 판정은 하지 않는다", async () => {
    let leaderboardCalls = 0;
    const harness = createHarness({
      members: [member(1)],
      pubg: (url) => {
        if (url.includes("/leaderboards/")) {
          leaderboardCalls += 1;
          if (leaderboardCalls === 1) return httpError(429, { "retry-after": "30" });
          return { status: 200, data: { included: [{ type: "player", id: "account.top", attributes: { name: "Top", rank: 1 } }] } };
        }
        return harness.defaultPubg(url);
      },
    });
    const result = await runEliteScraper(harness.deps, config);
    expect(leaderboardCalls).toBe(6);
    expect(harness.calls.pubg[2].at - harness.calls.pubg[1].at).toBeGreaterThanOrEqual(30_000);
    expect(harness.store.upsertRanked).toHaveBeenCalledWith([expect.objectContaining({ accountId: "account.top" })], "season-1", expect.any(String));
    expect(harness.store.retireStale).not.toHaveBeenCalled();
    expect(result.counters).toMatchObject({ succeeded: 1, failed: 1, rateLimited: 1 });
    expect(result.attentionRequired).toBe(true);
    expect(result.failures).toContainEqual({ stage: "leaderboard", status: 429, code: "UNKNOWN" });
  });

  it("season 실패나 플레이어 묶음 429에도 다른 묶음 수집을 계속한다", async () => {
    let playerCalls = 0;
    const harness = createHarness({
      members: Array.from({ length: 20 }, (_, index) => member(index)),
      pubg: (url) => {
        if (url.endsWith("/seasons")) return httpError(503);
        if (url.includes("/players?")) {
          playerCalls += 1;
          if (playerCalls === 1) return httpError(429);
        }
        return harness.defaultPubg(url);
      },
    });
    const result = await runEliteScraper(harness.deps, config);
    expect(harness.calls.pubg.some((call) => call.url.includes("/leaderboards/"))).toBe(false);
    expect(playerCalls).toBe(2);
    expect(harness.calls.match).toHaveLength(10);
    // season 1건 + 429로 건너뛴 10명
    expect(result.counters).toEqual({ succeeded: 10, skipped: 0, failed: 11, rateLimited: 1 });
    expect(harness.store.retireStale).not.toHaveBeenCalled();
  });

  it("경기 404·409는 skipped로만 세고 5xx는 failed로만 센다", async () => {
    const statuses = [404, 409, 500];
    let index = 0;
    const { deps } = createHarness({
      members: [member(1), member(2), member(3)],
      match: () => httpError(statuses[index++]),
    });
    const result = await runEliteScraper(deps, config);
    expect(result.counters).toEqual({ succeeded: 0, skipped: 2, failed: 1, rateLimited: 0 });
  });

  it("최신 캐시와 벤치마크가 모두 있으면 호출하지 않고, 벤치마크가 비면 관리자 토큰으로 강제 재분석한다", async () => {
    const trusted = { v: RESULT_VERSION, populationEvidenceVersion: POPULATION_EVIDENCE_VERSION };
    const benchmark = { filter_version: BENCHMARK_FILTER_VERSION, population_evidence_version: BENCHMARK_POPULATION_EVIDENCE_VERSION, match_type: "official" };
    const { deps, calls } = createHarness({
      members: [member(1), member(2)],
      existing: (matchId) => matchId === "match-account.m1"
        ? { fullResult: trusted, benchmark }
        : { fullResult: trusted, benchmark: null },
    });
    const result = await runEliteScraper(deps, config);
    expect(calls.match).toHaveLength(1);
    expect(calls.match[0].url).toContain("force=true");
    expect(calls.match[0].headers["X-BGMS-Admin-Token"]).toBe("admin");
    expect(result.counters).toMatchObject({ succeeded: 1, skipped: 1 });
  });

  it("비공개 요청자는 리더보드에서 명단에 올리지 않고 현재 이름으로 확인돼도 수집하지 않는다", async () => {
    const privatePlayers: PrivatePlayer[] = [
      { platform: "steam", nickname: "Hidden", lower_nickname: "hidden", account_id: "account.hidden", created_at: "2026-01-01T00:00:00.000Z" },
      { platform: "steam", nickname: "Current_m2", lower_nickname: "current_m2", created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const harness = createHarness({
      members: [member(1), member(2)],
      privatePlayers,
      pubg: (url) => url.includes("/leaderboards/")
        ? { status: 200, data: { included: [
          { type: "player", id: "account.hidden", attributes: { name: "Renamed", rank: 1 } },
          { type: "player", id: "account.open", attributes: { name: "Open", rank: 2 } },
        ] } }
        : harness.defaultPubg(url),
    });
    const result = await runEliteScraper(harness.deps, config);
    expect(harness.store.upsertRanked).toHaveBeenCalledWith([expect.objectContaining({ accountId: "account.open" })], "season-1", expect.any(String));
    expect(harness.store.removeMembers).toHaveBeenCalledWith(["account.hidden"]);
    expect(harness.store.removeMembers).toHaveBeenCalledWith(["account.m2"]);
    expect(harness.calls.match.map((call) => call.url).join()).not.toContain("Current_m2");
    expect(result.privateExcluded).toBe(2);
  });

  it("비공개 목록을 읽지 못하면 PUBG 호출 없이 실패로 끝낸다", async () => {
    const { deps, store } = createHarness({ members: [member(1)] });
    store.readPrivatePlayers.mockRejectedValueOnce(new Error("settings down"));
    const result = await runEliteScraper(deps, config);
    expect(deps.pubgGet).not.toHaveBeenCalled();
    expect(result.counters.failed).toBe(1);
    expect(result.attentionRequired).toBe(true);
  });
});
