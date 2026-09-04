import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_CACHE_VERSION, RESULT_VERSION } from "@/lib/pubg-analysis/constants";

const {
  mockWithAuthGuard,
  mockGetSquadAnalysisData,
  mockGenerateContent,
  mockGetGenerativeModel,
  MockGoogleGenerativeAI,
} = vi.hoisted(() => {
  const mockWithAuthGuard = vi.fn();
  const mockGetSquadAnalysisData = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn(() => ({ generateContent: mockGenerateContent }));
  class MockGoogleGenerativeAI {
    constructor(public apiKey: string) {}
    getGenerativeModel = mockGetGenerativeModel;
  }
  return { mockWithAuthGuard, mockGetSquadAnalysisData, mockGenerateContent, mockGetGenerativeModel, MockGoogleGenerativeAI };
});

vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mockWithAuthGuard }));
vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({ getSquadAnalysisData: mockGetSquadAnalysisData }));
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
  SchemaType: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY" },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "harassment",
    HARM_CATEGORY_HATE_SPEECH: "hate",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "sexual",
    HARM_CATEGORY_DANGEROUS_CONTENT: "dangerous",
  },
  HarmBlockThreshold: { BLOCK_NONE: "none" },
}));
vi.mock("@/lib/pubg-analysis/aiUsageTracker", () => ({
  trackAiFailure: vi.fn(),
  trackAiUsage: vi.fn(),
}));

import { POST as aiSquadPOST } from "@/app/api/pubg/ai-squad/route";
import { POST as aiAnalyzePOST } from "@/app/api/pubg/ai-analyze/route";

