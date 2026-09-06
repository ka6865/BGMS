import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateServerClient,
  mockCreateSupabaseAdminClient,
  mockReadPubgCache,
  mockWritePubgCache,
  mockClaimForceRefresh,
  mockReportPubgApiError,
  mockIsPlayerPrivate,
  mockTrackPubgRateLimit,
  mockFetch,
} = vi.hoisted(() => ({
  mockCreateServerClient: vi.fn(),
  mockCreateSupabaseAdminClient: vi.fn(),
  mockReadPubgCache: vi.fn(),
  mockWritePubgCache: vi.fn(),
  mockClaimForceRefresh: vi.fn(),
  mockReportPubgApiError: vi.fn(),
  mockIsPlayerPrivate: vi.fn(),
  mockTrackPubgRateLimit: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: mockCreateServerClient,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateSupabaseAdminClient,
}));

vi.mock("@/lib/pubg/responseCache", () => ({
  buildPlayerCacheKey: (platform: string, nickname: string, season: string | null) => (
    `player:${platform}:${nickname.toLowerCase()}:${season || "current"}`
  ),
  buildPlayerRefreshLockKey: (platform: string, nickname: string) => (
    `refresh:${platform.trim().toLowerCase()}:${nickname.trim().toLowerCase()}`
  ),
  claimForceRefresh: mockClaimForceRefresh,
  readPubgCache: mockReadPubgCache,
  writePubgCache: mockWritePubgCache,
}));

vi.mock("@/lib/pubg-analysis/pubgApiTracker", () => ({
  trackPubgRateLimit: mockTrackPubgRateLimit,
}));

vi.mock("@/lib/pubg/apiHelper", () => ({
  reportPubgApiError: mockReportPubgApiError,
}));

vi.mock("@/lib/pubg/privatePlayers", () => ({
  isPlayerPrivate: mockIsPlayerPrivate,
}));

type QueryResult = { data: unknown; error: unknown };

function queryChain(result: QueryResult) {
  const chain: Record<string, any> = {};
  for (const method of [
    "select",
    "eq",
    "in",
    "order",
    "limit",
    "range",
    "abortSignal",
    "upsert",
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  // Supabase query builders are thenable. Keeping this behavior in the mock
  // catches accidental `await`/chain regressions without making network calls.
  chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => (
    Promise.resolve(result).then(resolve, reject)
  );
  chain.catch = (reject: (reason: unknown) => unknown) => Promise.resolve(result).catch(reject);
  return chain;
}

function configureSupabase(cacheRow: unknown = null) {
  const playerCache = queryChain({ data: cacheRow, error: null });
  const matchModes = queryChain({ data: [], error: null });
  const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "pubg_player_cache") return playerCache;
      if (table === "match_master_telemetry") return matchModes;
      throw new Error(`unexpected Supabase table: ${table}`);
    }),
    rpc,
  };
  mockCreateServerClient.mockResolvedValue(supabase);

  const adminUpsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const adminFrom = vi.fn((table: string) => {
    if (table !== "pubg_player_cache") throw new Error(`unexpected admin table: ${table}`);
    return { upsert: adminUpsert };
  });
  mockCreateSupabaseAdminClient.mockReturnValue({ from: adminFrom });

  return { playerCache, matchModes, rpc, adminUpsert };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/vnd.api+json",
      ...headers,
    },
  });
}

function malformedResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/vnd.api+json",
      ...headers,
    },
  });
}

function statsBucket(overrides: Record<string, unknown> = {}) {
  return {
    roundsPlayed: 12,
    kills: 4,
    assists: 3,
    wins: 1,
    damageDealt: 420,
    dBNOs: 2,
    ...overrides,
  };
}

function playerPayload() {
  return {
    data: [{
      id: "account-fixture-1",
      attributes: { name: "Fixture_Player", banType: "None", clanId: null },
      relationships: { matches: { data: [] } },
    }],
  };
}

function seasonsPayload() {
  return {
    data: [{
      id: "pc-2026-01",
      name: "Season 1",
      attributes: { isCurrentSeason: true },
    }, {
      id: "pc-2025-99",
      name: "Season 99",
      attributes: { isCurrentSeason: false },
    }],
  };
}

function rankedPayload(kills = 8) {
  return {
    data: {
      attributes: {
        rankedGameModeStats: {
          "solo-fpp": statsBucket({ kills }),
          "duo-fpp": statsBucket({ kills: 2 }),
          "squad-fpp": statsBucket({ kills: 3 }),
        },
      },
    },
  };
}

function normalPayload(kills = 5) {
  return {
    data: {
      attributes: {
        gameModeStats: {
          "solo-fpp": statsBucket({ kills }),
          "duo-fpp": statsBucket({ kills: 2 }),
          "squad-fpp": statsBucket({ kills: 3 }),
        },
      },
    },
  };
}

