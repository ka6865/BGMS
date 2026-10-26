const dragon = vi.hoisted(() => ({ version: "16.21.1" }));
vi.mock("@/lib/lol/dataDragon.server", () => ({ getLolDataDragonVersion: async () => dragon.version }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ops = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/lol/ops.server", () => ({ recordLolOpsMetric: ops.record }));

const access = vi.hoisted(() => ({ requireLolDevAdmin: vi.fn() }));
const persistence = vi.hoisted(() => ({
  enabled: vi.fn(),
  storedMatch: vi.fn(),
  cache: vi.fn(),
  account: vi.fn(),
  names: vi.fn(),
  matchRequestJson: vi.fn(),
  acquire: vi.fn(),
  saveSearch: vi.fn(),
  history: vi.fn(),
  summaries: vi.fn(),
  catalogRead: vi.fn(),
  catalogWrite: vi.fn(),
  saveMatch: vi.fn(),
  reserve: vi.fn(),
  start: vi.fn(),
  releaseRequest: vi.fn(),
  recordHeaders: vi.fn(),
  block: vi.fn(),
  releaseLease: vi.fn(),
}));
vi.mock("@/lib/lol/access.server", () => ({
  requireLolDevAdmin: access.requireLolDevAdmin,
}));
vi.mock("@/lib/lol/persistence.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/lol/persistence.server")>();
  return {
    ...actual,
    isLolPersistenceEnabled: persistence.enabled,
    hasLolStoredMatch: persistence.storedMatch,
    getLolApiCache: persistence.cache,
    getLolAccountByRiotId: persistence.account,
    getLolAccountNamesByPuuids: persistence.names,
    getLolMatchRequestJson: persistence.matchRequestJson,
    acquireLolCollectionLease: persistence.acquire,
    persistLolSearchSnapshot: persistence.saveSearch,
    getLolRankedHistory: persistence.history,
    getLolPlayerMatchSummaries: persistence.summaries,
    getLolChallengeCatalogCache: persistence.catalogRead,
    putLolChallengeCatalogCache: persistence.catalogWrite,
    persistLolMatchDetails: persistence.saveMatch,
    reserveLolRiotRequest: persistence.reserve,
    startLolRiotRequest: persistence.start,
    releaseLolRiotRequest: persistence.releaseRequest,
    recordLolRiotRateHeaders: persistence.recordHeaders,
    blockLolRiotRequests: persistence.block,
    releaseLolCollectionLease: persistence.releaseLease,
  };
});
vi.mock("server-only", () => ({}));

import { POST } from "@/app/api/admin/lol/search/route";
import { POST as moreMatches } from "@/app/api/admin/lol/matches/more/route";
import { GET as getMatch } from "@/app/api/admin/lol/matches/[matchId]/route";
import {
  lolSearchCacheKey,
  emptyLolRankedHistory,
  LolPersistenceError,
  LolLeaseExpiredError,
} from "@/lib/lol/persistence.server";
import { requestJson, getLolMatchDetails, getMoreLolMatches, searchLolRiotId, resolveLolParticipantRef, resolveLolAccountForDeletion } from "@/lib/lol/riotSearch.server";
import { sealLolParticipantRef } from "@/lib/lol/participantIdentity.server";
import { summarizeRecentMatches } from "@/lib/lol/summary";
import { buildLolChallengeProfile, parseLolChallengeCatalog } from "@/lib/lol/challengeProfile";
import { challengeConfigFixture, challengePercentilesFixture, challengePlayerFixture } from "./fixtures/lol/challengeProfile";

const STATE_KEY = Symbol.for("bgms.lol.riot-search-state");
const internalState = (
  globalThis as typeof globalThis & {
    [STATE_KEY]?: {
      cache: Map<string, unknown>;
      inflight: Map<string, unknown>;
      queue: Promise<void>;
      nextRequestAt: number;
      blockedUntil: number;
      activeSearches: number;
      accounts: Map<string, unknown>;
      accountOps: Set<string>;
    };
  }
)[STATE_KEY];

function response(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function post(riotId: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/admin/lol/search", {
    method: "POST",
    headers: {
      Host: "localhost",
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ riotId }),
  });
}