function queryChain(result: any) {
  const chain: any = {};
  for (const method of ["select", "eq", "upsert", "abortSignal"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: any) => Promise.resolve(result).catch(reject);
  return chain;
}

function request(body: unknown, signal?: AbortSignal) {
  return new Request("http://localhost/api/pubg/ai-squad", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const canonicalSquadData = {
  groupKey: "Beta",
  matchCount: 2,
  latestMatchCount: 2,
  bestMatchCount: 2,
  selectedMatchIds: ["match-2", "match-1"],
  matchesSummary: [
    { matchId: "match-2", mapName: "Baltic_Main", winPlace: 2, createdAt: "2026-09-01T00:00:00.000Z" },
    { matchId: "match-1", mapName: "Baltic_Main", winPlace: 4, createdAt: "2026-08-31T00:00:00.000Z" },
  ],
  stats: {
    avgIsolation: 1.1,
    avgTradeLatency: 7000,
    totalSmokeRescues: 1,
    totalRevives: 2,
    avgCoverRate: 0.5,
    totalTeamWipes: 1,
    totalTeammateKnocks: 2,
  },
  scores: { formation: 90, backupSpeed: 85, survivalCare: 80, focusFire: 90, teamWipe: 75 },
  squadGrade: "A",
  roleProfiles: [{
    name: "Player_A", role: "메인 딜러", roleDesc: "측정", avgDamage: 321,
    avgKills: 2, avgAssists: 1, avgDbnos: 1,
    shares: { damage: 60, kill: 50, assist: 50, dbno: 50 },
  }, { name: "Beta", role: "지원가", roleDesc: "측정", avgDamage: 200, avgKills: 1, avgAssists: 1, avgDbnos: 1, shares: { damage: 40, kill: 50, assist: 50, dbno: 50 } }],
  benchmarkStats: { tier: "A", avgIsolation: 1.3, avgTradeLatency: 9000, avgReviveRate: 20, avgSmokeRate: 10, avgTeamWipes: 2 },
};

function configuredSupabase(cacheResult: any = { data: null, error: null }) {
  const cache = queryChain(cacheResult);
  return {
    cache,
    supabase: { from: vi.fn((table: string) => {
      if (table !== "squad_ai_coaching_cache") throw new Error(`unexpected table ${table}`);
      return cache;
    }) },
  };
}

function configuredAnalyzeSupabase(cacheResult: any, canonicalResult: any) {
  const cache = queryChain(cacheResult);
  const telemetry = queryChain(canonicalResult);
  return {
    cache,
    telemetry,
    supabase: { from: vi.fn((table: string) => {
      if (table === "match_ai_coaching_cache") return cache;
      if (table === "processed_match_telemetry") return telemetry;
      throw new Error(`unexpected table ${table}`);
    }) },
  };
}

describe("AI squad release blockers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    process.env.GOOGLE_GEMINI_API_KEY = "test-key";
    mockGetSquadAnalysisData.mockResolvedValue(canonicalSquadData);
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" } });
    mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ squadGrade: "A" }), usageMetadata: {} } });
  });

  it("ignores forged client numbers in both prompt and cache identity", async () => {
    const first = configuredSupabase();
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: first.supabase });
    let firstPrompt = "";
    mockGenerateContent.mockImplementation(async (payload: any) => {
      firstPrompt = JSON.stringify(payload);
      return { response: { text: () => JSON.stringify({ squadGrade: "A" }), usageMetadata: {} } };
    });
    const forged = {
      groupKey: "Beta",
      nickname: "Player_A",
      platform: "steam",
      coachingStyle: "spicy",
      stats: { avgIsolation: 9999, avgTradeLatency: 9999, avgCoverRate: 0.01 },
      scores: { formation: 1 },
      roleProfiles: [{ name: "Attacker", avgDamage: 9999 }],
      benchmarkStats: { avgIsolation: 9999 },
      squadGrade: "S+",
    };
    const response = await aiSquadPOST(request(forged));
    expect(response.status).toBe(200);
    expect(firstPrompt).toContain("321");
    expect(firstPrompt).not.toContain("9999");
    const firstHash = first.cache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    expect(firstHash).toBeTruthy();

    const second = configuredSupabase();
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: second.supabase });
    await aiSquadPOST(request({ ...forged, stats: { avgIsolation: -777, avgTradeLatency: 123456 } }));
    expect(second.cache.upsert.mock.calls[0]?.[0]?.match_ids_hash).toBe(firstHash);
    expect(second.cache.eq).toHaveBeenCalledWith("prompt_version", AI_CACHE_VERSION);
  });

  it("fails closed when canonical squad analysis is unavailable", async () => {
    const { supabase, cache } = configuredSupabase();
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    mockGetSquadAnalysisData.mockResolvedValue(null);

    const response = await aiSquadPOST(request({ groupKey: "Beta", nickname: "Player_A", platform: "steam" }));
    expect(response.status).toBe(409);
    expect((await response.json()).errorCode).toBe("PUBG_AI_SQUAD_CANONICAL_NOT_READY");
    expect(cache.select).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("does not return a pre-marker single-match cache answer", async () => {
    const oldCanonicalRow = {
      match_id: "match-old",
      player_id: "player_a",
      platform: "steam",
      data: {
        fullResult: {
          matchId: "match-old",
          player_id: "player_a",
          platform: "steam",
          v: RESULT_VERSION,
          stats: { name: "Player_A", kills: 3 },
        },
      },
    };
    const { supabase, cache, telemetry } = configuredAnalyzeSupabase(
      { data: { ai_result: { text: "old cached answer" } }, error: null },
      { data: oldCanonicalRow, error: null },
    );
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(request({
      matchData: { matchId: "match-old", stats: { kills: 9999 } },
      nickname: "Player_A",
      platform: "steam",
      coachingStyle: "spicy",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(telemetry.select).toHaveBeenCalled();
    expect(cache.select).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("stops fallback attempts at the overall deadline and writes no cache", async () => {
    vi.useFakeTimers();
    const { supabase, cache } = configuredSupabase();
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    let providerSignal: AbortSignal | undefined;
    mockGenerateContent.mockImplementation((_payload: unknown, options: { signal?: AbortSignal }) => {
      providerSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    const responsePromise = aiSquadPOST(request({ groupKey: "Beta", nickname: "Player_A", platform: "steam" }));
    for (let index = 0; index < 50 && mockGenerateContent.mock.calls.length < 1; index += 1) await Promise.resolve();
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(22_100);
    const response = await responsePromise;

    expect(providerSignal?.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(mockGetGenerativeModel).toHaveBeenCalledTimes(3);
    expect(cache.upsert).not.toHaveBeenCalled();
  });

  it("fails a request that is already aborted before starting any provider or cache write", async () => {
    const { supabase, cache } = configuredSupabase();
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const controller = new AbortController();
    controller.abort();

    const response = await aiSquadPOST(request({
      groupKey: "Beta",
      nickname: "Player_A",
      platform: "steam",
      coachingStyle: "spicy",
    }, controller.signal));

    expect([503, 504]).toContain(response.status);
    expect(await response.json()).toMatchObject({
      errorCode: "PUBG_AI_SQUAD_ABORTED",
      retryable: true,
    });
    expect(mockGetGenerativeModel).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(cache.upsert).not.toHaveBeenCalled();
  });

  it("does not enter cache after aborting while canonical squad analysis is pending", async () => {
    const { supabase, cache } = configuredSupabase({
      data: { ai_result: { text: "stale cached answer" } },
      error: null,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const canonicalDeferred = deferred<typeof canonicalSquadData>();
    mockGetSquadAnalysisData.mockReturnValue(canonicalDeferred.promise);
    const controller = new AbortController();
    const responsePromise = aiSquadPOST(request({
      groupKey: "Beta",
      nickname: "Player_A",
      platform: "steam",
    }, controller.signal));
    for (let index = 0; index < 20 && !mockGetSquadAnalysisData.mock.calls.length; index += 1) await Promise.resolve();

    controller.abort();
    canonicalDeferred.resolve(canonicalSquadData);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "PUBG_AI_SQUAD_ABORTED",
      retryable: true,
    });
    expect(cache.select).not.toHaveBeenCalled();
    expect(cache.upsert).not.toHaveBeenCalled();
    expect(mockGetGenerativeModel).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("does not return a cache hit when aborting while cache lookup is pending", async () => {
    const { supabase, cache } = configuredSupabase();
    const cacheDeferred = deferred<{ data: { ai_result: { text: string } } | null; error: null }>();
    cache.maybeSingle.mockReturnValue(cacheDeferred.promise);
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    mockGetSquadAnalysisData.mockResolvedValue(canonicalSquadData);
    const controller = new AbortController();
    const pendingRequest = request({
      groupKey: "Beta",
      nickname: "Player_A",
      platform: "steam",
    }, controller.signal);
    const responsePromise = aiSquadPOST(pendingRequest);
    for (let index = 0; index < 20 && !cache.maybeSingle.mock.calls.length; index += 1) await Promise.resolve();
    expect(cache.maybeSingle).toHaveBeenCalledTimes(1);

    controller.abort();
    cacheDeferred.resolve({ data: { ai_result: { text: "stale cached answer" } }, error: null });
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "PUBG_AI_SQUAD_ABORTED",
      retryable: true,
    });
    expect(cache.abortSignal).toHaveBeenCalledTimes(1);
    expect(cache.abortSignal.mock.calls[0][0]).toBe(pendingRequest.signal);
    expect(cache.upsert).not.toHaveBeenCalled();
    expect(mockGetGenerativeModel).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("returns an explicitly retryable 503 after immediate provider errors", async () => {
    const { supabase } = configuredSupabase();
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    mockGenerateContent.mockRejectedValue(new Error("provider unavailable"));

    const response = await aiSquadPOST(request({ groupKey: "Beta", nickname: "Player_A", platform: "steam" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "PUBG_AI_SQUAD_PROVIDER_ERROR",
      retryable: true,
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(4);
    expect(mockGetGenerativeModel).toHaveBeenCalledTimes(4);
  });
});