function cachedModeBuckets(kills = 1) {
  return {
    solo: statsBucket({ kills }),
    duo: statsBucket({ kills: 2 }),
    squad: statsBucket({ kills: 3 }),
  };
}

type FetchPlan = Partial<Record<
  "player" | "seasons" | "season" | "ranked" | "mastery",
  Array<Response | Error>
>>;

type FetchCall = { url: string; init?: RequestInit };

function classifyFetch(url: string): keyof FetchPlan {
  if (url.includes("/survival_mastery")) return "mastery";
  // URLSearchParams encodes square brackets in the actual route URL.
  if (url.includes("/players?") && (
    url.includes("filter[playerNames]=") || url.includes("filter%5BplayerNames%5D=")
  )) return "player";
  if (url.endsWith("/seasons")) return "seasons";
  if (url.endsWith("/ranked")) return "ranked";
  if (/\/seasons\/[^/]+$/.test(url)) return "season";
  throw new Error(`unexpected PUBG URL: ${url}`);
}

function installFetch(plan: FetchPlan): FetchCall[] {
  const calls: FetchCall[] = [];
  const queues = new Map<string, Array<Response | Error>>(
    Object.entries(plan).map(([key, values]) => [key, [...(values || [])]]),
  );
  mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = classifyFetch(url);
    const next = queues.get(key)?.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    throw new Error(`no fixture for ${key}: ${url}`);
  });
  return calls;
}

function request(url = "http://localhost/api/pubg/player?nickname=Fixture_Player&platform=steam", signal?: AbortSignal) {
  return new Request(url, { signal });
}

function playerCalls(calls: FetchCall[]) {
  return calls.filter((call) => call.url.includes("/players?") && (
    call.url.includes("filter[playerNames]=") || call.url.includes("filter%5BplayerNames%5D=")
  ));
}