function postMore(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/admin/lol/matches/more", {
    method: "POST",
    headers: { Host: "localhost", Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dragon.version = "16.21.1";
  vi.useFakeTimers();
  ops.record.mockClear();
  access.requireLolDevAdmin.mockClear();
  access.requireLolDevAdmin.mockResolvedValue({ ok: true });
  for (const mock of Object.values(persistence)) mock.mockClear();
  persistence.enabled.mockReturnValue(false);
  persistence.storedMatch.mockResolvedValue(false);
  persistence.cache.mockResolvedValue(undefined);
  persistence.account.mockResolvedValue(undefined);
  persistence.names.mockResolvedValue([]);
  persistence.matchRequestJson.mockResolvedValue(undefined);
  persistence.acquire.mockResolvedValue({ key: "lease", token: "lease-token" });
  persistence.saveSearch.mockResolvedValue(undefined);
  persistence.history.mockResolvedValue(emptyLolRankedHistory());
  persistence.summaries.mockResolvedValue([]);
  persistence.catalogRead.mockResolvedValue(undefined);
  persistence.catalogWrite.mockResolvedValue(undefined);
  persistence.saveMatch.mockResolvedValue(undefined);
  persistence.reserve.mockResolvedValue({
    token: "request-token",
    permitAt: Date.now(),
  });
  persistence.start.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  persistence.releaseRequest.mockResolvedValue(undefined);
  persistence.recordHeaders.mockResolvedValue(undefined);
  persistence.block.mockResolvedValue(undefined);
  persistence.releaseLease.mockResolvedValue(undefined);
  vi.stubEnv("RIOT_API_KEY", "test-key-never-real");
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
  vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "fixed-test-participant-secret");
  internalState?.cache.clear();
  internalState?.inflight.clear();
  internalState?.accounts.clear();
  internalState?.accountOps.clear();
  if (internalState) {
    internalState.queue = Promise.resolve();
    internalState.nextRequestAt = 0;
    internalState.blockedUntil = 0;
    internalState.activeSearches = 0;
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/admin/lol/search", () => {
  it("search DTO 키는 v11로 구분한다", () => {
    expect(lolSearchCacheKey("Name", "KR1", "kr", "asia", "16.21.1")).toContain(
      "search:v11:",
    );
  });

  it("관리자 가드가 거부하면 Riot 호출 없이 종료한다", async () => {
    access.requireLolDevAdmin.mockResolvedValue({
      ok: false,
      error: Response.json({}, { status: 401 }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await POST(post("Name#KR1"));
    expect(result.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("잘못된 Riot ID는 외부 요청 전에 거부한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await POST(post("missing-tag"));
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("교차 출처와 제어 문자가 있는 Riot ID는 Riot 호출 전에 거부한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await POST(post("Valid#KR1", "https://evil.example"))).status).toBe(
      403,
    );
    expect((await POST(post("Bad\u0001#KR1"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Origin 누락", undefined, "127.0.0.1:59405", undefined],
    ["Origin null", "null", "127.0.0.1:59405", undefined],
    ["다른 출처", "http://evil.example", "127.0.0.1:59405", undefined],
    ["다른 포트", "http://127.0.0.1:3000", "127.0.0.1:59405", undefined],
    ["다른 protocol", "https://127.0.0.1:59405", "127.0.0.1:59405", undefined],
    [
      "위조 forwarded host",
      "http://127.0.0.1:59405",
      "evil.example",
      "127.0.0.1:59405",
    ],
  ])(
    "%s는 Host와 Origin 불일치로 거부한다",
    async (_caseName, origin, host, forwardedHost) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const headers = new Headers({
        Host: host,
        "Content-Type": "application/json",
      });
      if (origin !== undefined) headers.set("Origin", origin);
      if (forwardedHost) headers.set("X-Forwarded-Host", forwardedHost);
      const request = new Request("http://localhost/api/admin/lol/search", {
        method: "POST",
        headers,
        body: JSON.stringify({ riotId: "malformed" }),
      });
      expect((await POST(request)).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("Next 내부 URL host가 달라도 요청 Host와 Origin이 일치하면 출처를 통과한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://localhost/api/admin/lol/search", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:59405",
        Origin: "http://127.0.0.1:59405",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ riotId: "malformed" }),
    });
    const result = await POST(request);
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("본문 상한을 초과하면 API 호출 없이 종료한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://localhost/api/admin/lol/search", {
      method: "POST",
      headers: {
        Host: "localhost",
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ riotId: "Ok#KR1", padding: "x".repeat(3000) }),
    });
    expect((await POST(request)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("검색·랭크·최근 경기 요약을 만들고 경기 실패는 부분 오류로 보존한다", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, headers: new Headers(init?.headers) });
        expect(init?.redirect).toBe("error");
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "private-puuid",
            gameName: "Test",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 12, summonerLevel: 42 });
        if (url.includes("league/v4"))
          return response([
            {
              puuid: "private-puuid",
              leagueId: "private-league",
              queueType: "RANKED_SOLO_5x5",
              tier: "GOLD",
              rank: "II",
              leaguePoints: 30,
              wins: 10,
              losses: 8,
            },
          ]);
        if (url.includes("/ids?")) return response(["KR_1", "KR_2", "KR_3"]);
        if (url.endsWith("/KR_1"))
          return response({
            metadata: { matchId: "KR_1" },
            info: {
              queueId: 420,
              gameMode: "CLASSIC",
              gameEndTimestamp: 1_700_000_000_000,
              gameDuration: 1800,
              participants: [
                {
                  puuid: "private-puuid",
                  win: true,
                  championName: "Ahri",
                  kills: 5,
                  deaths: 2,
                  assists: 9,
                  totalMinionsKilled: 150,
                  neutralMinionsKilled: 10,
                },
              ],
            },
          });
        return response({}, 503);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.account).toEqual({ gameName: "Test", tagLine: "KR1" });
    expect(result.profile.summonerLevel).toBe(42);
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]).toEqual({
      queueType: "RANKED_SOLO_5x5",
      tier: "GOLD",
      rank: "II",
      leaguePoints: 30,
      wins: 10,
      losses: 8,
    });
    expect(JSON.stringify(result)).not.toContain("private-puuid");
    expect(JSON.stringify(result)).not.toContain("private-league");
    expect(result.matches).toMatchObject([
      {
        win: true,
        championName: "Ahri",
        kills: 5,
        deaths: 2,
        assists: 9,
        cs: 160,
      },
    ]);
    expect(result.matchStatus).toBe("partial");
    expect(result.matchFailures).toHaveLength(2);
    expect(result.matchIds).toHaveLength(3);
    expect(result.loadedCount).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.summaries).toEqual(summarizeRecentMatches(result.matches, "Test#KR1"));
    expect(result.summaries.all).toMatchObject({
      sampleSize: 1,
      validSampleSize: 1,
      excludedCount: 0,
    });
    const riotCalls = calls.filter((call) =>
      call.url.includes("api.riotgames.com"),
    );
    expect(riotCalls).toHaveLength(9);
    expect(riotCalls.find((call) => call.url.includes("/ids?"))?.url).toContain("count=20");
    expect(
      riotCalls.filter((call) => /\/matches\/KR_\d+$/.test(call.url)),
    ).toHaveLength(3);
    expect(riotCalls.some((call) => call.url.endsWith("/KR_3"))).toBe(true);
    expect(
      riotCalls.every(
        (call) => call.headers.get("X-Riot-Token") === "test-key-never-real",
      ),
    ).toBe(true);
    expect(
      riotCalls.every((call) => !call.url.includes("test-key-never-real")),
    ).toBe(true);
  });

  it("첫 검색은 20개 경기 ID를 받고 상세도 한 페이지 20개를 처리한다", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `KR_${index + 1}`);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("accounts/by-riot-id")) return response({ puuid: "p", gameName: "Test", tagLine: "KR1" });
      if (url.includes("summoner/v4")) return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response(ids);
      if (/\/matches\/KR_/.test(url)) return response({}, 503);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const pending = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;
    expect(result.matchIds).toHaveLength(20);
    expect(result.loadedCount).toBe(20);
    expect(result.hasMore).toBe(true);
    expect(result.matchFailures).toHaveLength(20);
    expect(calls.find((url) => url.includes("/ids?"))).toContain("count=20");
    expect(calls.filter((url) => /\/matches\/KR_/.test(url))).toHaveLength(20);
  });

  it("검색 캐시는 같은 Riot ID의 반복 호출을 합친다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("accounts/by-riot-id"))
        return response({ puuid: "p", gameName: "Test", tagLine: "KR1" });
      if (url.includes("summoner/v4"))
        return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      return response([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(0);
    expect(internalState?.inflight.has("search:v11:test#kr1")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    expect(internalState?.cache.has("search:v11:test#kr1")).toBe(true);
    expect((await searchLolRiotId("Test#KR1")).rankedHistory).toEqual(emptyLolRankedHistory());
    expect(persistence.history).not.toHaveBeenCalled();
    const count = fetchMock.mock.calls.length;
    await searchLolRiotId("Test#KR1");
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("영속 캐시 hit은 기존 DTO를 반환하고 Riot 호출은 하지 않는다", async () => {
    const summaries = Object.fromEntries(
      (
        [
          ["all", 0],
          ["solo", 0],
          ["flex", 0],
          ["aram", 0],
        ] as const
      ).map(([queue]) => [
        queue,
        {
          queue,
          sampleSize: 0,
          validSampleSize: 0,
          excludedCount: 0,
          winRatePct: null,
          averageKda: null,
          perfect: false,
          perfectCount: 0,
          champions: [],
        },
      ]),
    );
    const dto = {
      account: { gameName: "Test", tagLine: "KR1" },
      profile: { profileIconId: 1, summonerLevel: 2 },
      ranked: [],
      matches: [],
      matchIds: [],
      loadedCount: 0,
      hasMore: false,
      matchFailures: [],
      lastUpdatedAt: new Date().toISOString(),
      refreshRemainSeconds: 120,
      summaries,
      matchStatus: "empty" as const,
    };
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(dto);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchLolRiotId("Test#KR1")).resolves.toMatchObject({ ...dto, refreshRemainSeconds: expect.any(Number) });
    expect(persistence.cache).toHaveBeenCalledWith(
      "search",
      expect.stringContaining("kr:asia:16.21.1"),
      "kr",
      "asia",
      "16.21.1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.acquire).not.toHaveBeenCalled();
  });

  it("프로세스 메모리에 의존하지 않고 영속 경기 상세 cache hit을 반환한다", async () => {
    const dto = {
      matchId: "KR_55",
      queueId: 420,
      gameMode: "CLASSIC",
      gameDuration: 1800,
      teams: [],
    };
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(dto);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await getMatch(
      new Request("http://localhost/api/admin/lol/matches/KR_55"),
      { params: Promise.resolve({ matchId: "KR_55" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...dto, dataDragonVersion: "16.21.1" });
    expect(persistence.cache).toHaveBeenCalledWith(
      "match_details",
      "match:v1:kr:asia:16.21.1:v6:KR_55",
      "kr",
      "asia",
      "16.21.1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.acquire).not.toHaveBeenCalled();
  });

  it("영속 DB miss/read 실패는 503으로 닫고 Riot을 호출하지 않는다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockRejectedValue(new LolPersistenceError());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await POST(post("Test#KR1"));
    expect(result.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DB 호출 permit을 얻지 못하면 외부 Riot 요청 전에 503으로 닫는다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    persistence.reserve.mockRejectedValue(new LolPersistenceError());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await POST(post("PermitFail#KR1"));
    expect(result.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("BGMS 요청 guard는 Riot 429와 구분해 busy로 응답한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    persistence.reserve.mockResolvedValue({ token: "request-token", permitAt: Date.now() + 5_000 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await POST(post("Guard#KR1"));
    expect(result.status).toBe(503);
    expect(result.headers.get("Retry-After")).toBe("5");
    expect(await result.json()).toEqual({ error: "요청이 많아 잠시 후 다시 시도해 주세요." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("영속 cache miss는 중앙 permit을 통해 조회하고 DTO와 전적을 함께 저장한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    const history = emptyLolRankedHistory();
    const point = { tier: "GOLD", rank: "I", lp: 80, recordedAt: "2026-10-23T01:00:00Z" };
    history.RANKED_SOLO_5x5 = { points: [{ ...point, date: "2026-10-23", wins: 10, losses: 8, isBaseline: false }], highest: point, trackingSince: point.recordedAt };
    persistence.history.mockResolvedValue(history);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "fixture-puuid",
            gameName: "Saved",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 12, summonerLevel: 42 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response([]);
        return response({ data: {} });
      }),
    );
    const result = await searchLolRiotId("Saved#KR1");
    expect(result).toMatchObject({
      account: { gameName: "Saved", tagLine: "KR1" },
      ranked: [],
      matches: [],
      matchStatus: "empty",
    });
    expect(
      calls.filter((url) => url.includes("api.riotgames.com")),
    ).toHaveLength(6);
    expect(result.rankedHistory).toEqual(history);
    expect(persistence.history).toHaveBeenCalledWith("fixture-puuid");
    expect(persistence.saveSearch.mock.invocationCallOrder[0]).toBeLessThan(persistence.history.mock.invocationCallOrder[0]);
    expect(JSON.stringify(result)).not.toContain("puuid");
    expect(persistence.reserve).toHaveBeenCalledTimes(6);
    expect(persistence.recordHeaders).toHaveBeenCalledTimes(6);
    expect(persistence.saveSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: expect.stringContaining("search:v11:kr:asia:16.21.1"),
        account: expect.objectContaining({ puuid: "fixture-puuid" }),
        ranked: [],
        matches: [],
        cachePayload: { ...result, mastery: expect.objectContaining({ status: result.mastery?.status }) },
      }),
    );
  });

  it("검색 cache 만료 뒤 최신 Riot ID·랭크·경기목록은 조회하고 저장된 경기 원문은 재사용한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    const rawMatch = {
      metadata: { matchId: "KR_8801", dataVersion: "2" },
      info: {
        queueId: 420,
        gameMode: "CLASSIC",
        gameDuration: 1800,
        gameEndTimestamp: 1_700_001_800_000,
        participants: [
          {
            puuid: "fixture-puuid",
            participantId: 1,
            teamId: 100,
            championId: 103,
            championName: "Ahri",
            win: true,
            kills: 5,
            deaths: 2,
            assists: 9,
            totalMinionsKilled: 150,
            neutralMinionsKilled: 10,
          },
        ],
      },
    };
    persistence.matchRequestJson.mockResolvedValue(rawMatch);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "fixture-puuid",
            gameName: "Saved",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 12, summonerLevel: 42 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(["KR_8801"]);
        if (url.endsWith("/champion.json"))
          return response({ data: { Ahri: { name: "아리", key: "103" } } });
        if (url.endsWith("/item.json"))
          return response({ data: { "1056": { name: "도란의 반지" } } });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await searchLolRiotId("Saved#KR1");
    expect(result.matches).toMatchObject([
      { matchId: "KR_8801", kills: 5, cs: 160, championNameKo: "아리" },
    ]);
    expect(
      urls.filter((url) => url.includes("api.riotgames.com")),
    ).toHaveLength(6);
    expect(urls.some((url) => url.endsWith("/KR_8801"))).toBe(false);
    expect(persistence.matchRequestJson).toHaveBeenCalledWith(
      "KR_8801",
      "kr",
      "asia",
    );
    expect(persistence.saveSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        matches: [
          expect.objectContaining({
            summary: expect.objectContaining({ matchId: "KR_8801" }),
            raw: rawMatch,
          }),
        ],
      }),
    );
  });

  it("검색 중 immutable 경기 원문의 DB 오류는 partial 결과로 삼키지 않고 503으로 전달한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    persistence.matchRequestJson.mockRejectedValue(new LolPersistenceError());
    const riotCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("api.riotgames.com")) riotCalls.push(url);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "fixture-puuid",
            gameName: "Saved",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 12, summonerLevel: 42 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(["KR_8801"]);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await POST(post("Saved#KR1"));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "LoL 저장소를 사용할 수 없습니다.",
    });
    expect(riotCalls).toHaveLength(4);
    expect(persistence.saveSearch).not.toHaveBeenCalled();
  });

  it("헤더 제한상태 저장 실패 뒤에는 다음 Riot endpoint를 호출하지 않는다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    persistence.recordHeaders.mockRejectedValue(new LolPersistenceError());
    const riotCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("api.riotgames.com")) riotCalls.push(url);
        return response({
          puuid: "fixture-puuid",
          gameName: "Stops",
          tagLine: "KR1",
        });
      }),
    );
    await expect(searchLolRiotId("Stops#KR1")).rejects.toMatchObject({
      kind: "persistence",
    });
    expect(riotCalls).toHaveLength(1);
  });

  it("1.5초 간격을 지키고 2분 뒤에도 경기 상세 10분 캐시를 재사용한다", async () => {
    const requestTimes: number[] = [];
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.riotgames.com")) requestTimes.push(Date.now());
      urls.push(url);
      if (url.includes("accounts/by-riot-id"))
        return response({
          puuid: "private-puuid",
          gameName: "Test",
          tagLine: "KR1",
        });
      if (url.includes("summoner/v4"))
        return response({ profileIconId: 12, summonerLevel: 42 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response(["KR_1"]);
      return response({
        metadata: { matchId: "KR_1" },
        info: {
          queueId: 420,
          gameMode: "CLASSIC",
          gameEndTimestamp: 1_700_000_000_000,
          gameDuration: 1800,
          participants: [
            {
              puuid: "private-puuid",
              win: true,
              championName: "Ahri",
              kills: 1,
              deaths: 2,
              assists: 3,
              totalMinionsKilled: 100,
              neutralMinionsKilled: 2,
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await first;
    expect(JSON.stringify(result)).not.toContain("private-puuid");
    expect(
      requestTimes
        .slice(1)
        .every((time, index) => time - requestTimes[index] >= 1_500),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(120_001);
    const second = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await second;
    expect(urls.filter((url) => url.endsWith("/KR_1"))).toHaveLength(1);
    expect(
      urls.filter((url) => url.includes("api.riotgames.com")),
    ).toHaveLength(13);
  });

  it.each([
    { upstream: 401, status: 503, metric: "riot_key_error", message: "Riot API 키를 갱신하는 중입니다. 잠시 후 다시 시도해 주세요." },
    { upstream: 403, status: 503, metric: "riot_key_error", message: "Riot API 키를 갱신하는 중입니다. 잠시 후 다시 시도해 주세요." },
    { upstream: 429, status: 429, metric: "riot_429", message: "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요." },
    { upstream: 500, status: 502, metric: "riot_5xx", message: "Riot API에 일시적인 문제가 있습니다." },
    { upstream: 503, status: 502, metric: "riot_5xx", message: "Riot API에 일시적인 문제가 있습니다." },
  ])("Riot $upstream의 HTTP·안내·로그·메트릭을 구분한다", async ({ upstream, status, metric, message }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => response({}, upstream, { "Retry-After": "30" })));
    const result = await POST(post("Ops#KR1"));
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error: message, ...(upstream === 401 || upstream === 403
      ? { reasonCode: "riot_key_renewal", detail: "Riot API key is being renewed" } : {}) });
    expect(ops.record).toHaveBeenCalledExactlyOnceWith(metric);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[1]))).toMatchObject({ endpoint: "account", stage: "http", status: upstream });
    if (upstream === 429) expect(result.headers.get("Retry-After")).toBe("30");
  });

  it.each([
    { name: "TimeoutError", status: 504, metric: "riot_timeout", message: "Riot API 응답 시간이 초과되었습니다." },
    { name: "TypeError", status: 502, metric: "riot_network", message: "Riot API에 일시적인 문제가 있습니다." },
  ])("Riot $name의 HTTP·안내·로그·메트릭을 구분한다", async ({ name, status, metric, message }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("private-network-key"), { name }); }));
    const result = await POST(post("Ops#KR1"));
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error: message });
    expect(ops.record).toHaveBeenCalledExactlyOnceWith(metric);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[1]))).toMatchObject({ endpoint: "account", stage: "fetch" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-network-key");
  });

  it("429 Retry-After 차단을 유지하고 403을 키 또는 권한 오류로 구분한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 429, { "Retry-After": "30" })),
    );
    await expect(searchLolRiotId("Rate#KR1")).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 30,
    });
    const count = vi.mocked(fetch).mock.calls.length;
    await expect(searchLolRiotId("Other#KR1")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(count);

    internalState!.blockedUntil = 0;
    internalState!.nextRequestAt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 403)),
    );
    await expect(searchLolRiotId("Forbidden#KR1")).rejects.toMatchObject({
      kind: "key_or_permission",
    });
  });

  it.each([403, 429] as const)(
    "오류 HTTP %i 본문 취소 실패가 원래 오류를 덮지 않는다",
    async (status) => {
      const upstream = response(
        {},
        status,
        status === 429 ? { "Retry-After": "30" } : undefined,
      );
      vi.spyOn(upstream.body!, "cancel").mockRejectedValue(
        new Error("sensitive response body"),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => upstream),
      );
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const result = await POST(post("Status#KR1"));
      expect(result.status).toBe(status === 403 ? 503 : status);
      if (status === 429) expect(result.headers.get("Retry-After")).toBe("30");
      expect(await result.json()).toEqual({
        error:
          status === 403
            ? "Riot API 키를 갱신하는 중입니다. 잠시 후 다시 시도해 주세요."
            : "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        ...(status === 403 ? { reasonCode: "riot_key_renewal", detail: "Riot API key is being renewed" } : {}),
      });
      const logged = JSON.stringify(diagnostic.mock.calls);
      const record = JSON.parse(String(diagnostic.mock.calls.at(-1)?.[1]));
      expect(record).toMatchObject({
        stage: "body_cancel",
        reasonCode: "body_cancel_failed",
        status,
      });
      expect(logged).not.toContain("sensitive response body");
    },
  );

  it("응답 본문 시간 초과도 504와 단일 timeout 메트릭으로 남긴다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = response({});
    vi.spyOn(upstream, "arrayBuffer").mockRejectedValue(new DOMException("private-timeout-body", "TimeoutError"));
    vi.stubGlobal("fetch", vi.fn(async () => upstream));
    const result = await POST(post("BodyTimeout#KR1"));
    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({ error: "Riot API 응답 시간이 초과되었습니다." });
    expect(ops.record).toHaveBeenCalledExactlyOnceWith("riot_timeout");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[1]))).toMatchObject({ stage: "body", reasonCode: "timeout" });
  });

  it("네트워크 오류는 endpoint·fetch 단계·allowlist 원인 코드만 기록한다", async () => {
    const cause = Object.assign(new Error("private transport message"), {
      code: "ECONNRESET",
    });
    const error = Object.assign(new TypeError("private request URL"), {
      cause,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw error;
      }),
    );
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(post("Transport#KR1"))).status).toBe(502);
    const logged = JSON.stringify(diagnostic.mock.calls);
    const record = JSON.parse(String(diagnostic.mock.calls.at(-1)?.[1]));
    expect(record).toMatchObject({
      endpoint: "account",
      stage: "fetch",
      reasonCode: "ECONNRESET",
    });
    expect(logged).not.toContain("private transport message");
    expect(logged).not.toContain("private request URL");
  });

  it("HTTP·body·JSON·queue 실패를 서로 다른 안전한 코드로 기록한다", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = async (mock: ReturnType<typeof vi.fn>) => {
      internalState?.cache.clear();
      internalState?.inflight.clear();
      if (internalState) {
        internalState.queue = Promise.resolve();
        internalState.nextRequestAt = 0;
      }
      vi.stubGlobal("fetch", mock);
      await POST(post(`Case${diagnostic.mock.calls.length}#KR1`));
      return String(diagnostic.mock.calls.at(-1)?.[1]);
    };

    expect(await failed(vi.fn(async () => response({}, 500)))).toContain(
      '"stage":"http"',
    );
    expect(diagnostic.mock.calls.at(-1)?.[1]).toContain('"status":500');

    const bodyFailure = response({});
    vi.spyOn(bodyFailure, "arrayBuffer").mockRejectedValue(
      new Error("private body"),
    );
    expect(await failed(vi.fn(async () => bodyFailure))).toContain(
      '"reasonCode":"body_read_failed"',
    );

    expect(
      await failed(vi.fn(async () => new Response("private raw text"))),
    ).toContain('"reasonCode":"invalid_json"');

    const brokenStatus = Object.defineProperty({}, "status", {
      get: () => {
        throw new Error("private queue error");
      },
    }) as Response;
    const queueFailure = await failed(vi.fn(async () => brokenStatus));
    expect(queueFailure).toContain('"stage":"queue"');
    expect(queueFailure).toContain('"reasonCode":"queue_execution_failed"');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
      "private raw text",
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private body");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
      "private queue error",
    );
  });

  it("유효하지 않은 Retry-After를 유한한 최소 대기값으로 바꾼다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 429, { "Retry-After": "Infinity" })),
    );
    const result = await POST(post("Rate#KR1"));
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("1");
    expect(Number.isFinite(internalState!.blockedUntil)).toBe(true);
  });

  it("경기 상세 실패를 부분 오류로 보존한다", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("accounts/by-riot-id"))
        return response({ puuid: "p", gameName: "Test", tagLine: "KR1" });
      if (url.includes("summoner/v4"))
        return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response(["KR_1", "KR_2"]);
      return response({}, 403);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Forbidden#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({ matchFailures: [
      { matchId: "KR_1", kind: "key_or_permission" },
      { matchId: "KR_2", kind: "key_or_permission" },
    ] });
    expect(urls.filter((url) => url.includes("/matches/KR_"))).toHaveLength(2);
  });

  it("경기 상세는 매번 관리자 가드 후 KR 경기 ID를 검증한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    access.requireLolDevAdmin.mockResolvedValueOnce({
      ok: false,
      error: Response.json({}, { status: 401 }),
    });
    expect(
      (
        await getMatch(new Request("http://localhost"), {
          params: Promise.resolve({ matchId: "KR_1" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await getMatch(new Request("http://localhost"), {
          params: Promise.resolve({ matchId: "ASIA_1" }),
        })
      ).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(access.requireLolDevAdmin).toHaveBeenCalledTimes(2);
  });

  it("상세는 검색에서 채운 경기 캐시를 재사용하고 PUUID를 내보내지 않는다", async () => {
    vi.setSystemTime(Date.now() + 72 * 60 * 60_000);
    const calls: string[] = [];
    const match = {
      metadata: {
        matchId: "KR_91",
        participants: ["private-puuid", "other-puuid"],
      },
      info: {
        queueId: 420,
        gameMode: "CLASSIC",
        gameDuration: 1800,
        teams: [
          { teamId: 100, win: true },
          { teamId: 200, win: false },
        ],
        participants: [
          {
            puuid: "private-puuid",
            teamId: 100,
            riotIdGameName: "가상A",
            riotIdTagline: "KR1",
            championId: 103,
            championName: "Ahri",
            win: true,
            champLevel: 21,
            summoner1Id: 4,
            summoner2Id: 14,
            perks: {
              styles: [
                { description: "subStyle", style: 8100, selections: [] },
                {
                  description: "primaryStyle",
                  style: 8000,
                  selections: [{ perk: 8005 }],
                },
              ],
            },
            kills: 5,
            deaths: 2,
            assists: 9,
            item0: 1056,
            totalDamageDealtToChampions: 18000,
            totalDamageTaken: 24000,
            totalMinionsKilled: 150,
            neutralMinionsKilled: 10,
            visionScore: 22,
          },
          {
            puuid: "other-puuid",
            teamId: 200,
            championId: 86,
            championName: "Garen",
            win: false,
            kills: 1,
            deaths: 6,
            assists: 2,
            totalMinionsKilled: 100,
            neutralMinionsKilled: 2,
          },
        ],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://ddragon"))
        return response(
          url.endsWith("runesReforged.json")
            ? [
                {
                  id: 8000,
                  name: "정밀",
                  icon: "perk-images/Styles/7201_Precision.png",
                  slots: [
                    {
                      runes: [
                        {
                          id: 8005,
                          name: "집중 공격",
                          icon: "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png",
                        },
                      ],
                    },
                  ],
                },
                {
                  id: 8100,
                  name: "지배",
                  icon: "perk-images/Styles/7200_Domination.png",
                  slots: [],
                },
              ]
            : {
                data: url.includes("champion.json")
                  ? {
                      Ahri: { name: "아리", key: "103" },
                      Garen: { name: "가렌", key: "86" },
                    }
                  : url.includes("summoner.json")
                    ? {
                        SummonerFlash: {
                          id: "SummonerFlash",
                          key: 4,
                          name: "점멸",
                          image: { full: "SummonerFlash.png" },
                        },
                        SummonerDot: {
                          id: "SummonerDot",
                          key: 14,
                          name: "점화",
                          image: { full: "SummonerDot.png" },
                        },
                      }
                    : { "1056": { name: "도란의 반지" } },
              },
        );
      if (url.includes("accounts/by-riot-id"))
        return response({
          puuid: "private-puuid",
          gameName: "가상A",
          tagLine: "KR1",
        });
      if (url.includes("summoner/v4"))
        return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response(["KR_91"]);
      return response(match);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("가상A#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    const riotCallsAfterSearch = calls.filter((url) =>
      url.includes("api.riotgames.com"),
    ).length;
    const matchResponse = await getMatch(new Request("http://localhost"), {
      params: Promise.resolve({ matchId: "KR_91" }),
    });
    const body = await matchResponse.text();
    expect(matchResponse.status).toBe(200);
    expect(matchResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(body).not.toContain("puuid");
    expect(body).toContain("아리");
    expect(body).toContain("도란의 반지");
    expect(JSON.parse(body).teams).toHaveLength(2);
    expect(JSON.parse(body).teams[0].participants[0]).toMatchObject({
      championLevel: 21,
      spells: [
        { id: 4, name: "점멸", image: "SummonerFlash.png" },
        { id: 14, name: "점화", image: "SummonerDot.png" },
      ],
      runes: {
        keystone: { id: 8005, name: "집중 공격" },
        primaryStyle: { id: 8000, name: "정밀" },
        subStyle: { id: 8100, name: "지배" },
      },
      damageToChampions: 18000,
      damageTaken: 24000,
    });
    expect(JSON.parse(body).teams[1].participants[0].visionScore).toBeNull();
    expect(
      calls.filter((url) => url.includes("api.riotgames.com")),
    ).toHaveLength(riotCallsAfterSearch);
  });

  it("경기 상세 캐시 미스에서는 Riot 경기 API를 한 번만 호출한다", async () => {
    const riotCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("api.riotgames.com")) riotCalls.push(url);
        if (url.startsWith("https://ddragon")) return response({ data: {} });
        return response({
          metadata: { matchId: "KR_92" },
          info: { queueId: 420, gameMode: "CLASSIC", participants: [] },
        });
      }),
    );
    const result = await getMatch(new Request("http://localhost"), {
      params: Promise.resolve({ matchId: "KR_92" }),
    });
    expect(result.status).toBe(200);
    expect(riotCalls).toHaveLength(1);
    expect(riotCalls[0]).toContain("/matches/KR_92");
  });

  it("10명 상세와 팀 objectives를 분리 투영하고 누락된 팀 합계는 부분합산하지 않는다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    const participants = Array.from({ length: 10 }, (_, index) => {
      const teamId = index < 5 ? 100 : 200;
      return {
        ...(index === 0 ? { puuid: "self" } : {}),
        teamId,
        championId: index === 0 ? 103 : 86,
        championName: index === 0 ? "Ahri" : "Garen",
        kills: teamId === 100 ? (index === 0 ? 2 : 1) : 0,
        deaths: 1,
        assists: 1,
        goldEarned: index === 1 ? undefined : teamId === 100 ? 1000 : 0,
        totalMinionsKilled: 0,
        neutralMinionsKilled: 0,
        wardsPlaced: index === 0 ? 7 : index === 2 ? -1 : 1,
        wardsKilled: index === 0 ? 5 : 2,
        detectorWardsPlaced:
          index === 0
            ? 3
            : index === 3
              ? Number.POSITIVE_INFINITY
              : index === 4
                ? undefined
                : 1,
        visionWardsBoughtInGame: 99,
        damageDealtToObjectives: index === 0 ? 123 : 10,
        damageDealtToTurrets: index === 0 ? 456 : 20,
        turretTakedowns: 88,
      };
    });
    persistence.matchRequestJson.mockResolvedValue({
      metadata: { matchId: "KR_97" },
      info: {
        queueId: 420,
        gameDuration: 1800,
        participants,
        teams: [
          {
            teamId: 100,
            objectives: {
              tower: { kills: 2, first: true },
              dragon: { kills: 3, first: false },
              baron: { kills: 4, first: true },
              riftHerald: { kills: 5, first: false },
              horde: { kills: 6, first: true },
              inhibitor: { kills: 7, first: false },
            },
          },
          {
            teamId: 200,
            objectives: {
              tower: { kills: 8, first: false },
              dragon: { kills: 9, first: true },
              baron: { kills: 10, first: false },
              riftHerald: { kills: 11, first: true },
              horde: { kills: 12, first: false },
              inhibitor: { kills: 13, first: true },
            },
          },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).startsWith("https://ddragon")
          ? response({ data: {} })
          : response({}),
      ),
    );
    const body = await (
      await getMatch(new Request("http://localhost"), {
        params: Promise.resolve({ matchId: "KR_97" }),
      })
    ).json();
    const blue = body.teams.find((team: any) => team.teamId === 100);
    const red = body.teams.find((team: any) => team.teamId === 200);
    expect(body.teams.flatMap((team: any) => team.participants)).toHaveLength(
      10,
    );
    expect(blue).toMatchObject({
      totalKills: 6,
      totalGold: null,
      objectives: {
        tower: { kills: 2, first: true },
        dragon: { kills: 3, first: false },
        baron: { kills: 4, first: true },
        riftHerald: { kills: 5, first: false },
        horde: { kills: 6, first: true },
        inhibitor: { kills: 7, first: false },
      },
    });
    expect(red).toMatchObject({
      totalKills: 0,
      totalGold: 0,
      objectives: {
        tower: { kills: 8 },
        dragon: { kills: 9 },
        baron: { kills: 10 },
        riftHerald: { kills: 11 },
        horde: { kills: 12 },
        inhibitor: { kills: 13 },
      },
    });
    expect(blue.participants[0]).toMatchObject({
      goldEarned: 1000,
      wardsPlaced: 7,
      wardsKilled: 5,
      detectorWardsPlaced: 3,
      damageDealtToObjectives: 123,
      damageDealtToTurrets: 456,
      killParticipationPct: 50,
      cs: 0,
    });
    expect(blue.participants[0]).not.toHaveProperty("visionWardsBoughtInGame");
    expect(blue.participants[0]).not.toHaveProperty("turretTakedowns");
    expect(blue.participants[2].wardsPlaced).toBeNull();
    expect(blue.participants[3].detectorWardsPlaced).toBeNull();
    expect(blue.participants[4].detectorWardsPlaced).toBeNull();
    expect(persistence.matchRequestJson).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) =>
          String(url).includes("api.riotgames.com"),
        ),
    ).toHaveLength(0);
  });

  it("킬관여율은 양수 분모를 쓰고 팀 킬 0 또는 본인 K/A 결측이면 미제공한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    persistence.matchRequestJson.mockResolvedValue({
      metadata: { matchId: "KR_96" },
      info: {
        queueId: 420,
        participants: [
          {
            puuid: "self",
            teamId: 100,
            championName: "Ahri",
            kills: 2,
            assists: 3,
          },
          { teamId: 100, kills: 3 },
          {
            puuid: "zero",
            teamId: 200,
            championName: "Garen",
            kills: 0,
            assists: 0,
          },
          { teamId: 200, kills: 0 },
          { puuid: "missingA", teamId: 300, championName: "Lux", kills: 1 },
          { teamId: 300, kills: 1 },
          { puuid: "missingK", teamId: 400, championName: "Lux", assists: 1 },
          { teamId: 400, kills: 1 },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).startsWith("https://ddragon")
          ? response({ data: {} })
          : response({}),
      ),
    );
    const body = await (
      await getMatch(new Request("http://localhost"), {
        params: Promise.resolve({ matchId: "KR_96" }),
      })
    ).json();
    expect(
      body.teams.map((team: any) => team.participants[0].killParticipationPct),
    ).toEqual([100, null, null, null]);
  });

  it("검색 요약은 299초·remake를 제외하고 300초와 큐별 완전 표본을 집계한다", async () => {
    vi.setSystemTime(Date.now() + 72 * 60 * 60_000);
    const ids = ["KR_101", "KR_102", "KR_103", "KR_104", "KR_105"];
    const matches = [
      {
        queueId: 420,
        gameDuration: 299,
        win: true,
        kills: 8,
        deaths: 1,
        assists: 4,
      },
      {
        queueId: 420,
        gameDuration: 300,
        win: true,
        kills: 0,
        deaths: 0,
        assists: 0,
      },
      {
        queueId: 440,
        gameDuration: 300,
        win: false,
        kills: 2,
        deaths: 2,
        assists: undefined,
      },
      {
        queueId: 450,
        gameDuration: 600,
        win: true,
        kills: 4,
        deaths: 2,
        assists: 2,
        teamEarlySurrendered: true,
      },
      {
        queueId: 100,
        gameDuration: 600,
        win: true,
        kills: 2,
        deaths: 2,
        assists: 2,
      },
    ];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "sample-puuid",
            gameName: "Sample",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 1, summonerLevel: 1 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(ids);
        if (url.endsWith("/champion.json"))
          return response({
            data: {
              Ahri: { name: "아리", key: "103" },
              Garen: { name: "가렌", key: "86" },
            },
          });
        if (url.startsWith("https://ddragon")) return response({ data: {} });
        const index = ids.indexOf(url.split("/").pop()!);
        const game = matches[index];
        const participants = [
          {
            puuid: "sample-puuid",
            teamId: 100,
            championId: index < 2 ? 103 : index === 2 ? 86 : 103,
            championName: index < 2 ? "Ahri" : "Garen",
            totalMinionsKilled: index === 1 ? 0 : 100,
            neutralMinionsKilled: index === 1 ? 0 : 20,
            goldEarned: index === 1 ? 0 : 1200,
            wardsPlaced: 0,
            wardsKilled: 0,
            detectorWardsPlaced: 0,
            damageDealtToObjectives: 0,
            damageDealtToTurrets: 0,
            ...game,
          },
          { teamId: 100, kills: 10 },
        ];
        return response({
          metadata: { matchId: ids[index] },
          info: {
            ...game,
            gameMode: game.queueId === 100 ? "ARAM" : "CLASSIC",
            gameEndTimestamp: 1,
            participants,
          },
        });
      }),
    );
    const pending = searchLolRiotId("Sample#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.matches[0]).toMatchObject({
      gameDuration: 299,
      cs: 120,
      goldEarned: 1200,
      csPerMinute: null,
      goldPerMinute: null,
    });
    expect(result.matches[1]).toMatchObject({
      cs: 0,
      goldEarned: 0,
      wardsPlaced: 0,
      killParticipationPct: 0,
      csPerMinute: 0,
      goldPerMinute: 0,
    });
    expect(result.matches[2]).toMatchObject({
      csPerMinute: 24,
      goldPerMinute: 240,
    });
    expect(result.matches[3].remake).toBe(true);
    expect(result.summaries.solo).toMatchObject({
      sampleSize: 2,
      validSampleSize: 1,
      excludedCount: 1,
      winRatePct: 100,
      averageKda: null,
      perfect: true,
      perfectCount: 1,
    });
    expect(result.summaries.flex).toMatchObject({
      sampleSize: 1,
      validSampleSize: 1,
      winRatePct: 0,
      averageKda: null,
      perfect: false,
      averageKills: null,
      averageDeaths: null,
      averageAssists: null,
      killsSampleSize: 0,
      deathsSampleSize: 0,
      assistsSampleSize: 0,
      averageKillParticipationPct: null,
      killParticipationSampleSize: 0,
    });
    expect(result.summaries.aram).toMatchObject({
      sampleSize: 2,
      validSampleSize: 1,
      excludedCount: 1,
      winRatePct: 100,
      averageKda: 2,
      perfect: false,
    });
    expect(result.summaries.all).toMatchObject({
      sampleSize: 5,
      validSampleSize: 3,
      excludedCount: 2,
      perfectCount: 1,
      wins: 2,
      losses: 1,
      averageKills: 1,
      averageDeaths: 1,
      averageAssists: 1,
      averageKda: 2,
      perfect: false,
      killsSampleSize: 2,
      deathsSampleSize: 2,
      assistsSampleSize: 2,
      averageKillParticipationPct: expect.closeTo(100 / 6),
      killParticipationSampleSize: 2,
    });
    expect(result.summaries.solo.champions).toEqual([
      {
        championId: 103,
        championImageId: "Ahri",
        championName: "아리",
        games: 1,
        wins: 1,
        winRatePct: 100,
        averageKda: null,
        perfect: true,
      },
    ]);
    expect(
      calls.filter(
        (url) =>
          url.includes("/matches/KR_") && url.includes("api.riotgames.com"),
      ),
    ).toHaveLength(5);
  });

  it("포지션과 함께 플레이한 소환사는 같은 팀의 유효 경기만 PUUID로 집계해 최대 10명까지 반환한다", async () => {
    vi.setSystemTime(Date.now() + 72 * 60 * 60_000);
    const ids = ["KR_131", "KR_132", "KR_133", "KR_134", "KR_135"];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "self-puuid",
            gameName: "Self",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 1, summonerLevel: 1 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(ids);
        if (url.startsWith("https://ddragon")) return response({ data: {} });
        const index = ids.indexOf(url.split("/").pop()!);
        const teammateCount =
          index === 0 ? 7 : index === 1 ? 6 : index === 2 ? 3 : 1;
        const participants = [
          {
            puuid: "self-puuid",
            teamId: 100,
            teamPosition: ["MIDDLE", "TOP", "Invalid", "JUNGLE", "BOTTOM"][
              index
            ],
            win: index !== 1,
            kills: 3,
            deaths: 2,
            assists: 4,
            championId: 103,
            championName: "Ahri",
          },
          ...Array.from({ length: teammateCount }, (_, peer) => ({
            puuid:
              index === 0 && peer === 6
                ? "rate"
                : index < 2
                  ? `mate-${peer}`
                  : index === 2 && peer === 0
                    ? "rate"
                    : index === 2 && peer === 2
                      ? "mate-5"
                      : `single-${index}`,
            riotIdGameName:
              index === 0 && peer === 6
                ? "rate"
                : index < 2
                  ? `mate-${peer}`
                  : index === 2 && peer === 0
                    ? "rate"
                    : index === 2 && peer === 2
                      ? "mate-5"
                      : `single-${index}`,
            riotIdTagline: "KR1",
            teamId: 100,
            win: index !== 1,
            kills: 1,
            championName: "Garen",
          })),
          ...Array.from({ length: 6 }, (_, peer) => ({
            puuid: `enemy-${peer}`,
            riotIdGameName: `enemy-${peer}`,
            riotIdTagline: "KR1",
            teamId: 200,
            win: index === 1,
            kills: 2,
          })),
        ];
        return response({
          metadata: { matchId: ids[index] },
          info: {
            queueId: 420,
            gameMode: "CLASSIC",
            gameDuration: index === 4 ? 299 : 600,
            participants: participants.map((participant) => ({
              ...participant,
              ...(index === 3 ? { teamEarlySurrendered: true } : {}),
            })),
          },
        });
      }),
    );
    const pending = searchLolRiotId("Self#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    const summary = result.summaries.solo;
    expect(summary.positions).toEqual({
      TOP: 1,
      JUNGLE: 0,
      MIDDLE: 1,
      BOTTOM: 0,
      UTILITY: 0,
      미분류: 1,
    });
    expect(summary.teammates).toHaveLength(7);
    expect(summary.teammates.slice(0, 5).map((player) => player.riotId)).toEqual([
      "mate-5#KR1",
      "rate#KR1",
      "mate-0#KR1",
      "mate-1#KR1",
      "mate-2#KR1",
    ]);
    expect(summary.teammates[0]).toMatchObject({
      games: 3,
      wins: 2,
      losses: 1,
    });
    expect(summary.teammates[1]).toMatchObject({
      games: 2,
      wins: 2,
      losses: 0,
      winRatePct: 100,
    });
    expect(
      summary.teammates.some(
        (player) =>
          player.riotId.startsWith("enemy-") ||
          player.riotId.startsWith("single-"),
      ),
    ).toBe(false);
    // 상대 팀은 같은 팀 목록과 섞이지 않는다.
    expect(summary.opponents?.every((player) => player.riotId.startsWith("enemy-"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("puuid");
    expect(
      calls.filter((url) => url.includes("api.riotgames.com")),
    ).toHaveLength(11);
  });

  it.each([100, undefined])(
    "팀 ID %s의 동료는 경기별 중복을 빼고 승패 결측을 미제공한다",
    async (teamId) => {
      const ids = ["KR_151", "KR_152"];
      const urls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("accounts/by-riot-id"))
          return response({ puuid: "self-secret", gameName: "Self", tagLine: "KR1" });
        if (url.includes("summoner/v4")) return response({});
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(ids);
        if (url.startsWith("https://ddragon")) return response({ data: {} });
        const peer = {
          puuid: "peer-secret", teamId, riotIdGameName: "Unknown", riotIdTagline: "KR1", kills: 2,
        };
        return response({
          metadata: { matchId: url.split("/").pop() },
          info: {
            queueId: 420, gameMode: "CLASSIC", gameDuration: 600,
            participants: [
              { puuid: "self-secret", teamId, win: true, kills: 1, deaths: 1, assists: 1 },
              peer,
              peer,
              { ...peer, puuid: "known-secret", riotIdGameName: "Known", win: false },
              { ...peer, puuid: "enemy-secret", teamId: 200, riotIdGameName: "Enemy" },
              { ...peer, puuid: "blank-secret", riotIdGameName: " " },
            ],
          },
        });
      }));
      const pending = POST(post("Self#KR1"));
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.status).toBe(200);
      const body = await result.json();
      if (teamId === undefined)
        expect(body.matches.every((match: { killParticipationPct: number | null }) =>
          match.killParticipationPct === null,
        )).toBe(true);
      expect(body.summaries.solo.teammates.map(({ playerKey, ref, ...row }: { playerKey?: string; ref?: string; riotId: string }) => {
        expect(playerKey).toMatch(/^[a-f0-9]{32}$/);
        expect(typeof ref).toBe("string");
        return row;
      })).toEqual(teamId ? [
        { riotId: "Known#KR1", games: 2, wins: 0, losses: 2, winRatePct: 0 },
        { riotId: "Unknown#KR1", games: 2, wins: 0, losses: 0, winRatePct: null },
      ] : []);
      expect(JSON.stringify(body)).not.toMatch(/puuid|self-secret|peer-secret|enemy-secret/);
      expect(urls.filter((url) => url.includes("api.riotgames.com"))).toHaveLength(8);
    },
  );

  it.each([
    {
      label: "퍼펙트 포함 3경기",
      stats: [
        { kills: 2, deaths: 1, assists: 1 },
        { kills: 4, deaths: 2, assists: 4 },
        { kills: 0, deaths: 0, assists: 10 },
      ],
      averageKda: 7, perfect: false, perfectCount: 1,
      averageKills: 2, averageDeaths: 1, averageAssists: 5, sampleSize: 3,
    },
    {
      label: "2/0/10 + 1/5/1은 2.80",
      stats: [{ kills: 2, deaths: 0, assists: 10 }, { kills: 1, deaths: 5, assists: 1 }],
      averageKda: 2.8, perfect: false, perfectCount: 1,
      averageKills: 1.5, averageDeaths: 2.5, averageAssists: 5.5, sampleSize: 2,
    },
    {
      label: "합산 데스 0은 Perfect",
      stats: [{ kills: 2, deaths: 0, assists: 10 }, { kills: 0, deaths: 0, assists: 0 }],
      averageKda: null, perfect: true, perfectCount: 2,
      averageKills: 1, averageDeaths: 0, averageAssists: 5, sampleSize: 2,
    },
    ...(["kills", "deaths", "assists"] as const).map((field) => ({
      label: `${field} 결측은 KDA와 모든 K/D/A 평균에서만 제외`,
      stats: [{ kills: 2, deaths: 1, assists: 4 }, { kills: 50, deaths: 50, assists: 50, [field]: undefined }],
      averageKda: 6, perfect: false, perfectCount: 0,
      averageKills: 2, averageDeaths: 1, averageAssists: 4, sampleSize: 1,
    })),
    {
      label: "승패 결측은 모든 요약 표본에서 제외",
      stats: [
        { kills: 2, deaths: 1, assists: 4 },
        { kills: 50, deaths: 50, assists: 50, win: undefined },
      ],
      averageKda: 6, perfect: false, perfectCount: 0,
      averageKills: 2, averageDeaths: 1, averageAssists: 4, sampleSize: 1,
    },
    {
      label: "완전 표본 없음은 미제공",
      stats: [{ kills: 2, deaths: 0, assists: undefined }],
      averageKda: null, perfect: false, perfectCount: 0,
      averageKills: null, averageDeaths: null, averageAssists: null, sampleSize: 0,
    },
  ])("전체·솔로·챔피언 합산 KDA: $label", async (expected) => {
    vi.setSystemTime(Date.now() + 72 * 60 * 60_000);
    const games = expected.stats.map((stats, index) => ({
      gameDuration: index === 0 ? 300 : 600, win: index % 2 === 0, ...stats,
    }));
    const ids = games.map((_, index) => `KR_${111 + index}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "champ-puuid",
            gameName: "Champion",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 1, summonerLevel: 1 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(ids);
        if (url.endsWith("/champion.json"))
          return response({ data: { Ahri: { name: "아리", key: "103" } } });
        if (url.startsWith("https://ddragon")) return response({ data: {} });
        const index = ids.indexOf(url.split("/").pop()!);
        const game = games[index];
        return response({
          metadata: { matchId: ids[index] },
          info: {
            queueId: 420,
            gameMode: "CLASSIC",
            gameDuration: game.gameDuration,
            participants: [
              {
                puuid: "champ-puuid",
                teamId: 100,
                championId: 103,
                championName: "Ahri",
                totalMinionsKilled: 100,
                neutralMinionsKilled: 20,
                goldEarned: 1000,
                ...game,
              },
              { teamId: 100, kills: 10 },
            ],
          },
        });
      }),
    );
    const pending = searchLolRiotId("Champion#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const { summaries } = await pending;
    const valid = games.filter((game) => game.win !== undefined);
    const wins = valid.filter((game) => game.win).length;
    const winRatePct = (wins / valid.length) * 100;
    for (const summary of [summaries.all, summaries.solo]) {
      expect(summary).toMatchObject({
        validSampleSize: valid.length,
        winRatePct,
        averageKda: expected.averageKda,
        perfect: expected.perfect,
        perfectCount: expected.perfectCount,
        averageKills: expected.averageKills,
        averageDeaths: expected.averageDeaths,
        averageAssists: expected.averageAssists,
        killsSampleSize: expected.sampleSize,
        deathsSampleSize: expected.sampleSize,
        assistsSampleSize: expected.sampleSize,
      });
      expect(summary).not.toHaveProperty("kdaSampleSize");
      expect(summary.champions).toEqual([
        {
          championId: 103,
          championImageId: "Ahri",
          championName: "아리",
          games: valid.length,
          wins,
          winRatePct,
          averageKda: expected.averageKda,
          perfect: expected.perfect,
        },
      ]);
    }
  });

  it("미등록 큐는 전체 표본에만 들어가고 ARAM 요약은 일반 칼바람 큐만 센다", async () => {
    vi.setSystemTime(Date.now() + 72 * 60 * 60_000);
    const ids = ["KR_121", "KR_122", "KR_123"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "queue-puuid",
            gameName: "Queue",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 1, summonerLevel: 1 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(ids);
        if (url.startsWith("https://ddragon")) return response({ data: {} });
        const index = ids.indexOf(url.split("/").pop()!);
        const queueId = [9999, 450, 2400][index];
        return response({
          metadata: { matchId: ids[index] },
          info: {
            queueId,
            gameMode: index === 0 ? "CLASSIC" : "ARAM",
            gameDuration: 600,
            participants: [
              {
                puuid: "queue-puuid",
                teamId: 100,
                championId: 103,
                championName: "Ahri",
                win: true,
                kills: 1,
                deaths: 1,
                assists: 1,
                totalMinionsKilled: 1,
                neutralMinionsKilled: 1,
              },
              { teamId: 100, kills: 1 },
            ],
          },
        });
      }),
    );
    const pending = searchLolRiotId("Queue#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.summaries.all).toMatchObject({
      sampleSize: 3,
      validSampleSize: 3,
    });
    // 아수라장(2400)은 gameMode가 ARAM이어도 일반 칼바람 요약에 섞이지 않는다.
    expect(result.summaries.aram).toMatchObject({
      sampleSize: 1,
      validSampleSize: 1,
    });
    expect(result.summaries.solo.sampleSize).toBe(0);
    expect(result.matches[0]).toMatchObject({
      queueId: 9999,
      gameMode: "CLASSIC",
    });
  });

  it("상세 DTO 이전 버전 캐시는 재사용하지 않고 저장 원문만으로 현재 버전을 만든다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    persistence.matchRequestJson.mockResolvedValue({
      metadata: { matchId: "KR_98" },
      info: {
        queueId: 420,
        participants: [
          {
            puuid: "static-puuid",
            teamId: 100,
            championId: 103,
            championName: "Ahri",
            win: true,
            champLevel: 8,
            totalDamageDealtToChampions: -1,
            totalDamageTaken: Number.NaN,
          },
        ],
      },
    });
    const riotCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("api.riotgames.com")) riotCalls.push(url);
        if (url.startsWith("https://ddragon"))
          return response(
            url.endsWith("runesReforged.json") ? [] : { data: {} },
          );
        return response({});
      }),
    );
    const result = await (
      await getMatch(new Request("http://localhost"), {
        params: Promise.resolve({ matchId: "KR_98" }),
      })
    ).json();
    expect(result.teams[0].participants[0]).toMatchObject({
      championLevel: 8,
      spells: [null, null],
      runes: { keystone: null, primaryStyle: null, subStyle: null },
      damageToChampions: null,
      damageTaken: null,
    });
    expect(persistence.cache).toHaveBeenCalledWith(
      "match_details",
      "match:v1:kr:asia:16.21.1:v6:KR_98",
      "kr",
      "asia",
      "16.21.1",
    );
    expect(persistence.matchRequestJson).toHaveBeenCalledWith(
      "KR_98",
      "kr",
      "asia",
    );
    expect(riotCalls).toHaveLength(0);
    expect(persistence.saveMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "16.21.1",
        cacheKey: "match:v1:kr:asia:16.21.1:v6:KR_98",
      }),
    );
  });

  it("Data Dragon 버전 변경은 상세 캐시를 새 키로 조회하고 저장 원문으로 재생성한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockImplementation(async (_kind, key) => key.includes("16.21.1")
      ? { matchId: "KR_987", teams: [], dataDragonVersion: "16.21.1" } : undefined);
    persistence.matchRequestJson.mockResolvedValue({
      metadata: { matchId: "KR_987" }, info: { queueId: 420, gameMode: "CLASSIC", participants: [], teams: [] },
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async input => {
      calls.push(String(input));
      return response(String(input).endsWith("runesReforged.json") ? [] : { data: {} });
    }));
    const context = { params: Promise.resolve({ matchId: "KR_987" }) };
    expect(await (await getMatch(new Request("http://localhost"), context)).json()).toMatchObject({ dataDragonVersion: "16.21.1" });
    dragon.version = "16.22.1";
    expect(await (await getMatch(new Request("http://localhost"), context)).json()).toMatchObject({ dataDragonVersion: "16.22.1" });
    expect(persistence.cache).toHaveBeenLastCalledWith("match_details", "match:v1:kr:asia:16.22.1:v6:KR_987", "kr", "asia", "16.22.1");
    expect(persistence.saveMatch).toHaveBeenCalledWith(expect.objectContaining({
      cacheKey: "match:v1:kr:asia:16.22.1:v6:KR_987", version: "16.22.1",
      cachePayload: expect.objectContaining({ dataDragonVersion: "16.22.1" }),
    }));
    expect(calls).toHaveLength(4);
    expect(calls.every(url => url.includes("/cdn/16.22.1/"))).toBe(true);
    dragon.version = "16.23.1";
    await getMatch(new Request("http://localhost"), context);
    expect(calls.slice(4)).toHaveLength(4);
    expect(calls.slice(4).every(url => url.includes("/cdn/16.23.1/"))).toBe(true);
  });

  it("검색용 정적자료 로딩과 상세 로딩이 겹쳐도 상세 메타데이터를 다시 채운다", async () => {
    vi.setSystemTime(Date.now() + 10 * 24 * 60 * 60_000);
    persistence.enabled.mockReturnValue(true);
    persistence.matchRequestJson.mockResolvedValue({
      metadata: { matchId: "KR_99" },
      info: {
        queueId: 420,
        participants: [
          {
            puuid: "static-puuid",
            teamId: 100,
            championId: 103,
            championName: "Ahri",
            summoner1Id: 4,
            win: true,
          },
        ],
      },
    });
    let releaseSearchData!: (value: Response) => void;
    let notifySearchDataStarted!: () => void;
    const searchDataStarted = new Promise<void>((resolve) => {
      notifySearchDataStarted = resolve;
    });
    const pendingSearchData = new Promise<Response>((resolve) => {
      releaseSearchData = resolve;
    });
    let delayChampion = true;
    const staticUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://ddragon")) staticUrls.push(url);
        if (url.endsWith("/champion.json") && delayChampion) {
          delayChampion = false;
          notifySearchDataStarted();
          return pendingSearchData;
        }
        if (url.endsWith("/champion.json"))
          return response({ data: { Ahri: { name: "아리", key: "103" } } });
        if (url.endsWith("/item.json")) return response({ data: {} });
        if (url.endsWith("/summoner.json"))
          return response({
            data: {
              SummonerFlash: {
                id: "SummonerFlash",
                key: 4,
                name: "점멸",
                image: { full: "SummonerFlash.png" },
              },
            },
          });
        if (url.endsWith("/runesReforged.json")) return response([]);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "static-puuid",
            gameName: "Static",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 1, summonerLevel: 1 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(["KR_99"]);
        if (url.includes("api.riotgames.com"))
          throw new Error("Unexpected Riot call");
        return response({});
      }),
    );
    const pendingSearch = searchLolRiotId("Static#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await searchDataStarted;
    const pendingDetail = getMatch(new Request("http://localhost"), {
      params: Promise.resolve({ matchId: "KR_99" }),
    });
    releaseSearchData(
      response({ data: { Ahri: { name: "아리", key: "103" } } }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await pendingSearch;
    const result = await pendingDetail;
    expect(await result.json()).toMatchObject({
      teams: [{ participants: [{ spells: [{ id: 4, name: "점멸" }, null] }] }],
    });
    expect(
      staticUrls.filter((url) => url.endsWith("/summoner.json")),
    ).toHaveLength(1);
    expect(
      staticUrls.filter((url) => url.endsWith("/runesReforged.json")),
    ).toHaveLength(1);
  });

  it.each([
    ["queueId 0", 0, "CLASSIC"],
    ["gameType CUSTOM_GAME", 420, "CUSTOM_GAME"],
  ])(
    "비공개 사용자 지정 경기($s)는 경기 상세로 반환하지 않는다",
    async (_label, queueId, gameType) => {
      const riotCalls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("api.riotgames.com")) riotCalls.push(url);
          return response({
            metadata: { matchId: "KR_93" },
            info: { queueId, gameMode: "CLASSIC", gameType, participants: [] },
          });
        }),
      );
      const result = await getMatch(new Request("http://localhost"), {
        params: Promise.resolve({ matchId: "KR_93" }),
      });
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({
        error: "이 경기 유형의 상세 정보는 표시할 수 없습니다.",
      });
      expect(riotCalls).toHaveLength(1);
    },
  );

  it("상세 응답의 경기 ID가 요청과 다르면 upstream 오류로 거부한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          metadata: { matchId: "KR_95" },
          info: { queueId: 420, gameMode: "CLASSIC", participants: [] },
        }),
      ),
    );
    const result = await getMatch(new Request("http://localhost"), {
      params: Promise.resolve({ matchId: "KR_94" }),
    });
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: "경기 상세를 불러오지 못했습니다.",
    });
  });

  it.each([
    ["queueId 0", 0, "CLASSIC"],
    ["gameType CUSTOM_GAME", 420, "CUSTOM_GAME"],
  ])("검색 요약은 ($s)를 제외한다", async (_label, queueId, gameType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("accounts/by-riot-id"))
          return response({
            puuid: "private-puuid",
            gameName: "Test",
            tagLine: "KR1",
          });
        if (url.includes("summoner/v4"))
          return response({ profileIconId: 1, summonerLevel: 1 });
        if (url.includes("league/v4")) return response([]);
        if (url.includes("/ids?")) return response(["KR_96"]);
        return response({
          metadata: { matchId: "KR_96" },
          info: {
            queueId,
            gameMode: "CLASSIC",
            gameType,
            participants: [{ puuid: "private-puuid", championName: "Ahri" }],
          },
        });
      }),
    );
    const pending = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      matches: [],
      matchStatus: "failed",
    });
  });

  it("경기 상세가 모두 실패하면 빈 경기 목록 상태와 구분한다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("accounts/by-riot-id"))
        return response({ puuid: "p", gameName: "Test", tagLine: "KR1" });
      if (url.includes("summoner/v4"))
        return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response(["KR_1", "KR_2"]);
      return response({}, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Failed#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      matches: [],
      matchStatus: "failed",
    });
  });

  it("더보기는 20개 ID 페이지를 한 번에 처리하고 저장 원문을 재사용한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.account.mockResolvedValue({ puuid: "private-puuid", gameName: "Test", tagLine: "KR1", accountFetchedAt: new Date().toISOString() });
    persistence.cache.mockResolvedValue(undefined);
    persistence.matchRequestJson.mockImplementation(async (matchId: string) => ({
      metadata: { matchId, dataVersion: "2" },
      info: { queueId: 420, gameMode: "CLASSIC", gameDuration: 1800, gameEndTimestamp: 1_700_000_000_000,
        teams: [{ teamId: 100, win: true }],
        participants: [{ puuid: "private-puuid", teamId: 100, championId: 103, championName: "Ahri", win: true, kills: 2, deaths: 1, assists: 3, totalMinionsKilled: 100, neutralMinionsKilled: 10 }] },
    }));
    const ids = Array.from({ length: 20 }, (_, index) => `KR_${20 + index}`);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/ids?")) return response(ids);
      if (url.startsWith("https://ddragon")) return response({ data: {} });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const result = await moreMatches(postMore({ riotId: "Test#KR1", offset: 20 }));
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.matchIds).toHaveLength(20);
    expect(body.matches).toHaveLength(20);
    expect(body.loadedCount).toBe(40);
    expect(body.hasMore).toBe(true);
    expect(JSON.stringify(body)).not.toContain("private-puuid");
    expect(urls.filter((url) => url.includes("api.riotgames.com"))).toEqual([
      "https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/private-puuid/ids?start=20&count=20",
    ]);
    expect(persistence.account).toHaveBeenCalledWith("Test", "KR1");
    expect(persistence.matchRequestJson).toHaveBeenCalledTimes(20);
  });

  it("더보기 재시도는 전달한 경기 ID를 그대로 처리하고 다음 offset을 보존한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.account.mockResolvedValue({ puuid: "private-puuid", gameName: "Test", tagLine: "KR1", accountFetchedAt: new Date().toISOString() });
    persistence.cache.mockResolvedValue(undefined);
    persistence.matchRequestJson.mockResolvedValue({
      metadata: { matchId: "KR_9", dataVersion: "2" },
      info: { queueId: 420, gameMode: "CLASSIC", gameDuration: 1800, gameEndTimestamp: 1_700_000_000_000,
        teams: [{ teamId: 100, win: true }],
        participants: [{ puuid: "private-puuid", teamId: 100, championId: 103, championName: "Ahri", win: true, kills: 2, deaths: 1, assists: 3, totalMinionsKilled: 100, neutralMinionsKilled: 10 }] },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://ddragon")) return response({ data: {} });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const result = await moreMatches(postMore({ riotId: "Test#KR1", offset: 7, matchIds: ["KR_9"] }));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({ matchIds: ["KR_9"], loadedCount: 8, hasMore: true, matches: [{ matchId: "KR_9" }] });
    expect(persistence.account).toHaveBeenCalledOnce();
    expect(persistence.matchRequestJson).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(expect.stringContaining("/ids?"), expect.anything());
  });

  it("같은 more 요청은 계정 단위 lease 안에서 합친다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    const account = { puuid: "private-puuid", gameName: "Test", tagLine: "KR1" };
    internalState?.accounts.set("test#kr1", { account, expiresAt: Date.now() + 60_000 });
    let resolveRaw!: (value: unknown) => void;
    persistence.matchRequestJson.mockReturnValue(new Promise((resolve) => { resolveRaw = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://ddragon")) return response({ data: {} });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const input = { riotId: "Test#KR1", offset: 4, matchIds: ["KR_9"] };
    const first = getMoreLolMatches(input);
    const key = "more:search:v11:test#kr1:4:KR_9";
    for (let index = 0; index < 20 && !internalState?.inflight.has(key); index += 1) await Promise.resolve();
    expect(internalState?.inflight.has(key)).toBe(true);
    const second = getMoreLolMatches(input);
    resolveRaw({
      metadata: { matchId: "KR_9" },
      info: { queueId: 420, gameMode: "CLASSIC", gameDuration: 1800, gameEndTimestamp: 1_700_000_000_000,
        teams: [{ teamId: 100, win: true }],
        participants: [{ puuid: "private-puuid", teamId: 100, championId: 103, championName: "Ahri", win: true, kills: 2, deaths: 1, assists: 3, totalMinionsKilled: 100, neutralMinionsKilled: 10 }] },
    });
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { loadedCount: 5, matches: [{ matchId: "KR_9" }] },
      { loadedCount: 5, matches: [{ matchId: "KR_9" }] },
    ]);
    expect(persistence.matchRequestJson).toHaveBeenCalledOnce();
    expect(persistence.acquire).toHaveBeenCalledTimes(2);
  });

  it("refresh는 DB account_fetched_at으로 최근 120초 내 요청을 거절한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    const lastUpdatedAt = new Date().toISOString();
    persistence.account.mockResolvedValue({ puuid: "private-puuid", gameName: "Test", tagLine: "KR1", accountFetchedAt: lastUpdatedAt });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://localhost/api/admin/lol/search", {
      method: "POST", headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ riotId: "Test#KR1", refresh: true }),
    });
    const result = await POST(request);
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({ status: "cooldown", lastUpdatedAt, remainSeconds: expect.any(Number) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refresh는 lease를 얻기 전 다른 갱신이 끝나면 저장 시각을 다시 확인한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.cache.mockResolvedValue(undefined);
    const lastUpdatedAt = new Date().toISOString();
    const account = { puuid: "private-puuid", gameName: "Test", tagLine: "KR1" };
    persistence.account.mockResolvedValueOnce({ ...account, accountFetchedAt: new Date(Date.now() - 121_000).toISOString() })
      .mockResolvedValueOnce({ ...account, accountFetchedAt: lastUpdatedAt });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchLolRiotId("Test#KR1", { refresh: true })).resolves.toEqual({
      status: "cooldown", remainSeconds: 120, lastUpdatedAt,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.releaseLease).toHaveBeenCalledOnce();
  });

  it("쿨다운이 지난 refresh는 account·summoner·league·ID 캐시를 우회한다", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("accounts/by-riot-id")) return response({ puuid: "p", gameName: "Test", tagLine: "KR1" });
      if (url.includes("summoner/v4")) return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const initial = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    await initial;
    await vi.advanceTimersByTimeAsync(120_001);
    for (const entry of internalState?.cache.values() ?? []) {
      if (entry && typeof entry === "object" && "expiresAt" in entry)
        entry.expiresAt = Date.now() + 60_000;
    }
    const refreshed = searchLolRiotId("Test#KR1", { refresh: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await refreshed;
    for (const endpoint of ["accounts/by-riot-id", "summoner/v4", "league/v4", "/ids?"]) {
      expect(calls.filter((url) => url.includes(endpoint))).toHaveLength(2);
    }
  });

  it("search DTO summaries는 순수 summary 함수 결과를 그대로 담는다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("accounts/by-riot-id")) return response({ puuid: "private-puuid", gameName: "Test", tagLine: "KR1" });
      if (url.includes("summoner/v4")) return response({ profileIconId: 1, summonerLevel: 1 });
      if (url.includes("league/v4")) return response([]);
      return response([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Test#KR1");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.summaries).toEqual(summarizeRecentMatches(result.matches, "Test#KR1"));
  });

  it("응답 오류에 키나 원본 응답 본문을 노출하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ message: "test-key-never-real" }, 500)),
    );
    const result = await POST(post("Error#KR1"));
    const body = await result.text();
    expect(result.status).toBe(502);
    expect(body).not.toContain("test-key-never-real");
    expect(body).not.toContain("private-puuid");
  });

  it("거부 응답의 본문 취소 오류가 요청 큐를 멈추지 않는다", async () => {
    const upstream = response({ message: "private details" }, 500);
    vi.spyOn(upstream.body!, "cancel").mockRejectedValue(
      new Error("private details"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstream),
    );
    const result = await POST(post("Error#KR1"));
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("private details");
  });
});


describe("PUUID 참가자 이동의 Riot 요청 경로", () => {
  it.each([undefined, new Date(Date.now() - 24 * 60 * 60_000).toISOString()])(
    "이름이 없거나 오래되면 by-puuid를 공유 가드로 한 번만 요청한다: %s",
    async (fetchedAt) => {
      persistence.enabled.mockReturnValue(true);
      persistence.names.mockResolvedValue(fetchedAt ? [{ puuid: "peer", game_name: "Old", tag_line: "KR1", account_fetched_at: fetchedAt }] : []);
      const fetch = vi.fn(async () => response({ puuid: "peer", gameName: "Current", tagLine: "KR1" }));
      vi.stubGlobal("fetch", fetch);
      const pending = resolveLolParticipantRef(sealLolParticipantRef("peer")!);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBe("Current#KR1");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("https://asia.api.riotgames.com/riot/account/v1/accounts/by-puuid/peer", expect.anything());
      expect(persistence.reserve).toHaveBeenCalledWith("asia");
      expect(persistence.start).toHaveBeenCalledTimes(1);
      expect(ops.record).toHaveBeenCalledWith("riot_success");
      expect(persistence.saveSearch).not.toHaveBeenCalled();
    },
  );

  it("by-puuid 404도 account로 분류하고 식별자를 로그에 남기지 않는다", async () => {
    persistence.enabled.mockReturnValue(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 404)));
    const pending = resolveLolParticipantRef(sealLolParticipantRef("private-peer")!);
    const rejection = expect(pending).rejects.toMatchObject({ kind: "not_found", diagnostic: { endpoint: "account", reasonCode: "http_404" } });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-peer");
  });
});

describe("숙련도 검색과 영구 요약 연결", () => {
  function upstream(masteryStatus = 200, malformed = false) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ddragon")) return response({ data: { Ahri: { key: "103", name: "아리" } } });
      if (url.includes("accounts/by-riot-id")) return response({ puuid: "mastery-fixture-secret", gameName: "Fixture", tagLine: "FIX" });
      if (url.includes("summoner/v4")) return response({ profileIconId: 1, summonerLevel: 30 });
      if (url.includes("league/v4")) return response([]);
      if (url.includes("/ids?")) return response(["KR_7788"]);
      if (url.includes("champion-mastery/v4")) return response(malformed ? {} : [{
        puuid: "mastery-fixture-secret", championId: 103, championLevel: 14, championPoints: 250000, lastPlayTime: 1790000000000,
        championPointsUntilNextLevel: 100, championSeasonMilestone: 2, nextSeasonMilestone: { reward: "private" },
      }], masteryStatus, masteryStatus === 429 ? { "Retry-After": "60" } : undefined);
      if (url.endsWith("/KR_7788")) return response({ metadata: { matchId: "KR_7788" }, info: {
        queueId: 420, gameMode: "CLASSIC", gameDuration: 1800, gameEndTimestamp: 1790000000000,
        participants: [{ puuid: "mastery-fixture-secret", championId: 103, championName: "Ahri", win: true,
          kills: 5, deaths: 2, assists: 7, teamId: 100, challenges: { soloKills: 2, kda: "invalid", unknownPatchKey: 88 } }],
      } });
      throw new Error("unexpected fixture endpoint");
    });
  }

  it("검색 상세는 본인 사실 지표만 전달하고 참가자 challenges 원문을 노출하지 않는다", async () => {
    const base = upstream();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const result = await base(input);
      if (!String(input).endsWith("/KR_7788")) return result;
      const raw = await result.json();
      Object.assign(raw.info.participants[0], { teamPosition: "MIDDLE", visionScore: 30,
        challenges: { teamDamagePercentage: 0.3, maxCsAdvantageOnLaneOpponent: 34, laneMinionsFirst10Minutes: 80, unknownPatchKey: 88 } });
      raw.info.participants.push({ puuid: "opponent-secret", teamId: 200, teamPosition: "MIDDLE", visionScore: 20,
        challenges: { teamDamagePercentage: 0.8, laneMinionsFirst10Minutes: 60, unknownPatchKey: 99 } });
      return response(raw);
    });
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.matches[0].insights?.laning).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "최대 CS 우위", value: "34" }), expect.objectContaining({ label: "시야 점수 격차", value: "+10" }),
    ]));
    expect(result.matches[0].insights?.contribution[0]).toMatchObject({ label: "팀 내 피해 비중", value: "30%" });
    expect(result.matches[0].insights?.laning.find(item => item.label === "10분 라인 CS")?.description).toContain("상대는 60개");
    expect(result.matches[0].details?.teams.flatMap(team => team.participants).some(player => "insights" in player)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/unknownPatchKey|opponent-secret|teamDamagePercentage|"challenges"/);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
  });

  it("숙련도 1회만 추가하고 캐시 적중에도 영구 요약을 다시 읽으며 식별자를 노출하지 않는다", async () => {
    dragon.version = "16.22.77";
    persistence.enabled.mockReturnValue(true);
    persistence.account.mockResolvedValue({ puuid: "mastery-fixture-secret", gameName: "Fixture", tagLine: "FIX" });
    const stored = { queue_id: 420, champion_id: 103, champion_name: "Ahri", duration_seconds: 1800, remake: false, win: true, kills: 5, deaths: 2, assists: 7 };
    persistence.summaries.mockResolvedValue([stored, stored, stored]);
    const fetchMock = upstream(); vi.stubGlobal("fetch", fetchMock);
    const first = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    const result = await first;
    expect(result.mastery).toMatchObject({ status: "ready", recent: { status: "ready", sampleSize: 3,
      champions: [{ games: 3, winRatePct: 100, kda: 6 }] } });
    expect(result.matches[0]).not.toHaveProperty("challenges");
    expect(persistence.saveSearch.mock.calls[0][0].matches[0].summary.challenges).toEqual({ soloKills: 2 });
    expect(persistence.summaries).toHaveBeenCalledWith("mastery-fixture-secret", 100);
    expect(persistence.saveSearch.mock.invocationCallOrder[0]).toBeLessThan(persistence.summaries.mock.invocationCallOrder[0]);
    expect(JSON.stringify(result)).not.toMatch(/puuid|mastery-fixture-secret|nextSeasonMilestone/);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter(url => url.includes("champion-mastery"))).toEqual([
      "https://kr.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/mastery-fixture-secret/top?count=10",
    ]);
    expect(persistence.reserve).toHaveBeenCalledTimes(7);
    persistence.cache.mockResolvedValue(result);
    persistence.summaries.mockResolvedValue([stored, stored, stored, stored]);
    expect((await searchLolRiotId("Fixture#FIX")).mastery?.recent.sampleSize).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(urls.length);
  });

  it.each([[503, false], [404, false], [429, false], [200, true]])("숙련도 %i 오류나 잘못된 응답(%s)은 기존 경기 검색을 보존한다", async (status, malformed) => {
    const fetchMock = upstream(status, malformed); vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.matchStatus).toBe("ready"); expect(result.matches).toHaveLength(1);
    expect(result.mastery?.status).toBe("failed");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("champion-mastery"))).toHaveLength(1);
  });

  it("영구 요약 조회 실패는 숙련도와 검색을 보존한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.summaries.mockRejectedValue(new LolPersistenceError());
    vi.stubGlobal("fetch", upstream());
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.matchStatus).toBe("ready");
    expect(result.mastery).toMatchObject({ status: "ready", recent: { status: "unavailable" } });
  });
});


describe("심사 전 공개 조회와 삭제 경계", () => {
  it("계정과 무관한 더보기 ID를 거부하고 경기 원문 요청·저장을 하지 않는다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.account.mockResolvedValue({ puuid: "fixture-owner", gameName: "Fixture", tagLine: "FIX" });
    const fetcher = vi.fn<typeof fetch>(async () => response(["KR_101", "KR_102"]));
    vi.stubGlobal("fetch", fetcher);
    await expect(getMoreLolMatches({ riotId: "Fixture#FIX", offset: 0, matchIds: ["KR_999"], validateMatchIds: true }))
      .rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain("/by-puuid/fixture-owner/ids?start=0&count=20");
    expect(persistence.matchRequestJson).not.toHaveBeenCalled();
    expect(persistence.saveMatch).not.toHaveBeenCalled();
    expect(persistence.releaseLease).toHaveBeenCalledOnce();
  });

  it("공개 상세는 저장된 경기만 허용하고 미저장 경기는 Riot 호출 없이 거부한다", async () => {
    persistence.enabled.mockReturnValue(true);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(getLolMatchDetails("KR_999", true)).rejects.toMatchObject({ kind: "not_found" });
    expect(persistence.storedMatch).toHaveBeenCalledExactlyOnceWith("KR_999");
    expect(fetcher).not.toHaveBeenCalled();
    expect(persistence.cache).not.toHaveBeenCalled();
  });

  it("Account-V1 삭제 확인은 저장 계정 없이 현재 Riot ID의 PUUID를 조회한다", async () => {
    persistence.enabled.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => response({ puuid: "unsearched-fixture", gameName: "Renamed", tagLine: "FIX" })));
    await expect(resolveLolAccountForDeletion("Renamed#FIX")).resolves.toMatchObject({ puuid: "unsearched-fixture" });
    expect(persistence.account).not.toHaveBeenCalled();
    expect(persistence.saveSearch).not.toHaveBeenCalled();
  });

  it("검색 lease는 180초이며 stale 저장은 재시도 문구로 반환한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.saveSearch.mockRejectedValueOnce(new LolLeaseExpiredError());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("accounts/by-riot-id")) return response({ puuid: "fixture-owner", gameName: "Fixture", tagLine: "FIX" });
      if (url.includes("summoner/v4")) return response({ profileIconId: 1, summonerLevel: 30 });
      if (url.includes("/ids?") || url.includes("league/v4") || url.includes("champion-mastery")) return response([]);
      return response({ data: {} });
    }));
    const result = await POST(post("Fixture#FIX"));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "처리 시간이 초과되었습니다. 다시 시도해 주세요." });
    expect(persistence.acquire).toHaveBeenCalledWith("search:v11:fixture#fix", 180);
  });
});


describe("Challenges-V1 검색·일일 캐시·실패 격리", () => {
  function upstream(playerStatus = 200, configStatus = 200, oversizedPlayer = false) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ddragon")) return response({ data: { Ahri: { key: "103", name: "아리" } } });
      if (url.includes("accounts/by-riot-id")) return response({ puuid: "challenge-fixture-secret", gameName: "Fixture", tagLine: "FIX" });
      if (url.includes("summoner/v4")) return response({ profileIconId: 1, summonerLevel: 30 });
      if (url.includes("league/v4") || url.includes("/ids?") || url.includes("champion-mastery")) return response([]);
      if (url.includes("/player-data/")) return oversizedPlayer ? new Response("x".repeat(1024 * 1024 + 1)) : response(challengePlayerFixture, playerStatus);
      if (url.endsWith("/challenges/config")) return response(challengeConfigFixture, configStatus);
      if (url.endsWith("/challenges/percentiles")) return response(challengePercentilesFixture);
      throw new Error("unexpected fixture endpoint");
    });
  }
  it("검색당 player-data 1회·설정과 분포 각 1회이며 캐시와 갱신에서도 일일 데이터를 재사용한다", async () => {
    const fetchMock = upstream(); vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.challengeProfile?.rarest[0]).toMatchObject({ name: "가상의 수호자", percentile: 0.003 });
    expect(JSON.stringify(result)).not.toMatch(/challenge-fixture-secret|fixture-title-id|preferences/);
    const before = fetchMock.mock.calls.length;
    await searchLolRiotId("Fixture#FIX"); expect(fetchMock).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(120_001);
    const refresh = searchLolRiotId("Fixture#FIX", { refresh: true }); await vi.advanceTimersByTimeAsync(30_000); await refresh;
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter(url => url.includes("/player-data/"))).toHaveLength(2);
    expect(urls.filter(url => url.endsWith("/challenges/config"))).toHaveLength(1);
    expect(urls.filter(url => url.endsWith("/challenges/percentiles"))).toHaveLength(1);
    expect(ops.record).toHaveBeenCalledWith("riot_success");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
    const nextDay = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000); await nextDay;
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/challenges/config"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/challenges/percentiles"))).toHaveLength(2);
  });
  it("공유 DB 캐시 적중은 설정·분포 Riot 호출 없이 player-data만 추가한다", async () => {
    persistence.enabled.mockReturnValue(true);
    const catalog = parseLolChallengeCatalog(challengeConfigFixture, challengePercentilesFixture);
    persistence.catalogRead.mockResolvedValue(catalog);
    const fetchMock = upstream(); vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).challengeProfile).toEqual(buildLolChallengeProfile(challengePlayerFixture, catalog));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/lol/challenges/"))).toHaveLength(1);
    expect(persistence.catalogWrite).not.toHaveBeenCalled();
  });
  it("공유 캐시 miss는 전용 lease로 저장하고 기존 가드·메트릭을 통과한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.acquire.mockImplementation(async (key: string) => ({ key, token: "fixture-token" }));
    const fetchMock = upstream(); vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).challengeProfile?.rarest).toHaveLength(3);
    expect(persistence.catalogWrite).toHaveBeenCalledWith(parseLolChallengeCatalog(challengeConfigFixture, challengePercentilesFixture),
      { key: "challenge-catalog:kr:ko_KR:v1", token: "fixture-token" });
    expect(persistence.reserve).toHaveBeenCalledTimes(8);
    expect(persistence.recordHeaders).toHaveBeenCalledTimes(8);
    expect(persistence.releaseLease).toHaveBeenCalledWith({ key: "challenge-catalog:kr:ko_KR:v1", token: "fixture-token" });
  });
  it.each([403, 429, 500])("player-data %i 실패가 검색 결과를 지우지 않는다", async status => {
    vi.stubGlobal("fetch", upstream(status));
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ matchStatus: "empty", challengeProfile: { status: "failed" } });
  });
  it("config 오류와 DB 오류는 총점·카테고리를 보존하고 분포만 숨긴다", async () => {
    const fetchMock = upstream(200, 500); vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).challengeProfile).toMatchObject({ status: "ready", total: { current: 1234 }, rarest: [], distributionStatus: "unavailable" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/challenges/percentiles"))).toHaveLength(0);
    persistence.enabled.mockReturnValue(true); persistence.catalogRead.mockRejectedValue(new LolPersistenceError());
    const retry = searchLolRiotId("Another#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect((await retry).challengeProfile?.total?.current).toBe(1234);
  });
  it("Content-Length 없는 과대 응답도 본문을 취소하고 도전과제에만 실패를 표시한다", async () => {
    vi.stubGlobal("fetch", upstream(200, 200, true));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ matchStatus: "empty", challengeProfile: { status: "failed" } });
    expect(log.mock.calls.some(([, detail]) => String(detail).includes('"reasonCode":"response_too_large"'))).toBe(true);
  });
  it("일일 캐시를 다른 검색이 갱신 중이면 추가 호출 없이 총점을 표시한다", async () => {
    persistence.enabled.mockReturnValue(true);
    persistence.acquire.mockImplementation(async (key: string) => key.startsWith("challenge-catalog:") ? null : { key, token: "fixture-token" });
    const fetchMock = upstream(); vi.stubGlobal("fetch", fetchMock);
    const pending = searchLolRiotId("Fixture#FIX"); await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).challengeProfile).toMatchObject({ status: "ready", total: { current: 1234 }, rarest: [] });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/challenges/config"))).toHaveLength(0);
  });
});


describe("집계용 Riot 전송 경계", () => {
  it("마스터 전체 명단만 1MB를 초과할 수 있고 공유 호출 가드를 통과한다", async () => {
    persistence.enabled.mockReturnValue(true);
    const payload = { padding: "x".repeat(1024 * 1024) };
    const fetcher = vi.fn(async () => response(payload));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestJson("kr", "/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5", 0, true)).resolves.toEqual(payload);
    expect(persistence.reserve).toHaveBeenCalledWith("kr");
    expect(persistence.start).toHaveBeenCalledOnce();
    expect(internalState?.cache.size).toBe(0);
    await expect(requestJson("kr", "/lol/status/v4/platform-data", 0, true)).rejects.toMatchObject({ kind: "upstream" });
  });
  it("허용 경로도 32MB를 넘는 본문은 읽기 전에 거절한다", async () => {
    persistence.enabled.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 200, { "Content-Length": String(32 * 1024 * 1024 + 1) })));
    await expect(requestJson("kr", "/lol/league/v4/masterleagues/by-queue/RANKED_FLEX_SR", 0, true)).rejects.toMatchObject({ kind: "upstream" });
  });
  it("영속 저장이 꺼져 있어도 TTL 0인 원본 명단은 메모리에 저장하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ entries: [{ puuid: "private-ladder-player" }] })));
    await requestJson("kr", "/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5", 0, true);
    expect(internalState?.cache.size).toBe(0);
  });
});