function staleCacheRow(normal: unknown = cachedModeBuckets(1)) {
  return {
    id: "account-fixture-1",
    nickname: "Fixture_Player",
    lower_nickname: "fixture_player",
    platform: "steam",
    seasons_list: seasonsPayload().data,
    last_season_id: "pc-2026-01",
    season_stats_data: {
      "pc-2026-01": {
        ranked: rankedPayload(1).data.attributes.rankedGameModeStats,
        normal,
      },
    },
    recent_match_ids: [],
    clan_data: null,
    survival_mastery_data: null,
    survival_mastery_updated_at: "2026-08-01T00:00:00.000Z",
    weapon_mastery_data: [],
    ban_type: "None",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

async function loadRoute() {
  vi.resetModules();
  return import("../app/api/pubg/player/route");
}

describe("player route recovery contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBG_API_KEY", "fixture-api-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-role");
    mockReadPubgCache.mockResolvedValue(null);
    mockWritePubgCache.mockResolvedValue(undefined);
    mockClaimForceRefresh.mockResolvedValue(true);
    mockReportPubgApiError.mockResolvedValue(undefined);
    mockIsPlayerPrivate.mockResolvedValue(false);
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ["empty", malformedResponse("", 200)],
    ["truncated", malformedResponse('{"data":[', 200)],
  ])("recovers one transient %s player payload and writes only the complete response", async (_label, invalidFirst) => {
    const { adminUpsert } = configureSupabase();
    const calls = installFetch({
      player: [invalidFirst, jsonResponse(playerPayload())],
      seasons: [jsonResponse(seasonsPayload())],
      season: [jsonResponse(normalPayload())],
      ranked: [jsonResponse(rankedPayload(8))],
      mastery: [jsonResponse({}, 404)],
    });
    const route = await loadRoute();

    const response = await route.GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nickname).toBe("Fixture_Player");
    expect(body.stats.ranked.solo).toMatchObject({ kills: 8 });
    expect(body.stats.normal.solo).toMatchObject({ kills: 5 });
    expect(body.statsAvailability).toMatchObject({
      ranked: { status: "ready" },
      normal: { status: "ready" },
    });
    expect(body.updatedAt).toEqual(expect.any(String));
    expect(playerCalls(calls)).toHaveLength(2);
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
    expect(adminUpsert).toHaveBeenCalledTimes(1);
    expect(adminUpsert.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      updated_at: expect.any(String),
      season_stats_data: expect.any(Object),
    }));
    expect(mockWritePubgCache).toHaveBeenCalledTimes(1);
    expect(mockWritePubgCache.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      updatedAt: body.updatedAt,
    }));
  });

  it("returns 503 for a repeated malformed player payload instead of misclassifying it as not found", async () => {
    const { adminUpsert } = configureSupabase();
    installFetch({
      player: [malformedResponse('{"data":[', 200), malformedResponse('{"data":', 200)],
    });
    const route = await loadRoute();

    const response = await route.GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(body.code).not.toBe("PLAYER_NOT_FOUND");
    expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
      route: "/api/pubg/player",
      status: 503,
    }));
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });

  it("returns ranked data with stale normal fallback and never overwrites either cache on partial stats", async () => {
    const cacheRow = staleCacheRow();
    const { adminUpsert } = configureSupabase(cacheRow);
    const calls = installFetch({
      player: [jsonResponse(playerPayload())],
      seasons: [jsonResponse(seasonsPayload())],
      season: [jsonResponse({ error: "normal unavailable" }, 503)],
      ranked: [jsonResponse(rankedPayload(9))],
      mastery: [jsonResponse({}, 404)],
    });
    const route = await loadRoute();

    const response = await route.GET(request(
      "http://localhost/api/pubg/player?nickname=Fixture_Player&platform=steam&refresh=true",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats.ranked.solo).toMatchObject({ kills: 9 });
    expect(body.stats.normal.solo).toMatchObject({ kills: 1 });
    expect(body.statsAvailability.ranked).toMatchObject({ status: "ready" });
    expect(body.statsAvailability.normal).toMatchObject({
      status: "stale",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(playerCalls(calls)).toHaveLength(1);
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });

  it("returns unavailable normal stats when no cached normal bucket exists and still does not write partial data", async () => {
    const { adminUpsert } = configureSupabase();
    installFetch({
      player: [jsonResponse(playerPayload())],
      seasons: [jsonResponse(seasonsPayload())],
      season: [jsonResponse({ error: "normal unavailable" }, 503)],
      ranked: [jsonResponse(rankedPayload(9))],
      mastery: [jsonResponse({}, 404)],
    });
    const route = await loadRoute();

    const response = await route.GET(request(
      "http://localhost/api/pubg/player?nickname=Fixture_Player&platform=steam&refresh=true",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats.ranked.solo).toMatchObject({ kills: 9 });
    expect(body.stats.normal).toBeNull();
    expect(body.statsAvailability.normal).toMatchObject({ status: "unavailable" });
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });

  it("keeps an explicitly requested season on stats failure and never probes another season", async () => {
    const { adminUpsert } = configureSupabase(staleCacheRow());
    const calls = installFetch({
      player: [jsonResponse(playerPayload())],
      seasons: [jsonResponse(seasonsPayload())],
      season: [jsonResponse({ error: "explicit season unavailable" }, 503)],
      ranked: [jsonResponse({ error: "explicit season unavailable" }, 503)],
      mastery: [jsonResponse({}, 404)],
    });
    const route = await loadRoute();
    const explicitSeason = "pc-2026-explicit";

    const response = await route.GET(request(
      `http://localhost/api/pubg/player?nickname=Fixture_Player&platform=steam&season=${explicitSeason}&refresh=true`,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.seasonId).toBe(explicitSeason);
    expect(body.statsAvailability.ranked).toMatchObject({ status: "unavailable" });
    expect(body.statsAvailability.normal).toMatchObject({ status: "unavailable" });
    expect(calls.some(({ url }) => url.includes("/seasons/pc-2026-01"))).toBe(false);
    expect(calls.some(({ url }) => url.includes("/seasons/pc-2025-99"))).toBe(false);
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });

  it("preserves the player-not-found contract for a genuine 404 identity response", async () => {
    const { adminUpsert, rpc } = configureSupabase();
    installFetch({
      player: [jsonResponse({ errors: [{ status: "404", title: "Not Found" }] }, 404)],
    });
    const route = await loadRoute();

    const response = await route.GET(request());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual(expect.objectContaining({ code: "PLAYER_NOT_FOUND" }));
    expect(rpc).toHaveBeenCalledWith("suggest_similar_players", expect.any(Object));
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });

  it("returns Retry-After seconds for a player rate-limit response", async () => {
    const { adminUpsert } = configureSupabase();
    installFetch({
      player: [jsonResponse({ errors: [{ status: "429", title: "Too Many Requests" }] }, 429, {
        "retry-after": "37",
      })],
    });
    const route = await loadRoute();

    const response = await route.GET(request());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(body).toEqual(expect.objectContaining({
      code: "PLAYER_RATE_LIMITED",
      retryable: true,
    }));
    expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
      status: 429,
      context: expect.objectContaining({ upstreamStatus: 429 }),
    }));
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });

  it("propagates a client abort to the in-flight upstream request and leaves caches untouched", async () => {
    const { adminUpsert } = configureSupabase();
    let upstreamSignal: AbortSignal | null | undefined;
    mockFetch.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      if (upstreamSignal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    });
    const route = await loadRoute();
    const controller = new AbortController();
    const responsePromise = route.GET(request(undefined, controller.signal));

    for (let attempt = 0; attempt < 30 && !upstreamSignal; attempt += 1) {
      await Promise.resolve();
    }
    expect(upstreamSignal).toBeDefined();
    controller.abort();
    const response = await responsePromise;

    expect(upstreamSignal?.aborted).toBe(true);
    expect([499, 503]).toContain(response.status);
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(mockWritePubgCache).not.toHaveBeenCalled();
  });
});
