import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { POST as aiAnalyzePOST } from "../app/api/pubg/ai-analyze/route";
import { POST as aiSummaryPOST } from "../app/api/pubg/ai-summary/route";
import { POST as aiSquadPOST } from "../app/api/pubg/ai-squad/route";
import { AI_CACHE_VERSION, AI_SUMMARY_CACHE_VERSION, POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";
import { fetchTierBenchmarkStats } from "../lib/pubg-analysis/benchmarkLookup";
import {
  buildBestMatchSelectionKey,
  buildMatchSelectionKey,
  RECENT_MATCH_SELECTION_VERSION,
} from "../lib/pubg-analysis/recentMatchSelection";
import { AI_CACHE_RETENTION_DAYS, AI_CACHE_TABLES, cleanupExpiredCache } from "../scripts/cleanup_ai_cache";
import crypto from "node:crypto";

const {
  mockWithAuthGuard,
  mockTrackAiUsage,
  mockTrackAiFailure,
  mockGetSquadAnalysisData,
  mockGenerateContentStream,
  mockGenerateContent,
  MockGoogleGenerativeAI,
} = vi.hoisted(() => {
  const mockWithAuthGuard = vi.fn();
  const mockTrackAiUsage = vi.fn();
  const mockTrackAiFailure = vi.fn();
  const mockGetSquadAnalysisData = vi.fn();
  const mockGenerateContentStream = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn(() => ({
    generateContentStream: mockGenerateContentStream,
    generateContent: mockGenerateContent,
  }));

  class MockGoogleGenerativeAI {
    apiKey: string;

    constructor(apiKey: string) {
      this.apiKey = apiKey;
    }

    getGenerativeModel = mockGetGenerativeModel;
  }

  return {
    mockWithAuthGuard,
    mockTrackAiUsage,
    mockTrackAiFailure,
    mockGetSquadAnalysisData,
    mockGenerateContentStream,
    mockGenerateContent,
    MockGoogleGenerativeAI,
  };
});

vi.mock("@/utils/supabase/guard", () => ({
  withAuthGuard: mockWithAuthGuard,
}));

vi.mock("@/lib/pubg-analysis/aiUsageTracker", () => ({
  trackAiUsage: mockTrackAiUsage,
  trackAiFailure: mockTrackAiFailure,
}));

vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({
  getSquadAnalysisData: mockGetSquadAnalysisData,
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
  SchemaType: {
    OBJECT: "OBJECT",
    STRING: "STRING",
    ARRAY: "ARRAY",
  },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
  HarmBlockThreshold: {
    BLOCK_NONE: "BLOCK_NONE",
  },
}));

function createQueryChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  const createMutationBuilder = () => {
    const mutationBuilder: any = {};
    const mutationPromise = Promise.resolve(result);
    mutationBuilder.abortSignal = vi.fn().mockReturnValue(mutationBuilder);
    mutationBuilder.then = mutationPromise.then.bind(mutationPromise);
    mutationBuilder.catch = mutationPromise.catch.bind(mutationPromise);
    mutationBuilder.finally = mutationPromise.finally.bind(mutationPromise);
    return mutationBuilder;
  };
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.or = vi.fn().mockResolvedValue(result);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.abortSignal = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.upsert = vi.fn().mockImplementation(() => createMutationBuilder());
  return chain;
}

function createSupabaseMock(tables: Record<string, any>) {
  return {
    from: vi.fn((table: string) => {
      const chain = tables[table];
      if (!chain) throw new Error(`Unexpected table access: ${table}`);
      return chain;
    }),
  };
}

function createRequest(body: any, extraHeaders: Record<string, string> = {}) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function createAbortableRequest(body: any, signal: AbortSignal) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function createSummaryMatch(matchId = "match-1", overrides: Record<string, any> = {}) {
  return {
    matchId,
    player_id: "player_a",
    platform: "kakao",
    v: RESULT_VERSION,
    populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
    createdAt: "2026-06-01T00:00:00.000Z",
    mapName: "Baltic_Main",
    gameMode: "squad",
    matchType: "competitive",
    totalTeams: 16,
    stats: {
      name: "Player_A",
      kills: 2,
      assists: 1,
      DBNOs: 1,
      damageDealt: 320,
      processedDamageDealt: 320,
      winPlace: 4,
      timeSurvived: 1200,
    },
    benchmark: {
      score: 77,
      breakdown: { combat: 78, tactical: 72, survival: 80 },
    },
    tradeStats: {
      teammateKnocks: 1,
      tradeKills: 1,
      suppCount: 1,
      revCount: 1,
      smokeCount: 1,
      smokeRescues: 1,
      reactionLatencyMs: 600,
      tradeLatencyMs: 9000,
    },
    combatPressure: {
      pressureIndex: 2.4,
      utilityStats: { throwCount: 1, hitCount: 1, totalDamage: 40, killCount: 0 },
    },
    teamImpact: { damageImpact: 110, killImpact: 100, teamDamageShare: 40, teamKillShare: 35 },
    duelStats: { wins: 2, losses: 1, reversals: 1, reversalAttempts: 1, duelWinRate: 67 },
    isolationData: { isolationIndex: 1.4, combatIsolation: 1.2, deathIsolation: 1.0, minDist: 12, heightDiff: 3, teammateCount: 3 },
    itemUseSummary: { smokes: 1 },
    itemUseStats: { distanceDamage: { short: 100, mid: 150, long: 70 } },
    goldenTimeDamage: { early: 100, mid1: 120, mid2: 80, late: 20 },
    killContribution: { solo: 1, cleanup: 1, assist: 0 },
    ...overrides,
  };
}

function createValidSummaryFinal(overrides: Record<string, any> = {}): any {
  const issue = (topic: string, extra: Record<string, any> = {}) => ({
    topic,
    question: `${topic}이 충분한가?`,
    spicyOpinion: "수치 기준으로 보완할 지점이 있습니다.",
    kindOpinion: "수치 기준으로 강점을 확인할 수 있습니다.",
    winner: "kind",
    reason: "검증 데이터",
    evaluation: "정상",
    userStats: [],
    benchmarkStats: [],
    ...extra,
  });
  return {
    signature: "테스트 전술가",
    signatureSub: "캐시 안정화 테스트 응답",
    finalVerdict: "검증용 최종 판정입니다.",
    debateIssues: [
      issue("전투력", {
        userStats: [{ label: "평균 화력", value: "320" }],
        benchmarkStats: [{ label: "상위권 평균 화력", value: "300" }],
      }),
      issue("교전 주도권", {
        userStats: [{ label: "주도권 성공률", value: "70%" }],
        benchmarkStats: [{ label: "상위권 선제 공격 성공률", value: "61%" }],
      }),
      issue("1:1 결정력", {
        userStats: [{ label: "1:1 교전 승률", value: "79%" }],
        benchmarkStats: [{ label: "상위권 1:1 승률", value: "61%" }],
      }),
    ],
    actionItems: [{ icon: "target", title: "검증", desc: "테스트 유지" }],
    ...overrides,
  };
}

function createCanonicalAnalyzeRow(
  matchId = "match-1",
  overrides: Record<string, any> = {},
) {
  const fullResult = {
    ...createSummaryMatch(matchId),
    matchId,
    player_id: "player_a",
    platform: "kakao",
    v: RESULT_VERSION,
    ...overrides,
  };
  return {
    match_id: matchId,
    player_id: "player_a",
    platform: "kakao",
    data: { fullResult },
  };
}

const canonicalSquadAnalysis = {
  groupKey: "alpha,beta",
  matchCount: 2,
  latestMatchCount: 2,
  bestMatchCount: 2,
  selectedMatchIds: ["match-2", "match-1"],
  matchesSummary: [
    { matchId: "match-2", mapName: "Baltic_Main", winPlace: 2, createdAt: "2026-09-01T00:00:00.000Z" },
    { matchId: "match-1", mapName: "Baltic_Main", winPlace: 4, createdAt: "2026-08-31T00:00:00.000Z" },
  ],
  stats: {
    avgIsolation: 1.5,
    avgTradeLatency: 8000,
    totalSmokeRescues: 2,
    totalRevives: 3,
    avgCoverRate: 0.45,
    totalTeamWipes: 1,
    totalTeammateKnocks: 2,
  },
  scores: { formation: 70, backupSpeed: 75, survivalCare: 80, focusFire: 76, teamWipe: 65 },
  squadGrade: "A",
  roleProfiles: [
    { name: "Player_A", role: "Entry", roleDesc: "진입", avgDamage: 300, avgKills: 2, avgAssists: 1, avgDbnos: 1, shares: { damage: 55, kill: 50, assist: 30, dbno: 50 } },
    { name: "Beta", role: "Support", roleDesc: "지원", avgDamage: 180, avgKills: 1, avgAssists: 2, avgDbnos: 1, shares: { damage: 45, kill: 50, assist: 70, dbno: 50 } },
  ],
  benchmarkStats: { tier: "A", avgIsolation: 1.36, avgTradeLatency: 12143, avgReviveRate: 17, avgSmokeRate: 3.58, avgTeamWipes: 5.33 },
};

function mockSummaryGeminiResponse(assertPrompt?: (prompt: string) => void) {
  const json = JSON.stringify(createValidSummaryFinal());

  mockGenerateContentStream.mockImplementation(async (prompt: string) => {
    assertPrompt?.(prompt);
    return {
    stream: (async function* () {
      yield { text: () => json };
    })(),
    response: Promise.resolve({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    }),
    };
  });
}

function mockSummaryGeminiRawText(text: string, assertPrompt?: (prompt: string) => void) {
  mockGenerateContentStream.mockImplementation(async (prompt: string) => {
    assertPrompt?.(prompt);
    return {
    stream: (async function* () {
      yield { text: () => text };
    })(),
    response: Promise.resolve({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    }),
    };
  });
}

function configureSummaryCacheHitForHash(
  summaryCache: any,
  expectedHash: string,
  aiResult: any = {
    visuals: { overallTier: "C" },
    final: JSON.stringify(createValidSummaryFinal({ finalVerdict: "cached" })),
  },
) {
  summaryCache.maybeSingle.mockImplementation(async () => {
    const hashCalls = summaryCache.eq.mock.calls
      .filter(([column]: [string]) => column === "match_ids_hash");
    const requestedHash = hashCalls.at(-1)?.[1];
    return requestedHash === expectedHash
      ? { data: { ai_result: aiResult }, error: null }
      : { data: null, error: null };
  });
}

function parseSummaryNdjson(text: string): Array<{ type: string; data?: any; [key: string]: any }> {
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function mockSquadGeminiJson(json: any) {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => JSON.stringify(json),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    },
  });
}

describe("AI cache route stabilization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_GEMINI_API_KEY = "test-gemini-key";
    mockWithAuthGuard.mockResolvedValue({
      user: { id: "user-1" },
      supabaseAdmin: createSupabaseMock({}),
    });
    mockGetSquadAnalysisData.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("ai-analyze는 match_id뿐 아니라 player_id, platform, prompt_version으로 캐시를 조회한다", async () => {
    const matchCache = createQueryChain({
      data: { ai_result: { text: "cached-player-a-analysis" } },
      error: null,
    });
    const telemetry = createQueryChain({
      data: createCanonicalAnalyzeRow("match-a"),
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "spicy",
      matchData: {
        matchId: "match-a",
        stats: { kills: 1, assists: 0, DBNOs: 1, damageDealt: 100, winPlace: 10, timeSurvived: 600 },
      },
    }));
    const text = await response.text();

    expect(text).toContain("cached-player-a-analysis");
    expect(matchCache.eq).toHaveBeenCalledWith("match_id", "match-a");
    expect(matchCache.eq).toHaveBeenCalledWith("platform", "kakao");
    expect(matchCache.eq).toHaveBeenCalledWith("player_id", "player_a");
    expect(matchCache.eq).toHaveBeenCalledWith("coaching_style", "spicy");
    expect(matchCache.eq).toHaveBeenCalledWith("prompt_version", AI_CACHE_VERSION);
    expect(telemetry.select).toHaveBeenCalledWith("match_id,player_id,platform,data");
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-analyze는 캐시된 단일 경기 코칭의 과한 표현을 순화해서 반환한다", async () => {
    const matchCache = createQueryChain({
      data: { ai_result: { text: "혼자 다 해먹는 화력이고 팀 지원 지표가 바닥입니다." } },
      error: null,
    });
    const telemetry = createQueryChain({
      data: createCanonicalAnalyzeRow("match-sanitize-cache"),
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "spicy",
      matchData: {
        matchId: "match-sanitize-cache",
        stats: { kills: 1, assists: 0, DBNOs: 1, damageDealt: 100, winPlace: 10, timeSurvived: 600 },
      },
    }));
    const text = await response.text();

    expect(text).toContain("강한 화력을 보여주는");
    expect(text).toContain("팀 지원 지표 보완이 필요");
    expect(text).not.toContain("혼자 다 해먹");
    expect(text).not.toContain("팀 지원 지표가 바닥");
  });

  it("ai-analyze는 신규 Gemini 단일 경기 코칭도 순화한 뒤 캐시에 저장한다", async () => {
    mockSummaryGeminiRawText("혼자 다 해먹는 화력이고 팀 지원 지표가 바닥이며 22.4초는 느린 백업입니다.");

    const matchCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: createCanonicalAnalyzeRow("match-sanitize-new", {
        mapName: "Baltic_Main",
        gameMode: "squad",
        stats: {
          name: "Player_A",
          kills: 1,
          assists: 0,
          DBNOs: 1,
          damageDealt: 100,
          processedDamageDealt: 100,
          winPlace: 10,
          timeSurvived: 600,
        },
        tradeStats: {
          teammateKnocks: 1,
          tradeKills: 0,
          revCount: 0,
          smokeRescues: 0,
          tradeLatencyMs: 22400,
        },
        combatPressure: {
          utilityStats: { throwCount: 0, lethalThrowCount: 0, hitCount: 0, totalDamage: 0 },
        },
        teamImpact: {},
      }),
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "spicy",
      matchData: {
        matchId: "match-sanitize-new",
        mapName: "Baltic_Main",
        gameMode: "squad",
        stats: {
          name: "Player_A",
          kills: 1,
          assists: 0,
          DBNOs: 1,
          damageDealt: 100,
          processedDamageDealt: 100,
          winPlace: 10,
          timeSurvived: 600,
        },
        tradeStats: {
          teammateKnocks: 1,
          tradeKills: 0,
          revCount: 0,
          smokeRescues: 0,
          tradeLatencyMs: 22400,
        },
        combatPressure: {
          utilityStats: { throwCount: 0, lethalThrowCount: 0, hitCount: 0, totalDamage: 0 },
        },
        teamImpact: {},
      },
    }));
    const text = await response.text();
    const upsertPayload = matchCache.upsert.mock.calls[0]?.[0];

    expect(text).toContain("강한 화력을 보여주는");
    expect(text).toContain("팀 지원 지표 보완이 필요");
    expect(text).toContain("백업 지연 위험");
    expect(text).not.toContain("혼자 다 해먹");
    expect(text).not.toContain("팀 지원 지표가 바닥");
    expect(text).not.toContain("느린 백업");
    expect(upsertPayload.ai_result.text).toContain("강한 화력을 보여주는");
    expect(upsertPayload.ai_result.text).toContain("백업 지연 위험");
    expect(upsertPayload.ai_result.text).not.toContain("혼자 다 해먹");
  });

  it("ai-analyze는 부모 요청이 stream 중단을 알리면 partial 결과를 캐시에 저장하지 않는다", async () => {
    const matchCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: createCanonicalAnalyzeRow("match-analyze-abort"),
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const parentController = new AbortController();
    let requestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
    let resolveSecondNext: ((value: IteratorResult<any>) => void) | undefined;
    const iterator = {
      next: vi.fn()
        .mockResolvedValueOnce({ done: false, value: { text: () => "partial coaching" } })
        .mockImplementationOnce(() => new Promise<IteratorResult<any>>((resolve) => {
          resolveSecondNext = resolve;
        })),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    mockGenerateContentStream.mockImplementation(async (
      _prompt: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ) => {
      requestOptions = options;
      return {
        stream: iterator,
        response: Promise.resolve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }),
      };
    });

    const response = await aiAnalyzePOST(createAbortableRequest({
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "spicy",
      matchData: { matchId: "match-analyze-abort" },
    }, parentController.signal));
    const bodyPromise = response.text().catch(() => "");

    for (let index = 0; index < 100 && iterator.next.mock.calls.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(iterator.next).toHaveBeenCalledTimes(2);

    parentController.abort();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const signalAbortedImmediately = requestOptions?.signal?.aborted === true;
    resolveSecondNext?.({ done: true, value: undefined });
    await bodyPromise;

    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(signalAbortedImmediately).toBe(true);
    expect(iterator.return).toHaveBeenCalled();
    expect(matchCache.upsert).not.toHaveBeenCalled();
    expect(mockTrackAiFailure).not.toHaveBeenCalled();
  });

  it("ai-analyze는 모델 시도가 timeout되면 504를 반환하고 실패 telemetry/cache를 남기지 않는다", async () => {
    vi.useFakeTimers();

    try {
      const matchCache = createQueryChain({ data: null, error: null });
      const telemetry = createQueryChain({
        data: createCanonicalAnalyzeRow("match-analyze-timeout"),
        error: null,
      });
      const supabase = createSupabaseMock({
        match_ai_coaching_cache: matchCache,
        processed_match_telemetry: telemetry,
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      let requestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
      mockGenerateContentStream.mockImplementation((_prompt: string, options?: { signal?: AbortSignal; timeout?: number }) => {
        requestOptions = options;
        return new Promise(() => undefined);
      });

      const responsePromise = aiAnalyzePOST(createRequest({
        nickname: "Player_A",
        platform: "kakao",
        coachingStyle: "spicy",
        matchData: { matchId: "match-analyze-timeout" },
      }));

      for (let index = 0; index < 100 && mockGenerateContentStream.mock.calls.length < 1; index += 1) {
        await Promise.resolve();
      }
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25_100);
      const response = await responsePromise;

      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(requestOptions?.signal?.aborted).toBe(true);
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        error: "AI analysis request timed out",
        errorCode: "PUBG_AI_ROUTE_TIMEOUT",
        retryable: true,
      });
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(matchCache.upsert).not.toHaveBeenCalled();
      expect(mockTrackAiFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ai-analyze는 canonical row가 없으면 forged browser matchData를 사용하지 않고 409를 반환한다", async () => {
    const matchCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      matchData: { matchId: "match-1", stats: { kills: 9999 }, timeline: ["forged"] },
      nickname: "Player",
      platform: "steam",
      coachingStyle: "spicy",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(matchCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-analyze는 validated canonical fullResult만 prompt에 전달한다", async () => {
    mockSummaryGeminiRawText("canonical response", (prompt) => {
      expect(prompt).toContain("전투: 2킬");
      expect(prompt).not.toContain("9999킬");
      expect(prompt).not.toContain("forged-map");
    });

    const matchCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: createCanonicalAnalyzeRow("match-canonical", {
        mapName: "canonical-map",
        stats: {
          name: "Player_A",
          kills: 2,
          assists: 1,
          DBNOs: 1,
          damageDealt: 240,
          processedDamageDealt: 240,
          winPlace: 3,
          timeSurvived: 900,
        },
      }),
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      matchData: {
        matchId: "shard:match-canonical",
        mapName: "forged-map",
        stats: { name: "Player_A", kills: 9999 },
        timeline: ["forged"],
      },
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "mild",
    }));

    expect(response.status).toBe(200);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    expect(telemetry.select).toHaveBeenCalledWith("match_id,player_id,platform,data");
    expect(telemetry.eq).toHaveBeenCalledWith("match_id", "match-canonical");
  });

  it.each([
    ["slash", "bad/id"],
    ["space", "bad id"],
    ["too long", "a".repeat(161)],
    ["numeric", 42],
    ["non-string", { value: "match-1" }],
  ])("ai-analyze는 %s match ID를 cache lookup 전에 400으로 거부한다", async (_label, rawMatchId) => {
    const matchCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      matchData: { matchId: rawMatchId },
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "spicy",
    }));

    expect(response.status).toBe(400);
    expect(matchCache.select).not.toHaveBeenCalled();
    expect(telemetry.select).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(matchCache.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["mismatched", { ...createCanonicalAnalyzeRow("other-match") }],
    ["stale", { ...createCanonicalAnalyzeRow("match-stale", { v: RESULT_VERSION - 1 }) }],
  ])("ai-analyze는 %s canonical row를 409로 fail-closed한다", async (_label, canonicalRow) => {
    const matchCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: canonicalRow, error: null });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      matchData: { matchId: "match-stale", stats: { kills: 9999 } },
      nickname: "Player_A",
      platform: "kakao",
      coachingStyle: "spicy",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(matchCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-analyze는 지원하지 않는 coachingStyle을 lookup 전에 fail-closed한다", async () => {
    const matchCache = createQueryChain({ data: { ai_result: { text: "cached" } }, error: null });
    const telemetry = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      matchData: { matchId: "match-1" },
      nickname: "Player",
      platform: "steam",
      coachingStyle: "wild",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: "PUBG_AI_INVALID_COACHING_STYLE" });
    expect(matchCache.select).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it.each([
    ["mild", "mild"],
    ["spicy", "spicy"],
    ["default", undefined],
  ])("ai-analyze는 %s coachingStyle을 캐시 identity에 반영한다", async (_label, coachingStyle) => {
    const matchCache = createQueryChain({ data: { ai_result: { text: "cached-style" } }, error: null });
    const telemetry = createQueryChain({
      data: createCanonicalAnalyzeRow(`match-${_label}`),
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiAnalyzePOST(createRequest({
      matchData: { matchId: `match-${_label}` },
      nickname: "Player_A",
      platform: "kakao",
      ...(coachingStyle === undefined ? {} : { coachingStyle }),
    }));
    await response.text();

    expect(response.status).toBe(200);
    expect(matchCache.eq).toHaveBeenCalledWith("coaching_style", coachingStyle ?? "spicy");
    expect(telemetry.select).toHaveBeenCalledWith("match_id,player_id,platform,data");
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-summary는 force=true일 때 기존 AI 캐시 조회를 건너뛰고 새 결과를 upsert한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-1",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-1") },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-1"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const text = await response.text();

    expect(text).toContain("\"type\":\"done\"");
    expect(summaryCache.select).not.toHaveBeenCalled();
    expect(summaryCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        player_id: "player_a",
        platform: "kakao",
        prompt_version: AI_SUMMARY_CACHE_VERSION,
      }),
      { onConflict: "player_id,platform,match_ids_hash,prompt_version" }
    );
    const persistenceBuilder = summaryCache.upsert.mock.results[0]?.value;
    expect(persistenceBuilder?.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("ai-summary는 최신 유효 10개만 집계하고 그 effective ID set으로 hash를 만든다", async () => {
    mockSummaryGeminiResponse((prompt) => {
      expect(prompt).toContain("최근 유효 10경기");
      expect(prompt).toContain("평균 화력: 100");
    });

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: Array.from({ length: 11 }, (_, index) => ({
        match_id: `match-${index}`,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(`match-${index}`, {
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
            stats: {
              ...createSummaryMatch().stats,
              damageDealt: index === 0 ? 9999 : 100,
              processedDamageDealt: index === 0 ? 9999 : 100,
            },
            benchmark: {
              score: index === 0 ? 100 : 1,
              breakdown: { combat: 50, tactical: 50, survival: 50 },
            },
          }),
        },
      })),
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: Array.from({ length: 11 }, (_, index) => `match-${index}`),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await response.text();
    expect(response.status).toBe(200);
    const upsertPayload = summaryCache.upsert.mock.calls[0]?.[0];
    const effectiveIds = Array.from({ length: 10 }, (_, index) => `match-${10 - index}`);
    const selectionKey = buildMatchSelectionKey(effectiveIds, RECENT_MATCH_SELECTION_VERSION);
    const bestSelectionKey = buildBestMatchSelectionKey(effectiveIds.slice(0, 5).map((id) => ({
      id,
      createdAt: null,
      matchType: null,
      gameMode: null,
      mapName: null,
      sourceIndex: 0,
      value: { benchmark: { score: 1 } },
    })));
    const legacyHash = crypto.createHash("sha256").update(`${AI_SUMMARY_CACHE_VERSION}\n${selectionKey}\n${bestSelectionKey}`).digest("hex");
    expect(upsertPayload.match_ids_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(upsertPayload.match_ids_hash).not.toBe(legacyHash);
  });

  it("ai-summary cache hash는 latest10 ID가 같아도 best5 normalized score가 바뀌면 달라진다", async () => {
    const matchIds = Array.from({ length: 6 }, (_, index) => `score-match-${index}`);
    const baseScores = [100, 90, 80, 70, 60, 10];
    const run = async (scores: number[]) => {
      mockSummaryGeminiResponse();
      const summaryCache = createQueryChain();
      const telemetry = createQueryChain({
        data: matchIds.map((matchId, index) => ({
          match_id: matchId,
          player_id: "player_a",
          platform: "kakao",
          data: {
            fullResult: createSummaryMatch(matchId, {
              createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
              benchmark: { score: scores[index] },
            }),
          },
        })),
        error: null,
      });
      const globalBenchmarks = createQueryChain({ data: [], error: null });
      const tierBenchmarks = createQueryChain({ data: null, error: null });
      const supabase = createSupabaseMock({
        player_ai_summary_cache: summaryCache,
        processed_match_telemetry: telemetry,
        global_benchmarks: globalBenchmarks,
        benchmark_stats_by_tier: tierBenchmarks,
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      const response = await aiSummaryPOST(createRequest({
        matchIds,
        nickname: "Player_A",
        platform: "kakao",
        force: true,
      }));
      await response.text();
      return summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    };

    const firstHash = await run(baseScores);
    const changedScores = [...baseScores];
    changedScores[1] = 91; // same best5 membership/order, changed normalized score
    const secondHash = await run(changedScores);

    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondHash).not.toBe(firstHash);
  });

  it("ai-summary cache hash는 best5 밖인 latest10 6~10위 점수 변경도 감지한다", async () => {
    mockSummaryGeminiResponse();

    const matchIds = Array.from({ length: 10 }, (_, index) => `latest-score-${index}`);
    // Source order is oldest→newest, so latest order is 9→0. The top five
    // scores are IDs 9..5; ID 3 is sixth and remains outside best5 after the
    // mutation below.
    const scores = [6, 7, 8, 9, 10, 11, 60, 70, 80, 90];
    const telemetryRows = matchIds.map((matchId, index) => ({
      match_id: matchId,
      player_id: "player_a",
      platform: "kakao",
      data: {
        fullResult: createSummaryMatch(matchId, {
          createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
          benchmark: {
            score: scores[index],
            breakdown: { combat: scores[index], tactical: scores[index], survival: scores[index] },
          },
        }),
      },
    }));
    const telemetry = createQueryChain({ data: telemetryRows, error: null });
    const summaryCache = createQueryChain();
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const firstResponse = await aiSummaryPOST(createRequest({
      matchIds,
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await firstResponse.text();
    const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);

    configureSummaryCacheHitForHash(summaryCache, firstHash);
    const sixthMatch = telemetryRows.find((row) => row.match_id === "latest-score-3");
    sixthMatch!.data.fullResult.benchmark.score = 10;

    const secondResponse = await aiSummaryPOST(createRequest({
      matchIds,
      nickname: "Player_A",
      platform: "kakao",
    }));
    await secondResponse.text();

    expect(secondResponse.status).toBe(200);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);
    expect(summaryCache.upsert).toHaveBeenCalledTimes(2);
  });

  it("ai-summary benchmark query는 UI family와 분리된 최빈 raw mode 및 isCompetitiveMatch 판정을 사용한다", async () => {
    mockSummaryGeminiResponse();

    const specs = [
      { id: "raw-fpp-1", gameMode: "SQUAD-FPP", mode: "RANKED", score: 90 },
      { id: "raw-fpp-2", gameMode: " squad-fpp ", mode: "ranked-fpp", score: 80 },
      { id: "raw-tpp", gameMode: "squad-tpp", mode: "normal", score: 70 },
    ];
    const telemetry = createQueryChain({
      data: specs.map((spec, index) => ({
        match_id: spec.id,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(spec.id, {
            gameMode: spec.gameMode,
            matchType: "official",
            matchInfo: { mode: spec.mode },
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
            benchmark: { score: spec.score, breakdown: { combat: spec.score, tactical: spec.score, survival: spec.score } },
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: specs.map((spec) => spec.id),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await response.text();

    expect(response.status).toBe(200);
    // Both squad-fpp rows win the raw-mode frequency vote, while ranked and
    // ranked-fpp aliases make the group benchmark query competitive.
    expect(tierBenchmarks.eq).toHaveBeenCalledWith("game_mode", "squad-fpp");
    expect(tierBenchmarks.eq).toHaveBeenCalledWith("match_type", "competitive");
  });

  it("ai-summary invalid createdAt는 시계와 무관한 hash로 동일 payload cache hit을 유지한다", async () => {
    vi.useFakeTimers();
    try {
      mockSummaryGeminiResponse();
      const telemetry = createQueryChain({
        data: [{
          match_id: "invalid-created-at",
          player_id: "player_a",
          platform: "kakao",
          data: { fullResult: createSummaryMatch("invalid-created-at", { createdAt: "not-a-date" }) },
        }],
        error: null,
      });
      const summaryCache = createQueryChain();
      const tierBenchmarks = createQueryChain({ data: null, error: null });
      const supabase = createSupabaseMock({
        player_ai_summary_cache: summaryCache,
        processed_match_telemetry: telemetry,
        benchmark_stats_by_tier: tierBenchmarks,
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
      const firstResponse = await aiSummaryPOST(createRequest({
        matchIds: ["invalid-created-at"],
        nickname: "Player_A",
        platform: "kakao",
        force: true,
      }));
      await firstResponse.text();
      const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
      expect(firstHash).toMatch(/^[a-f0-9]{64}$/);

      configureSummaryCacheHitForHash(summaryCache, firstHash);
      vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
      const secondResponse = await aiSummaryPOST(createRequest({
        matchIds: ["invalid-created-at"],
        nickname: "Player_A",
        platform: "kakao",
      }));
      await secondResponse.text();

      expect(secondResponse.status).toBe(200);
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(summaryCache.upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Gemini 전체 실패는 fallback final 없이 중립 provider error와 terminal done을 보낸다", async () => {
    mockGenerateContentStream.mockRejectedValue(new Error("Gemini unavailable"));

    const telemetry = createQueryChain({
      data: Array.from({ length: 6 }, (_, index) => ({
        match_id: `fallback-best-${index}`,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(`fallback-best-${index}`, {
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
            benchmark: {
              score: index === 0 ? 1 : 100,
              breakdown: { combat: index === 0 ? 1 : 100, tactical: index === 0 ? 1 : 100, survival: index === 0 ? 1 : 100 },
            },
            duelStats: index === 0
              ? { wins: 0, losses: 10, reversals: 0, reversalAttempts: 0, duelWinRate: 0 }
              : { wins: 10, losses: 0, reversals: 0, reversalAttempts: 0, duelWinRate: 100 },
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: Array.from({ length: 6 }, (_, index) => `fallback-best-${index}`),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(records.map((record) => record.type)).toEqual(["visuals", "error", "done"]);
    expect(records.find((record) => record.type === "final")).toBeUndefined();
    expect(records[1]).toMatchObject({
      error: expect.any(String),
      errorCode: "PUBG_AI_PROVIDER_ERROR",
      retryable: true,
    });
    expect(records[2]).toMatchObject({
      valid: false,
      errorCode: "PUBG_AI_PROVIDER_ERROR",
      retryable: true,
    });
    expect(records[1].error).not.toContain("Gemini unavailable");
    expect(records[2].error).not.toContain("Gemini unavailable");
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary cache identity는 같은 latest10/best5 ID·점수라도 유효 payload 변경을 놓치지 않는다", async () => {
    mockSummaryGeminiResponse();

    const fullResult = createSummaryMatch("identity-payload", {
      createdAt: "2026-08-27T00:00:00.000Z",
      mapName: "Baltic_Main",
      benchmark: {
        score: 77,
        breakdown: { combat: 78, tactical: 72, survival: 80 },
        impactScore: 77,
        impactReasons: ["초기 근거"],
      },
    });
    const telemetry = createQueryChain({
      data: [{ match_id: "identity-payload", player_id: "player_a", platform: "kakao", data: { fullResult } }],
      error: null,
    });
    const summaryCache = createQueryChain();
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const firstResponse = await aiSummaryPOST(createRequest({
      matchIds: ["identity-payload"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await firstResponse.text();
    const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);

    configureSummaryCacheHitForHash(summaryCache, firstHash);
    // Keep the canonical ID, latest10 membership, best5 order, and score fixed;
    // mutate only effective telemetry/benchmark fields consumed by the prompt
    // and visuals.
    fullResult.createdAt = "2026-08-28T00:00:00.000Z";
    fullResult.mapName = "Desert_Main";
    fullResult.stats.processedDamageDealt = 999;
    fullResult.stats.damageDealt = 999;
    fullResult.benchmark.breakdown.combat = 11;
    (fullResult.benchmark as any).impactScore = 120;
    (fullResult.benchmark as any).impactReasons = ["변경된 근거"];

    const secondResponse = await aiSummaryPOST(createRequest({
      matchIds: ["identity-payload"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    await secondResponse.text();

    // Before the payload-aware digest, the old hash matched and this request
    // returned the cached result without invoking Gemini a second time.
    expect(secondResponse.status).toBe(200);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);
    expect(summaryCache.upsert).toHaveBeenCalledTimes(2);
  });

  it("ai-summary cache identity는 normalized tier benchmark 변경도 반영한다", async () => {
    mockSummaryGeminiResponse();

    const tierRow: Record<string, any> = {
      game_mode: "squad",
      match_type: "competitive",
      tier: "B",
      match_count: 5,
      avg_damage: 250,
      avg_damage_count: 5,
      avg_kills: 2.5,
      avg_survival_time: 900,
      avg_duel_win_rate: 50,
      avg_initiative_rate: 35,
      avg_trade_rate: 30,
      avg_revive_rate: 30,
      avg_smoke_rate: 40,
      avg_pressure_index: 2,
      avg_team_wipes: 0.2,
      avg_reversal_rate: 15,
      avg_isolation_index: 2.5,
      avg_min_dist: 15,
      avg_counter_latency_ms: 500,
      avg_trade_latency_ms: 12000,
      avg_solo_kill_rate: 50,
      avg_death_phase: 6,
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    };
    const telemetry = createQueryChain({
      data: [{
        match_id: "identity-tier-benchmark",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("identity-tier-benchmark") },
      }],
      error: null,
    });
    const summaryCache = createQueryChain();
    const tierBenchmarks = createQueryChain({ data: tierRow, error: null });
    tierBenchmarks.maybeSingle.mockImplementation(async () => ({ data: tierRow, error: null }));
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const firstResponse = await aiSummaryPOST(createRequest({
      matchIds: ["identity-tier-benchmark"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await firstResponse.text();
    const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);

    configureSummaryCacheHitForHash(summaryCache, firstHash);
    // The selected match and its best5 score are unchanged. Only the
    // normalized benchmark value used in the comparison prompt changes.
    tierRow.avg_damage = 900;

    const secondResponse = await aiSummaryPOST(createRequest({
      matchIds: ["identity-tier-benchmark"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    await secondResponse.text();

    // Before moving lookup below benchmark normalization, the old ID-only
    // hash returned the cached result before reading the changed tier row.
    expect(secondResponse.status).toBe(200);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);
    expect(summaryCache.upsert).toHaveBeenCalledTimes(2);
    expect(tierBenchmarks.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("ai-summary cache hit은 Gemini API 키가 없어도 NDJSON을 반환한다", async () => {
    mockSummaryGeminiResponse();

    const telemetry = createQueryChain({
      data: [{
        match_id: "cache-without-key",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("cache-without-key") },
      }],
      error: null,
    });
    const summaryCache = createQueryChain();
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const firstResponse = await aiSummaryPOST(createRequest({
      matchIds: ["cache-without-key"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await firstResponse.text();
    const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    configureSummaryCacheHitForHash(summaryCache, firstHash);

    const previousKey = process.env.GOOGLE_GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;
    try {
      const secondResponse = await aiSummaryPOST(createRequest({
        matchIds: ["cache-without-key"],
        nickname: "Player_A",
        platform: "kakao",
      }));
      const records = parseSummaryNdjson(await secondResponse.text());

      expect(secondResponse.status).toBe(200);
      expect(records.map((record) => record.type)).toEqual(["visuals", "final", "done"]);
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    } finally {
      if (previousKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = previousKey;
    }
  });

  it("ai-summary는 fresh Gemini의 비대칭 debate stats를 정규화한 JSON만 final/cache에 저장한다", async () => {
    const validFinal = createValidSummaryFinal({ finalVerdict: "텍스트 코칭은 유지합니다." });
    validFinal.debateIssues = validFinal.debateIssues.map((issue: any, index: number) => index === 0
      ? {
        ...issue,
        topic: "1:1 결정력",
        question: "질문",
        kindOpinion: "착한맛",
        spicyOpinion: "매운맛",
        userStats: [{ label: "총 투척 횟수", value: "22회" }],
        benchmarkStats: [{ label: "아군 기절 대비 연막 구출률", value: "11%" }],
      }
      : issue);
    mockSummaryGeminiRawText(JSON.stringify(validFinal));

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-debate-normalize-fresh",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-debate-normalize-fresh") },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-normalize-fresh"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const finalData = JSON.parse(records.find((record) => record.type === "final")?.data || "{}");
    const visuals = records.find((record) => record.type === "visuals")?.data;
    const cachedFinal = JSON.parse(summaryCache.upsert.mock.calls[0]?.[0]?.ai_result?.final || "{}");

    expect(response.status).toBe(200);
    expect(finalData.debateIssues[0].userStats).toEqual([]);
    expect(finalData.debateIssues[0].benchmarkStats).toEqual([]);
    expect(cachedFinal.debateIssues[0].userStats).toEqual([]);
    expect(cachedFinal.debateIssues[0].benchmarkStats).toEqual([]);
  });

  it("ai-summary는 invalid fresh final을 성공/캐시하지 않고 기존 stream error path로 보낸다", async () => {
    mockSummaryGeminiRawText("not-json");

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-debate-invalid-final",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-debate-invalid-final") },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-invalid-final"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(records.find((record) => record.type === "done")).toMatchObject({ valid: false });
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 jsonrepair로 고칠 수 있는 malformed fresh final도 성공/캐시하지 않는다", async () => {
    mockSummaryGeminiRawText('{"finalVerdict":"repairable",}');

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-debate-repairable-final",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-debate-repairable-final") },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-repairable-final"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(records.find((record) => record.type === "done")).toMatchObject({ valid: false });
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 Gemini가 빈 final을 반환하면 fallback 성공/캐시가 아닌 invalid stream으로 종료한다", async () => {
    mockGenerateContentStream.mockImplementation(async () => ({
      stream: (async function* () {
        yield { text: () => "" };
      })(),
      response: Promise.resolve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }),
    }));

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-debate-empty-final",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-debate-empty-final") },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-empty-final"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(records.find((record) => record.type === "done")).toMatchObject({ valid: false });
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 repairable cache final을 hit으로 반환하지 않고 새 Gemini 결과만 저장한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({
      data: {
        ai_result: {
          visuals: { latestMatchCount: 1, bestMatchCount: 1 },
          final: '{"finalVerdict":"repairable cache",}',
        },
      },
      error: null,
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-debate-repairable-cache",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-debate-repairable-cache") },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-repairable-cache"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(records.find((record) => record.type === "done")).toMatchObject({ valid: true });
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    expect(summaryCache.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(["", "   ", JSON.stringify({ finalVerdict: "" })])(
    "ai-summary는 empty cache final(%j)을 cache hit으로 취급하지 않는다",
    async (invalidFinal) => {
      mockSummaryGeminiResponse();

      const summaryCache = createQueryChain({
        data: { ai_result: { visuals: {}, final: invalidFinal } },
        error: null,
      });
      const telemetry = createQueryChain({
        data: [{
          match_id: "match-debate-empty-cache",
          player_id: "player_a",
          platform: "kakao",
          data: { fullResult: createSummaryMatch("match-debate-empty-cache") },
        }],
        error: null,
      });
      const supabase = createSupabaseMock({
        player_ai_summary_cache: summaryCache,
        processed_match_telemetry: telemetry,
        global_benchmarks: createQueryChain({ data: [], error: null }),
        benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      const response = await aiSummaryPOST(createRequest({
        matchIds: ["match-debate-empty-cache"],
        nickname: "Player_A",
        platform: "kakao",
      }));
      const records = parseSummaryNdjson(await response.text());

      expect(response.status).toBe(200);
      expect(records.find((record) => record.type === "done")).toMatchObject({ valid: true });
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(summaryCache.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it("ai-summary는 malformed cache final도 정규화한 뒤에만 cache hit으로 반환한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-debate-normalize-cache",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-debate-normalize-cache") },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const firstResponse = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-normalize-cache"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await firstResponse.text();
    const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    const malformedStatFinal = createValidSummaryFinal({ finalVerdict: "cached malformed stats" });
    malformedStatFinal.debateIssues[0] = {
      ...malformedStatFinal.debateIssues[0],
      topic: "1:1 결정력",
      userStats: [{ label: "총 투척 횟수", value: "22회" }],
      benchmarkStats: [{ label: "아군 기절 대비 연막 구출률", value: "11%" }],
    };
    configureSummaryCacheHitForHash(summaryCache, firstHash, {
      // Deliberately stale: the route must replay only the cached final, while
      // recomputing visuals from the current canonical match payload.
      visuals: { latestMatchCount: 999, bestMatchCount: 999, marker: "stale" },
      final: JSON.stringify(malformedStatFinal),
    });
    mockGenerateContentStream.mockClear();

    const secondResponse = await aiSummaryPOST(createRequest({
      matchIds: ["match-debate-normalize-cache"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    const records = parseSummaryNdjson(await secondResponse.text());
    const finalData = JSON.parse(records.find((record) => record.type === "final")?.data || "{}");
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(secondResponse.status).toBe(200);
    expect(records.map((record) => record.type)).toEqual(["visuals", "final", "done"]);
    expect(visuals).toMatchObject({ latestMatchCount: 1, bestMatchCount: 1 });
    expect(visuals).not.toHaveProperty("marker");
    expect(finalData.debateIssues[0].userStats).toEqual([]);
    expect(finalData.debateIssues[0].benchmarkStats).toEqual([]);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-summary는 latest10을 전체 UI에 보존하고 그 안의 best5만 AI/벤치마크에 사용한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const specs = new Map<number, { damage: number; score: number; impact: number }>([
      [0, { damage: 9999, score: 9999, impact: 9999 }], // 11번째 오래된 고득점 매치: latest10에서 제외
      [1, { damage: 10, score: 1, impact: 1 }],
      [2, { damage: 10, score: 1, impact: 2 }],
      [3, { damage: 10, score: 1, impact: 3 }],
      [4, { damage: 10, score: 1, impact: 4 }],
      [5, { damage: 10, score: 1, impact: 5 }],
      [6, { damage: 100, score: 60, impact: 106 }],
      [7, { damage: 200, score: 70, impact: 107 }],
      [8, { damage: 300, score: 80, impact: 108 }],
      [9, { damage: 400, score: 90, impact: 109 }],
      [10, { damage: 500, score: 100, impact: 110 }],
    ]);
    const telemetry = createQueryChain({
      data: Array.from({ length: 11 }, (_, index) => {
        const spec = specs.get(index)!;
        return {
          match_id: `match-${index}`,
          player_id: "player_a",
          platform: "kakao",
          data: {
            fullResult: createSummaryMatch(`match-${index}`, {
              createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
              mapName: index % 2 === 0 ? "Baltic_Main" : "Desert_Main",
              stats: {
                ...createSummaryMatch().stats,
                damageDealt: spec.damage,
                processedDamageDealt: spec.damage,
              },
              benchmark: {
                score: spec.score,
                impactScore: spec.impact,
                breakdown: { combat: spec.score, tactical: spec.score, survival: spec.score },
              },
              tradeStats: {
                ...createSummaryMatch().tradeStats,
                enemyTeamWipes: index,
              },
            }),
          },
        };
      }),
      error: null,
    });
    const summaryCache = createQueryChain();
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: Array.from({ length: 11 }, (_, index) => `match-${index}`),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    // The AI comparison average is best5: (500 + 400 + 300 + 200 + 100) / 5.
    expect(capturedPrompt).toContain("평균 화력: 300");
    expect(capturedPrompt).toContain("상위 5판 분석");
    expect(capturedPrompt).toContain("기반: 상위 5판");
    expect(capturedPrompt).toContain("benchmark.score 내림차순");
    expect(capturedPrompt).toContain("신뢰도: 높음");
    expect(capturedPrompt).toContain("매치 임팩트 110");
    expect(capturedPrompt).toContain("매치 임팩트 108");
    expect(capturedPrompt).not.toContain("매치 임팩트 9999");

    // Mastery/basic visuals remain the full latest10, not best5.
    expect(capturedPrompt).toContain("랭크 매치: 10판");
    expect(visuals.tactical.counts.knocks).toBe(10);
    // index 0 is the excluded 11th-oldest match, so latest10 sums 1..10.
    expect(visuals.tactical.counts.enemyTeamWipes).toBe(55);
    expect(visuals.latestMatchCount).toBe(10);
    expect(visuals.bestMatchCount).toBe(5);
    // The dashboard's potential tier/breakdown stays best5-scoped:
    // (60 + 70 + 80 + 90 + 100) / 5 = 80 (A+).
    expect(visuals.tierBreakdown.total).toBe(80);
    expect(visuals.overallTier).toBe("A+");
    expect(visuals.roleInfo.overallTier).toBe(visuals.overallTier);
    expect(visuals.mapStats.list.map((entry: any) => entry.matchCount)).toEqual([5, 5]);
    expect(visuals.trends).toMatchObject({
      recent: { damage: 300 },
      older: { damage: 10 },
      dmgTrend: 290,
    });

    // The cache identity proves the old high-score 11th match was excluded;
    // therefore every best5 candidate is necessarily a member of latest10.
    const upsertPayload = summaryCache.upsert.mock.calls[0]?.[0];
    const latest10Ids = Array.from({ length: 10 }, (_, index) => `match-${10 - index}`);
    const selectionKey = buildMatchSelectionKey(latest10Ids, RECENT_MATCH_SELECTION_VERSION);
    const bestSelectionKey = buildBestMatchSelectionKey(latest10Ids.slice(0, 5).map((id, index) => ({
      id,
      createdAt: null,
      matchType: null,
      gameMode: null,
      mapName: null,
      sourceIndex: index,
      value: { benchmark: { score: 100 - index * 10 } },
    })));
    const legacyHash = crypto.createHash("sha256").update(`${AI_SUMMARY_CACHE_VERSION}\n${selectionKey}\n${bestSelectionKey}`).digest("hex");
    expect(upsertPayload.match_ids_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(upsertPayload.match_ids_hash).not.toBe(legacyHash);
  });

  it("ai-summary prompt는 persisted benchmark score를 0..100으로 정규화한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "prompt-score-boundary",
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch("prompt-score-boundary", {
            benchmark: {
              score: 101,
              impactScore: 5,
              breakdown: { combat: 101, tactical: 101, survival: 101 },
            },
          }),
        },
      }],
      error: null,
    });
    const summaryCache = createQueryChain();
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["prompt-score-boundary"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedPrompt).toContain("전술 안정도 100/100");
    expect(capturedPrompt).not.toContain("전술 안정도 101/100");
  });

  it("ai-summary는 opportunity denominator가 없을 때 trade/smoke zero evidence를 만들지 않는다", async () => {
    mockSummaryGeminiResponse();
    const telemetry = createQueryChain({
      data: [{
        match_id: "missing-opportunity-denominator",
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch("missing-opportunity-denominator", {
            tradeStats: {
              ...createSummaryMatch().tradeStats,
              teammateKnocks: undefined,
              tradeKills: 0,
              smokeRescues: 0,
            },
          }),
        },
      }],
      error: null,
    });
    const tierBenchmarks = createQueryChain({
      data: {
        game_mode: "squad",
        match_type: "competitive",
        tier: "B",
        match_count: 5,
        avg_trade_rate: 55,
        avg_trade_rate_count: 5,
        avg_smoke_rate: 45,
        avg_smoke_rate_count: 5,
      },
      error: null,
    });
    const summaryCache = createQueryChain();
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["missing-opportunity-denominator"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const finalData = JSON.parse(records.find((record) => record.type === "final")?.data || "{}");
    const visuals = records.find((record) => record.type === "visuals")?.data;
    const evidence = finalData.debateIssues.flatMap((issue: any) => [
      ...(issue.userStats || []),
      ...(issue.benchmarkStats || []),
    ]);

    expect(response.status).toBe(200);
    expect(visuals.tactical.tradeRate).toBe("측정 불가");
    expect(visuals.tactical.suppRate).toBe("측정 불가");
    expect(visuals.tactical.reviveRate).toBe("측정 불가");
    expect(evidence.map((stat: any) => stat.label)).not.toContain("복수 성공률");
    expect(evidence.map((stat: any) => stat.label)).not.toContain("아군 기절 대비 연막 구출률");
  });

  it("ai-summary는 enemyTeamWipes 숫자 문자열을 합산해 숫자형 visual로 반환한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const telemetry = createQueryChain({
      data: ["2", "3"].map((enemyTeamWipes, index) => ({
        match_id: `string-team-wipe-${index}`,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(`string-team-wipe-${index}`, {
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
            tradeStats: {
              ...createSummaryMatch().tradeStats,
              enemyTeamWipes,
            },
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain();
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["string-team-wipe-0", "string-team-wipe-1"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.tactical.counts.enemyTeamWipes).toBe(5);
    expect(typeof visuals.tactical.counts.enemyTeamWipes).toBe("number");
    expect(capturedPrompt).toContain("적 팀 전멸 기여: 5회");
  });

  it("ai-summary는 비유한 telemetry를 finite한 NDJSON/cache visuals로 정규화한다", async () => {
    mockSummaryGeminiResponse();

    const malformed = createSummaryMatch("malformed-visual-numbers", {
      stats: {
        ...createSummaryMatch().stats,
        kills: Number.NaN,
        processedDamageDealt: Number.POSITIVE_INFINITY,
        damageDealt: Number.NaN,
      },
      tradeStats: {
        ...createSummaryMatch().tradeStats,
        teammateKnocks: Number.NaN,
        coverRateSampleCount: Number.POSITIVE_INFINITY,
        tradeLatencyMs: Number.NaN,
        reactionLatencyMs: Number.POSITIVE_INFINITY,
        enemyTeamWipes: "malformed",
      },
      combatPressure: {
        ...createSummaryMatch().combatPressure,
        pressureIndex: Number.POSITIVE_INFINITY,
        maxHitDistance: Number.NaN,
        utilityStats: {
          ...createSummaryMatch().combatPressure.utilityStats,
          throwCount: Number.NaN,
          hitCount: Number.POSITIVE_INFINITY,
          totalDamage: Number.NaN,
        },
      },
      isolationData: {
        ...createSummaryMatch().isolationData,
        isolationIndex: Number.NaN,
        minDist: Number.POSITIVE_INFINITY,
        heightDiff: "malformed",
        teammateCount: undefined,
      },
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "malformed-visual-numbers",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: malformed },
      }],
      error: null,
    });
    const summaryCache = createQueryChain();
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["malformed-visual-numbers"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;
    const cachedVisuals = summaryCache.upsert.mock.calls[0]?.[0]?.ai_result?.visuals;
    const assertFiniteNumbers = (value: unknown): void => {
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(assertFiniteNumbers);
        return;
      }
      if (value && typeof value === "object") {
        Object.values(value).forEach(assertFiniteNumbers);
      }
    };

    expect(response.status).toBe(200);
    assertFiniteNumbers(visuals);
    assertFiniteNumbers(cachedVisuals);
    expect(JSON.stringify(records)).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("ai-summary debate evidence는 main mode의 canonical 값만 유지하고 provider 숫자를 덮어쓴다", async () => {
    const providerFinal = createValidSummaryFinal({
      debateIssues: [
        {
          ...createValidSummaryFinal().debateIssues[0],
          userStats: [{ label: "평균 화력", value: "999" }],
          benchmarkStats: [{ label: "상위권 평균 화력", value: "999" }],
        },
        {
          ...createValidSummaryFinal().debateIssues[1],
          question: "듀오 상위권 평균 화력 999 대비 평균 화력 888이 높습니다.",
          kindOpinion: "상위권 평균 화력 999 대비 평균 화력 888이 높습니다.",
          userStats: [{ label: "주도권 성공률", value: "999%" }],
          benchmarkStats: [{ label: "상위권 선제 공격 성공률", value: "999%" }],
        },
        createValidSummaryFinal().debateIssues[2],
      ],
    });
    mockSummaryGeminiRawText(JSON.stringify(providerFinal));

    const mainModeBenchmark = {
      game_mode: "squad",
      match_type: "competitive",
      tier: "B",
      match_count: 5,
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
      avg_damage: 300,
      avg_damage_count: 5,
      avg_initiative_rate: null,
    };
    const minorityModeBenchmark = {
      game_mode: "duo",
      match_type: "competitive",
      tier: "B",
      match_count: 5,
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
      avg_damage: null,
      avg_initiative_rate: 77,
    };
    const telemetry = createQueryChain({
      data: [
        { id: "duo-evidence-0", mode: "DUO", index: 0 },
        { id: "duo-evidence-1", mode: "DUO", index: 1 },
        { id: "squad-evidence-0", mode: "SQUAD", index: 2 },
        { id: "squad-evidence-1", mode: "SQUAD", index: 3 },
        { id: "squad-evidence-2", mode: "SQUAD", index: 4 },
      ].map(({ id, mode, index }) => ({
        match_id: id,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(id, {
            gameMode: mode,
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain();
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    tierBenchmarks.maybeSingle.mockImplementation(async () => {
      const modeCalls = tierBenchmarks.eq.mock.calls.filter(([column]: [string]) => column === "game_mode");
      const mode = modeCalls.at(-1)?.[1];
      return { data: mode === "duo" ? minorityModeBenchmark : mainModeBenchmark, error: null };
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["duo-evidence-0", "duo-evidence-1", "squad-evidence-0", "squad-evidence-1", "squad-evidence-2"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const finalData = JSON.parse(records.find((record) => record.type === "final")?.data || "{}");

    expect(response.status).toBe(200);
    expect(finalData.debateIssues[0]).toMatchObject({
      userStats: [{ label: "평균 화력", value: "320" }],
      benchmarkStats: [{ label: "동일 티어 평균 화력", value: "300" }],
    });
    expect(finalData.debateIssues[1].question).toBe("검증된 경기 지표를 바탕으로 분석합니다.");
    expect(finalData.debateIssues[1].kindOpinion).toBe("검증된 경기 지표를 바탕으로 분석합니다.");
    // Initiative is observed only in the minority DUO benchmark row, so it
    // cannot become evidence for the SQUAD main-mode debate.
    expect(finalData.debateIssues[1].userStats).toEqual([]);
    expect(finalData.debateIssues[1].benchmarkStats).toEqual([]);
  });

  it("ai-summary mixed-mode 분석은 모드별 상위 표본과 전체 best5 잠재 티어를 분리한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const specs = [
      { id: "squad-1", mode: "SQUAD", damage: 100, score: 30, timeline: [] },
      { id: "squad-2", mode: "SQUAD", damage: 200, score: 30, timeline: [] },
      { id: "squad-3", mode: "SQUAD", damage: 300, score: 30, timeline: [] },
      { id: "duo-1", mode: "DUO", damage: 900, score: 80, timeline: [{ type: "KILL", weapon: "WeapM416_C" }] },
      { id: "duo-2", mode: "DUO", damage: 1_100, score: 90, timeline: [{ type: "KILL", weapon: "WeapM416_C" }] },
      { id: "squad-low-score", mode: "SQUAD", damage: 9_999, score: 10 },
    ];
    const telemetry = createQueryChain({
      data: specs.map((spec, index) => ({
        match_id: spec.id,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(spec.id, {
            gameMode: spec.mode,
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
            stats: {
              ...createSummaryMatch().stats,
              damageDealt: spec.damage,
              processedDamageDealt: spec.damage,
            },
            benchmark: {
              score: spec.score,
              breakdown: { combat: spec.score, tactical: spec.score, survival: spec.score },
            },
            timeline: spec.timeline,
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain();
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: specs.map((spec) => spec.id),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    const duoStart = capturedPrompt.indexOf("### [DUO 모드 분석]");
    const squadStart = capturedPrompt.indexOf("### [SQUAD 모드 분석]");
    expect(duoStart).toBeGreaterThanOrEqual(0);
    expect(squadStart).toBeGreaterThanOrEqual(0);
    const duoSection = capturedPrompt.slice(duoStart, squadStart);
    const squadSection = capturedPrompt.slice(squadStart);

    expect(duoSection).toContain("상위 5판 중 2판");
    expect(duoSection).toContain("평균 화력: 1000");
    expect(squadSection).toContain("상위 5판 중 3판");
    expect(squadSection).toContain("평균 화력: 200");
    expect(duoSection).not.toContain("평균 화력: 200");
    expect(squadSection).not.toContain("평균 화력: 1000");
    expect(capturedPrompt).not.toContain("최근 트렌드 (최근 5판 vs 이전 5판)");
    expect(visuals.trends).toBeNull();

    // The potential card is one top-five aggregate across both modes:
    // (30 + 30 + 30 + 80 + 90) / 5 = 52 (B+), with all three breakdowns
    // averaged over the same five benchmark payloads.
    expect(visuals.tierBreakdown).toEqual({ combat: 52, tactical: 52, survival: 52, total: 52 });
    expect(visuals.overallTier).toBe("B+");
    expect(visuals.roleInfo.overallTier).toBe(visuals.overallTier);
    expect(visuals.roleInfo.signatureWeapon).toBe("M416");
    expect(visuals.roleInfo.signatureWeaponStats.kills).toBe(2);
  });

  it("ai-summary는 공백·대소문자와 ranked alias를 경쟁전으로 판정한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const specs = [
      { id: "trimmed-competitive", gameMode: " squad-fpp ", matchType: "  COMPETITIVE  " },
      // Ranked is a match-type alias; the gameMode must still be one of the
      // six explicit battle-royale modes (never inferred from `ranked-fpp`).
      { id: "ranked-alias", gameMode: " squad-fpp ", matchType: " ranked-fpp " },
      { id: "normal-official", gameMode: " squad-fpp ", matchType: " official " },
    ];
    const telemetry = createQueryChain({
      data: specs.map((spec, index) => ({
        match_id: spec.id,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(spec.id, {
            gameMode: spec.gameMode,
            matchType: spec.matchType,
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: specs.map((spec) => spec.id),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(capturedPrompt).toContain("랭크 매치: 2판");
    expect(visuals.modeDistribution).toMatchObject({ ranked: 2, normal: 1 });
  });

  it("ai-summary는 canonical ID가 같은 누락 fallback을 첫 요청 순서대로 한 번만 조회한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const requestedId = url.searchParams.get("matchId");
      const canonicalId = requestedId?.split(":").pop() || "";
      return Promise.resolve(new Response(
        JSON.stringify(createSummaryMatch(canonicalId)),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["shard:duplicate-match", "duplicate-match", "unique-match"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await response.text();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestedIds = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("matchId"));
    expect(requestedIds).toEqual(["duplicate-match", "unique-match"]);
  });

  it("ai-summary fallback은 느린 25개 누락 ID에서 deadline에 도달하면 in-flight 요청을 취소하고 Gemini를 호출하지 않는다", async () => {
    vi.useFakeTimers();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const requestedIds = Array.from({ length: 25 }, (_, index) => `slow-missing-${index}`);
    const abortedIds: string[] = [];
    const callTimes: number[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const matchId = new URL(String(input)).searchParams.get("matchId") || "";
      callTimes.push(Date.now());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedIds.push(matchId);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let response: Response | undefined;
    const responsePromise = aiSummaryPOST(createRequest({
      matchIds: requestedIds,
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    })).then((result) => {
      response = result;
      return result;
    });

    for (let index = 0; index < 100; index += 1) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(24_100);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    expect(response?.status).toBe(409);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
    expect(callTimes.every((time) => time <= callTimes[0]! + 24_000)).toBe(true);
    expect(abortedIds).toEqual(expect.arrayContaining(requestedIds.slice(0, 2)));
    expect(abortedIds).toHaveLength(fetchMock.mock.calls.length);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();

    // Keep the pending promise observed so a future implementation cannot
    // turn the abort path into an unhandled rejection.
    await responsePromise;
    const callsAtDeadline = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(callsAtDeadline);
  });

  it("ai-summary는 유효한 canonical 매치가 하나 있어도 부모 abort 뒤 fallback/Gemini/upsert를 진행하지 않는다", async () => {
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{ match_id: "cached-canonical", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("cached-canonical") } }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const requestedIds = ["cached-canonical", "hanging-missing-1", "hanging-missing-2", "hanging-missing-3"];
    const parentController = new AbortController();
    const abortedIds: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const matchId = new URL(String(input)).searchParams.get("matchId") || "";
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedIds.push(matchId);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = aiSummaryPOST(createAbortableRequest({
      matchIds: requestedIds,
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }, parentController.signal));

    for (let index = 0; index < 100 && fetchMock.mock.calls.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    parentController.abort();
    const response = await responsePromise;
    await response.text();

    expect(response.status).toBe(409);
    expect(abortedIds).toEqual(expect.arrayContaining(["hanging-missing-1", "hanging-missing-2"]));
    expect(abortedIds).toHaveLength(fetchMock.mock.calls.length);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary Gemini 시작이 매달리면 SDK signal을 abort하고 다음 모델과 성공 캐시를 만들지 않는다", async () => {
    vi.useFakeTimers();

    try {
      const summaryCache = createQueryChain({ data: null, error: null });
      const telemetry = createQueryChain({
        data: [{ match_id: "hanging-gemini", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("hanging-gemini") } }],
        error: null,
      });
      const supabase = createSupabaseMock({
        player_ai_summary_cache: summaryCache,
        processed_match_telemetry: telemetry,
        global_benchmarks: createQueryChain({ data: [], error: null }),
        benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      let requestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
      mockGenerateContentStream.mockImplementation((_prompt: string, options?: { signal?: AbortSignal; timeout?: number }) => {
        requestOptions = options;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("[GoogleGenerativeAI Error]: Request aborted when fetching https://generativelanguage.googleapis.com");
            error.name = "Error";
            reject(error);
          }, { once: true });
        });
      });

      const responsePromise = aiSummaryPOST(createRequest({
        matchIds: ["hanging-gemini"],
        nickname: "Player_A",
        platform: "kakao",
        force: true,
      }));

      for (let index = 0; index < 100 && mockGenerateContentStream.mock.calls.length < 1; index += 1) {
        await Promise.resolve();
      }
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(requestOptions?.timeout).toBeUndefined();
      expect(requestOptions?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(8_100);
      await vi.advanceTimersByTimeAsync(40_100);
      const response = await responsePromise;
      const responseText = await response.text();

      expect(requestOptions?.signal?.aborted).toBe(true);
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(summaryCache.upsert).not.toHaveBeenCalled();
      expect(response.status).toBe(504);
      expect(responseText).toContain("PUBG_AI_ROUTE_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ai-summary는 Gemini 스트림이 chunk 없이 멈춰도 생성 deadline에 종료하고 성공 캐시를 쓰지 않는다", async () => {
    vi.useFakeTimers();

    try {
      const summaryCache = createQueryChain({ data: null, error: null });
      const telemetry = createQueryChain({
        data: [{ match_id: "hanging-stream", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("hanging-stream") } }],
        error: null,
      });
      const supabase = createSupabaseMock({
        player_ai_summary_cache: summaryCache,
        processed_match_telemetry: telemetry,
        global_benchmarks: createQueryChain({ data: [], error: null }),
        benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      let requestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
      let iterator: any;
      mockGenerateContentStream.mockImplementation(async (_prompt: string, options?: { signal?: AbortSignal; timeout?: number }) => {
        requestOptions = options;
        iterator = {
          next: vi.fn(() => new Promise((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
          })),
          return: vi.fn(async () => ({ done: true, value: undefined })),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return {
          stream: iterator,
          response: Promise.resolve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }),
        };
      });

      const response = await aiSummaryPOST(createRequest({
        matchIds: ["hanging-stream"],
        nickname: "Player_A",
        platform: "kakao",
        force: true,
      }));
      const bodyPromise = response.text();

      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(iterator.next).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8_100);
      expect(requestOptions?.timeout).toBeUndefined();
      expect(requestOptions?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(9_900);
      const body = await bodyPromise;

      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(requestOptions?.signal?.aborted).toBe(true);
      expect(body).toContain("PUBG_AI_ROUTE_TIMEOUT");
      expect(body).not.toContain('"type":"final"');
      expect(parseSummaryNdjson(body).find((record) => record.type === "done")).toMatchObject({
        error: "AI summary request timed out",
        errorCode: "PUBG_AI_ROUTE_TIMEOUT",
        retryable: true,
      });
      expect(summaryCache.upsert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ai-summary response body를 취소하면 Gemini iterator를 중단하고 캐시를 쓰지 않는다", async () => {
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{ match_id: "cancelled-summary-stream", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("cancelled-summary-stream") } }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    let requestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
    let resolveNext: ((value: IteratorResult<any>) => void) | undefined;
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<any>>((resolve) => {
        resolveNext = resolve;
      })),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    mockGenerateContentStream.mockImplementation(async (
      _prompt: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ) => {
      requestOptions = options;
      return {
        stream: iterator,
        response: Promise.resolve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }),
      };
    });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["cancelled-summary-stream"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('"type":"visuals"');
    expect(iterator.next).toHaveBeenCalledTimes(1);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reader.cancel("component unmounted");
    for (let index = 0; index < 100 && iterator.return.mock.calls.length < 1; index += 1) {
      await Promise.resolve();
    }
    const signalAbortedImmediately = requestOptions?.signal?.aborted === true;
    resolveNext?.({ done: true, value: undefined });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(signalAbortedImmediately).toBe(true);
    expect(iterator.return).toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
    expect(mockTrackAiFailure).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("AI-SUMMARY-STREAM-ERROR");
  });

  it("ai-summary body 취소는 진행 중인 cache upsert signal도 abort한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    let persistenceSignal: AbortSignal | undefined;
    let resolveSave: ((value: { data: null; error: null }) => void) | undefined;
    const pendingSave = new Promise<{ data: null; error: null }>((resolve) => {
      resolveSave = resolve;
    });
    const persistenceBuilder: any = {
      abortSignal: vi.fn((signal: AbortSignal) => {
        persistenceSignal = signal;
        return persistenceBuilder;
      }),
      then: pendingSave.then.bind(pendingSave),
      catch: pendingSave.catch.bind(pendingSave),
      finally: pendingSave.finally.bind(pendingSave),
    };
    summaryCache.upsert.mockReturnValue(persistenceBuilder);
    const telemetry = createQueryChain({
      data: [{ match_id: "cancelled-summary-save", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("cancelled-summary-save") } }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["cancelled-summary-save"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const reader = response.body!.getReader();
    const visualsChunk = await reader.read();
    expect(new TextDecoder().decode(visualsChunk.value)).toContain('"type":"visuals"');

    for (let index = 0; index < 100 && summaryCache.upsert.mock.calls.length < 1; index += 1) {
      await Promise.resolve();
    }
    expect(summaryCache.upsert).toHaveBeenCalledTimes(1);
    expect(persistenceSignal).toBeInstanceOf(AbortSignal);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reader.cancel("component unmounted during persistence");
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const signalAbortedImmediately = persistenceSignal?.aborted === true;
    resolveSave?.({ data: null, error: null });
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(signalAbortedImmediately).toBe(true);
    expect(mockTrackAiFailure).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("AI-SUMMARY-STREAM-ERROR");
  });

  it("ai-summary는 streamResult.response rejection을 iterator abort 전에 처리한다", async () => {
    vi.useFakeTimers();

    try {
      const summaryCache = createQueryChain({ data: null, error: null });
      const telemetry = createQueryChain({
        data: [{ match_id: "response-rejection", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("response-rejection") } }],
        error: null,
      });
      const supabase = createSupabaseMock({
        player_ai_summary_cache: summaryCache,
        processed_match_telemetry: telemetry,
        global_benchmarks: createQueryChain({ data: [], error: null }),
        benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
      });
      mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

      let requestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
      const responseThen = vi.fn((onFulfilled?: (value: unknown) => unknown) => {
        const rejected = Promise.reject(new Error("stream response rejected"));
        return rejected.then(onFulfilled).catch(() => undefined);
      });
      const streamResponse = { then: responseThen };
      let iterator: any;
      mockGenerateContentStream.mockImplementation(async (_prompt: string, options?: { signal?: AbortSignal; timeout?: number }) => {
        requestOptions = options;
        iterator = {
          next: vi.fn(() => new Promise((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
          })),
          return: vi.fn(async () => ({ done: true, value: undefined })),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return { stream: iterator, response: streamResponse };
      });

      const response = await aiSummaryPOST(createRequest({
        matchIds: ["response-rejection"],
        nickname: "Player_A",
        platform: "kakao",
        force: true,
      }));
      const bodyPromise = response.text();

      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(responseThen).toHaveBeenCalled();
      expect(iterator.next).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(18_100);
      const body = await bodyPromise;

      expect(requestOptions?.signal?.aborted).toBe(true);
      expect(body).toContain("PUBG_AI_ROUTE_TIMEOUT");
      expect(summaryCache.upsert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ai-summary persistence는 PostgREST abortSignal을 upsert builder에 전달한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{ match_id: "persistence-signal", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("persistence-signal") } }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["persistence-signal"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    await response.text();

    const persistenceBuilder = summaryCache.upsert.mock.results[0]?.value;
    expect(persistenceBuilder?.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("ai-summary의 processed/cache select도 route abortSignal을 PostgREST에 전달한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{ match_id: "select-signal", player_id: "player_a", platform: "kakao", data: { fullResult: createSummaryMatch("select-signal") } }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["select-signal"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    await response.text();

    expect(telemetry.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(summaryCache.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("benchmark exact query abort는 grouped fallback을 시작하지 않는다", async () => {
    const controller = new AbortController();
    const benchmarkChain = createQueryChain({ data: null, error: { message: "aborted" } });
    benchmarkChain.maybeSingle.mockImplementation(async () => {
      controller.abort();
      return { data: null, error: { message: "aborted" } };
    });
    const supabase = createSupabaseMock({ benchmark_stats_by_tier: benchmarkChain });

    const result = await fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A",
      signal: controller.signal,
    } as any);

    expect(result).toBeNull();
    expect(benchmarkChain.abortSignal).toHaveBeenCalledWith(controller.signal);
    expect(benchmarkChain.in).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("ai-summary는 score-aware hash를 복원할 수 없는 metadata-only 요청에서 stale cache를 반환하지 않는다", async () => {
    const summaryCache = createQueryChain({
      data: {
        ai_result: {
          visuals: { overallTier: "S" },
          final: JSON.stringify({ finalVerdict: "stale" }),
        },
      },
      error: null,
    });
    const supabase = createSupabaseMock({ player_ai_summary_cache: summaryCache });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-without-data"],
      nickname: "Player_A",
      platform: "kakao",
    }));

    expect(response.status).toBe(409);
    expect(summaryCache.select).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["old numeric", RESULT_VERSION - 1],
    ["missing", undefined],
    ["string", String(RESULT_VERSION)],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("ai-summary는 %s processed fullResult를 stale로 fail-closed한다", async (_label, version) => {
    const staleFullResult = createSummaryMatch("match-stale-summary", {
      ...(version === undefined ? { v: undefined } : { v: version }),
      benchmark: {
        score: 9999,
        impactScore: 9999,
        impactReasons: ["STALE_SUMMARY_MARKER"],
        breakdown: { combat: 99, tactical: 99, survival: 99 },
      },
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{ match_id: "match-stale-summary", player_id: "player_a", platform: "kakao", data: { fullResult: staleFullResult } }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-stale-summary"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 preservation marker가 없는 pre-v73/R2 row를 공식 squad로 재해석하지 않는다", async () => {
    mockSummaryGeminiResponse();
    const legacyRow = {
      match_id: "match-legacy-unmarked",
      player_id: "player_a",
      platform: "kakao",
      data: {
        fullResult: createSummaryMatch("match-legacy-unmarked", {
          populationEvidenceVersion: undefined,
          benchmark: {
            score: 999,
            impactScore: 999,
            impactReasons: ["LEGACY_V73_CONTAMINATION_MARKER"],
            breakdown: { combat: 99, tactical: 99, survival: 99 },
          },
        }),
      },
    };
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [legacyRow], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-legacy-unmarked"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "PUBG_AI_CANONICAL_NOT_READY" });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 wrapper의 preservation marker로 unmarked canonical fullResult를 축복하지 않는다", async () => {
    mockSummaryGeminiResponse();
    const legacyFullResult = createSummaryMatch("match-wrapper-only-marker", {
      populationEvidenceVersion: undefined,
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-wrapper-only-marker",
        player_id: "player_a",
        platform: "kakao",
        data: {
          populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
          fullResult: legacyFullResult,
        },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-wrapper-only-marker"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "PUBG_AI_CANONICAL_NOT_READY" });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary fallback requires the preservation marker on canonical fullResult itself", async () => {
    mockSummaryGeminiResponse();
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const legacyFullResult = createSummaryMatch("match-fallback-wrapper-only-marker", {
      populationEvidenceVersion: undefined,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
        fullResult: legacyFullResult,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-fallback-wrapper-only-marker"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "PUBG_AI_CANONICAL_NOT_READY" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 current V73과 stale V72 혼합 시 current만 10→best5 집계에 포함한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const staleFullResult = createSummaryMatch("match-stale-summary", {
      v: RESULT_VERSION - 1,
      createdAt: "2026-08-28T00:10:00.000Z",
      benchmark: {
        score: 9999,
        impactScore: 9999,
        impactReasons: ["STALE_SUMMARY_MARKER"],
        breakdown: { combat: 99, tactical: 99, survival: 99 },
      },
    });
    const currentRows = Array.from({ length: 6 }, (_, index) => ({
      match_id: `match-current-${index}`,
      player_id: "player_a",
      platform: "kakao",
      data: {
        fullResult: createSummaryMatch(`match-current-${index}`, {
          v: RESULT_VERSION,
          createdAt: new Date(Date.UTC(2026, 7, 28, 0, index)).toISOString(),
          benchmark: {
            score: 60 + index,
            impactScore: 60 + index,
            impactReasons: [`CURRENT_SUMMARY_MARKER_${index}`],
            breakdown: { combat: 60 + index, tactical: 60 + index, survival: 60 + index },
          },
        }),
      },
    }));
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [
        { match_id: "match-stale-summary", player_id: "player_a", platform: "kakao", data: { fullResult: staleFullResult } },
        ...currentRows,
      ],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-stale-summary", ...currentRows.map((row) => row.match_id)],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).not.toContain("STALE_SUMMARY_MARKER");
    expect(capturedPrompt).not.toContain("9999");
    expect(capturedPrompt).toContain("CURRENT_SUMMARY_MARKER_5");
    expect(visuals.tactical.counts.knocks).toBe(6);
    expect(summaryCache.upsert).toHaveBeenCalledTimes(1);
  });

  it("ai-summary는 공식 matchType이어도 AI/bot gameMode metadata를 latest10·best5 및 Gemini prompt에서 제외한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const humanMatch = createSummaryMatch("match-human-summary", {
      createdAt: "2026-08-28T00:01:00.000Z",
      matchType: "official",
      gameMode: "squad-fpp",
      benchmark: {
        score: 70,
        impactScore: 70,
        impactReasons: ["HUMAN_SUMMARY_MARKER"],
        breakdown: { combat: 70, tactical: 70, survival: 70 },
      },
    });
    const aiMatch = createSummaryMatch("match-ai-summary", {
      createdAt: "2026-08-28T00:02:00.000Z",
      matchType: "official",
      gameMode: "squad-ai",
      benchmark: {
        score: 999,
        impactScore: 999,
        impactReasons: ["AI_SUMMARY_CONTAMINATION_MARKER"],
        breakdown: { combat: 99, tactical: 99, survival: 99 },
      },
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [
        { match_id: "match-human-summary", player_id: "player_a", platform: "kakao", data: { fullResult: humanMatch } },
        { match_id: "match-ai-summary", player_id: "player_a", platform: "kakao", data: { fullResult: aiMatch } },
      ],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-human-summary", "match-ai-summary"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.latestMatchCount).toBe(1);
    expect(visuals.bestMatchCount).toBe(1);
    expect(capturedPrompt).toContain("HUMAN_SUMMARY_MARKER");
    expect(capturedPrompt).not.toContain("AI_SUMMARY_CONTAMINATION_MARKER");
  });

  it("ai-summary는 cached row와 fullResult의 custom/event/secondary evidence를 합집합으로 판정한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const humanMatch = createSummaryMatch("match-evidence-human", {
      createdAt: "2026-08-28T00:01:00.000Z",
      matchType: "official",
      gameMode: "squad-fpp",
      benchmark: {
        score: 70,
        impactScore: 70,
        impactReasons: ["EVIDENCE_HUMAN_MARKER"],
        breakdown: { combat: 70, tactical: 70, survival: 70 },
      },
    });
    const contaminatedFullResult = createSummaryMatch("match-evidence-contaminated", {
      createdAt: "2026-08-28T00:02:00.000Z",
      matchType: "official",
      gameMode: "squad-fpp",
      matchInfo: { mode: "ranked" },
      attributes: { isCustomMatch: false, isEventMode: false },
      telemetryFlags: { isCustomGame: false, isEventMode: false },
      telemetry: [],
      benchmark: {
        score: 999,
        impactScore: 999,
        impactReasons: ["EVIDENCE_CONTAMINATION_MARKER"],
        breakdown: { combat: 99, tactical: 99, survival: 99 },
      },
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [
        { match_id: "match-evidence-human", player_id: "player_a", platform: "kakao", data: { fullResult: humanMatch } },
        {
          match_id: "match-evidence-contaminated",
          player_id: "player_a",
          platform: "kakao",
          data: {
            fullResult: contaminatedFullResult,
            attributes: { isCustomMatch: true, isEventMode: true },
            matchInfo: { mode: "normal" },
            telemetry: [{ _T: "LogMatchStart", isCustomGame: true, isEventMode: true }],
            telemetryFlags: { isCustomGame: true, isEventMode: true },
          },
        },
      ],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-evidence-human", "match-evidence-contaminated"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.latestMatchCount).toBe(1);
    expect(visuals.bestMatchCount).toBe(1);
    expect(capturedPrompt).toContain("EVIDENCE_HUMAN_MARKER");
    expect(capturedPrompt).not.toContain("EVIDENCE_CONTAMINATION_MARKER");
  });

  it("ai-summary preserves custom evidence when telemetry is split across an object and an array", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const human = createSummaryMatch("match-mixed-telemetry-human", {
      createdAt: "2026-08-28T00:01:00.000Z",
      matchType: "official",
      gameMode: "squad-fpp",
      benchmark: {
        score: 70,
        impactReasons: ["MIXED_TELEMETRY_HUMAN_MARKER"],
        breakdown: { combat: 70, tactical: 70, survival: 70 },
      },
    });
    const contaminated = createSummaryMatch("match-mixed-telemetry-contaminated", {
      createdAt: "2026-08-28T00:02:00.000Z",
      matchType: "official",
      gameMode: "squad-fpp",
      benchmark: {
        score: 999,
        impactReasons: ["MIXED_TELEMETRY_CONTAMINATION_MARKER"],
        breakdown: { combat: 99, tactical: 99, survival: 99 },
      },
      telemetry: { LogMatchStart: { isCustomGame: true } },
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [
        {
          match_id: human.matchId,
          player_id: "player_a",
          platform: "kakao",
          data: { fullResult: human },
        },
        {
          match_id: contaminated.matchId,
          player_id: "player_a",
          platform: "kakao",
          data: {
            fullResult: contaminated,
            telemetry: [{ _T: "LogMatchEnd" }],
          },
        },
      ],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: [human.matchId, contaminated.matchId],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.latestMatchCount).toBe(1);
    expect(capturedPrompt).not.toContain("MIXED_TELEMETRY_CONTAMINATION_MARKER");
  });

  it("ai-summary mixed high-score population excludes TDM/custom/event/unknown rows from latest10, best5, prompt, and benchmark mode", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const row = (matchId: string, overrides: Record<string, any>) => ({
      match_id: matchId,
      player_id: "player_a",
      platform: "kakao",
      data: { fullResult: createSummaryMatch(matchId, overrides) },
    });
    const validOfficial = row("mixed-official", {
      createdAt: "2026-08-28T00:01:00.000Z",
      gameMode: "squad-fpp",
      matchType: "official",
      benchmark: { score: 90, impactReasons: ["MIXED_VALID_OFFICIAL"], breakdown: { combat: 90, tactical: 90, survival: 90 } },
    });
    const validCompetitive = row("mixed-competitive", {
      createdAt: "2026-08-28T00:02:00.000Z",
      gameMode: "duo-fpp",
      matchType: "competitive",
      benchmark: { score: 80, impactReasons: ["MIXED_VALID_COMPETITIVE"], breakdown: { combat: 80, tactical: 80, survival: 80 } },
    });
    const tdm = row("mixed-tdm", {
      createdAt: "2026-08-28T00:03:00.000Z",
      gameMode: "tdm",
      matchType: "official",
      mapName: " Italy_TDM_Main ",
      benchmark: { score: 999, impactReasons: ["MIXED_TDM_CONTAMINATION"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });
    const custom = row("mixed-custom", {
      createdAt: "2026-08-28T00:04:00.000Z",
      gameMode: "squad-fpp",
      matchType: "official",
      attributes: { isCustomMatch: true },
      benchmark: { score: 998, impactReasons: ["MIXED_CUSTOM_CONTAMINATION"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });
    const event = row("mixed-event", {
      createdAt: "2026-08-28T00:05:00.000Z",
      gameMode: "squad-fpp",
      matchType: "official",
      telemetryFlags: { isEventMode: true },
      benchmark: { score: 997, impactReasons: ["MIXED_EVENT_CONTAMINATION"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });
    const unknown = row("mixed-unknown", {
      createdAt: "2026-08-28T00:06:00.000Z",
      gameMode: undefined,
      matchType: "official",
      benchmark: { score: 996, impactReasons: ["MIXED_UNKNOWN_CONTAMINATION"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [validOfficial, validCompetitive, tdm, custom, event, unknown],
      error: null,
    });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: [validOfficial.match_id, validCompetitive.match_id, tdm.match_id, custom.match_id, event.match_id, unknown.match_id],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.latestMatchCount).toBe(2);
    expect(visuals.bestMatchCount).toBe(2);
    expect(capturedPrompt).not.toMatch(/MIXED_(TDM|CUSTOM|EVENT|UNKNOWN)_CONTAMINATION/);
    expect(tierBenchmarks.eq).toHaveBeenCalledWith("game_mode", expect.stringMatching(/^(squad-fpp|duo-fpp)$/));
    expect(tierBenchmarks.eq).toHaveBeenCalledWith("match_type", expect.stringMatching(/^(official|competitive)$/));
    const benchmarkModes = tierBenchmarks.eq.mock.calls
      .filter(([column]: [string]) => column === "game_mode")
      .map(([, value]: [string, string]) => value);
    const benchmarkTypes = tierBenchmarks.eq.mock.calls
      .filter(([column]: [string]) => column === "match_type")
      .map(([, value]: [string, string]) => value);
    expect(benchmarkModes.length).toBeGreaterThan(0);
    expect(benchmarkModes.every((value: string) => ["squad-fpp", "duo-fpp"].includes(value))).toBe(true);
    expect(benchmarkTypes.length).toBeGreaterThan(0);
    expect(benchmarkTypes.every((value: string) => ["official", "competitive"].includes(value))).toBe(true);
  });

  it("ai-summary isolation aggregation keeps no-position rows unavailable and preserves measured zero", async () => {
    mockSummaryGeminiResponse();
    const missing = {
      match_id: "isolation-missing",
      player_id: "player_a",
      platform: "kakao",
      data: {
        fullResult: createSummaryMatch("isolation-missing", {
          createdAt: "2026-08-28T00:01:00.000Z",
          isolationData: { isCrossfire: false },
        }),
      },
    };
    const measured = {
      match_id: "isolation-measured",
      player_id: "player_a",
      platform: "kakao",
      data: {
        fullResult: createSummaryMatch("isolation-measured", {
          createdAt: "2026-08-28T00:02:00.000Z",
          isolationData: {
            isolationIndex: 2,
            combatIsolation: 0,
            deathIsolation: 0,
            minDist: 20,
            heightDiff: 4,
            teammateCount: 2,
            isCrossfire: false,
          },
        }),
      },
    };
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [missing, measured], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: [missing.match_id, measured.match_id],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.tactical.isolation).toMatchObject({
      isolationIndex: 2,
      minDist: 20,
      heightDiff: 4,
      teammateCount: 2,
    });
    expect(visuals.tactical.isolation.combatIsolation).toBe(0);
    expect(visuals.tactical.isolation.deathIsolation).toBe(0);
  });

  it("ai-summary isolation visuals remain unavailable when every selected row lacks position samples", async () => {
    mockSummaryGeminiResponse();
    const match = {
      match_id: "isolation-all-missing",
      player_id: "player_a",
      platform: "kakao",
      data: { fullResult: createSummaryMatch("isolation-all-missing", { isolationData: { isCrossfire: false } }) },
    };
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [match], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: [match.match_id],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(visuals.tactical.isolation).toBeNull();
  });

  it("ai-summary는 stale row와 selection에서 제외된 current row만 있으면 409로 fail-closed한다", async () => {
    const staleFullResult = createSummaryMatch("match-stale-filtered", {
      v: RESULT_VERSION - 1,
      benchmark: {
        score: 9999,
        impactReasons: ["STALE_FILTERED_MARKER"],
        breakdown: { combat: 99, tactical: 99, survival: 99 },
      },
    });
    const filteredCurrentFullResult = createSummaryMatch("match-current-event", {
      v: RESULT_VERSION,
      gameMode: "event",
      benchmark: {
        score: 88,
        impactReasons: ["CURRENT_EVENT_MARKER"],
        breakdown: { combat: 88, tactical: 88, survival: 88 },
      },
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [
        { match_id: "match-stale-filtered", player_id: "player_a", platform: "kakao", data: { fullResult: staleFullResult } },
        { match_id: "match-current-event", player_id: "player_a", platform: "kakao", data: { fullResult: filteredCurrentFullResult } },
      ],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-stale-filtered", "match-current-event"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 오래된 cached 10개가 있어도 요청 최신 match ID를 fallback으로 hydrate한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });
    const oldRows = Array.from({ length: 10 }, (_, index) => {
      const matchId = `match-old-${index}`;
      return {
        match_id: matchId,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(matchId, {
            createdAt: new Date(Date.UTC(2026, 5, 1, index)).toISOString(),
            benchmark: { score: 1, impactScore: 1, impactReasons: [`OLD_MARKER_${index}`], breakdown: { combat: 1, tactical: 1, survival: 1 } },
          }),
        },
      };
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: oldRows, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const newest = createSummaryMatch("match-newest", {
      createdAt: "2026-08-30T00:00:00.000Z",
      benchmark: { score: 99, impactScore: 99, impactReasons: ["REQUESTED_NEWEST_MARKER"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(newest), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-newest", ...oldRows.map((row) => row.match_id)],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("match-newest");
    expect(capturedPrompt).toContain("REQUESTED_NEWEST_MARKER");
    expect(records.find((record) => record.type === "visuals")?.data.latestMatchCount).toBe(10);
  });

  it("ai-summary는 요청 최신 창의 첫 fallback이 AI로 제외되어도 뒤의 missing ID를 계속 hydrate한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });
    const oldRows = Array.from({ length: 10 }, (_, index) => {
      const matchId = `match-hydration-old-${index}`;
      return {
        match_id: matchId,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(matchId, {
            createdAt: new Date(Date.UTC(2026, 5, 1, index)).toISOString(),
            benchmark: { score: 1, impactScore: 1, impactReasons: [`OLD_HYDRATION_MARKER_${index}`], breakdown: { combat: 1, tactical: 1, survival: 1 } },
          }),
        },
      };
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: oldRows, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const aiExcluded = createSummaryMatch("match-hydration-ai", {
      createdAt: "2026-08-30T00:00:00.000Z",
      matchType: "airoyale",
      benchmark: { score: 999, impactScore: 999, impactReasons: ["AI_SHOULD_BE_EXCLUDED"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });
    const requestedLater = createSummaryMatch("match-hydration-later", {
      createdAt: "2026-08-29T00:00:00.000Z",
      benchmark: { score: 99, impactScore: 99, impactReasons: ["REQUESTED_LATER_MARKER"], breakdown: { combat: 99, tactical: 99, survival: 99 } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(aiExcluded), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementationOnce(async (_input, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (init?.signal?.aborted) return new Response("aborted", { status: 499 });
        return new Response(JSON.stringify(requestedLater), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-hydration-ai", "match-hydration-later", ...oldRows.map((row) => row.match_id)],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(capturedPrompt).toContain("REQUESTED_LATER_MARKER");
    expect(records.find((record) => record.type === "visuals")?.data.latestMatchCount).toBe(10);
  });

  it("ai-summary는 embedded match ID가 빠진 processed row를 선택·prompt·Gemini에서 제외한다", async () => {
    mockSummaryGeminiResponse();
    const invalidFullResult = createSummaryMatch("match-missing-embedded");
    delete (invalidFullResult as { matchId?: string }).matchId;
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-missing-embedded",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: invalidFullResult },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-missing-embedded"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["player_id", { match_id: "match-missing-storage-player", platform: "kakao" }],
    ["platform", { match_id: "match-missing-storage-platform", player_id: "player_a" }],
  ])("ai-summary는 storage %s가 빠진 processed row를 합성하지 않고 miss로 처리한다", async (_field, storageRow) => {
    mockSummaryGeminiResponse();
    const matchId = storageRow.match_id as string;
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{
        ...storageRow,
        data: { fullResult: createSummaryMatch(matchId) },
      }],
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: [matchId],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary processed dependency outage는 metadata-only 400 대신 retryable 503을 반환한다", async () => {
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: null,
      error: { code: "PGRST002", status: 503, message: "schema cache unavailable" },
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-db-outage"],
      nickname: "Player_A",
      platform: "kakao",
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AI summary data store is temporarily unavailable.",
      errorCode: "PUBG_AI_DATABASE_UNAVAILABLE",
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-summary benchmark dependency outage는 invented defaults 없이 retryable 503을 반환한다", async () => {
    mockSummaryGeminiResponse();
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-benchmark-outage",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-benchmark-outage") },
      }],
      error: null,
    });
    const benchmarkChain = createQueryChain({
      data: null,
      error: { code: "PGRST002", status: 503, message: "schema cache unavailable" },
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: benchmarkChain,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-benchmark-outage"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AI summary data store is temporarily unavailable.",
      errorCode: "PUBG_AI_DATABASE_UNAVAILABLE",
      retryable: true,
    });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 /api/pubg/match fallback의 stale SWR 응답도 Gemini에 전달하지 않는다", async () => {
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fallbackStale = createSummaryMatch("match-fallback-stale", { v: RESULT_VERSION - 1 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(fallbackStale),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-fallback-stale"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary tier 점수는 global_benchmarks가 아닌 telemetry benchmark의 0·문자열 값을 동일 분모로 평균한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const specs = [
      { id: "zero-score", score: 0, breakdown: { combat: 0, tactical: 0, survival: 0 } },
      { id: "string-score", score: "20", breakdown: { combat: "20", tactical: "30", survival: "40" } },
    ];
    const telemetry = createQueryChain({
      data: specs.map((spec, index) => ({
        match_id: spec.id,
        player_id: "player_a",
        platform: "kakao",
        data: {
          fullResult: createSummaryMatch(spec.id, {
            createdAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
            benchmark: { score: spec.score, breakdown: spec.breakdown },
          }),
        },
      })),
      error: null,
    });
    const summaryCache = createQueryChain();
    const globalBenchmarks = createQueryChain({
      data: specs.map((spec) => ({
        match_id: spec.id,
        score: 99,
        combat_score: 99,
        tactical_score: 99,
        survival_score: 99,
      })),
      error: null,
    });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: specs.map((spec) => spec.id),
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const visuals = records.find((record) => record.type === "visuals")?.data;

    expect(response.status).toBe(200);
    expect(capturedPrompt).toContain("평균 화력: 320");
    expect(visuals.tierBreakdown).toEqual({ combat: 10, tactical: 15, survival: 20, total: 10 });
  });

  it("ai-summary는 processed row ID와 embedded fullResult ID가 다르면 row를 무시한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-requested",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-embedded") },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-requested"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 fallback의 returned ID가 requested canonical ID와 다르면 fallback을 무시한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(createSummaryMatch("match-other")),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["shard:match-requested"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary fallback은 Host 헤더가 아니라 서버가 설정한 origin만 사용한다", async () => {
    mockSummaryGeminiResponse();

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trusted.bgms.test/base/path/");
    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(createSummaryMatch("trusted-origin-match")),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["trusted-origin-match"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }, { host: "evil.example:8443" }));

    expect(response.status).toBe(200);
    const nestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(nestedUrl.origin).toBe("https://trusted.bgms.test");
    expect(nestedUrl.pathname).toBe("/api/pubg/match");
  });

  it("ai-summary는 fallback 응답에 canonical match ID가 없으면 무시한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: createQueryChain({ data: [], error: null }),
      benchmark_stats_by_tier: createQueryChain({ data: null, error: null }),
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fallbackWithoutId: Record<string, any> = createSummaryMatch("missing-id-fallback");
    delete fallbackWithoutId.matchId;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(fallbackWithoutId),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["missing-id-fallback"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 stats가 비어 있는 fallback을 full result로 간주하지 않는다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({ data: [], error: null });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        matchId: "match-empty-stats",
        player_id: "player_a",
        platform: "kakao",
        stats: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-empty-stats"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(409);
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary의 force는 누락 매치 하위 요청에 재분석 권한으로 전파하지 않는다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({ data: [], error: null });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(createSummaryMatch("match-missing")),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-missing"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const nestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(nestedUrl.pathname).toBe("/api/pubg/match");
    expect(nestedUrl.searchParams.get("force")).toBeNull();
  });

  it("ai-summary는 캐시된 최종 리포트의 과한 팀 비난 표현을 순화해서 반환한다", async () => {
    const cachedFinal = JSON.stringify(createValidSummaryFinal({
      signature: "테스트",
      signatureSub: "검증",
      finalVerdict: "혼자 다 해먹는 화력이고 팀 지원 지표가 바닥입니다.",
    }));
    const summaryCache = createQueryChain({
      data: {
        ai_result: {
          visuals: { ok: true },
          final: cachedFinal,
        },
      },
      error: null,
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-cached",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-cached") },
      }],
      error: null,
    });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-cached"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    const text = await response.text();

    expect(text).toContain("강한 화력을 보여주는");
    expect(text).toContain("팀 지원 지표 보완이 필요");
    expect(text).not.toContain("혼자 다 해먹");
    expect(text).not.toContain("팀 지원 지표가 바닥");
  });

  it("ai-summary는 신규 Gemini 최종 리포트도 순화한 뒤 캐시에 저장한다", async () => {
    mockSummaryGeminiRawText(JSON.stringify(createValidSummaryFinal({
      signature: "테스트",
      signatureSub: "검증",
      finalVerdict: "혼자 다 해먹는 화력이고 팀 지원 지표가 바닥입니다.",
    })));

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-sanitize-summary",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-sanitize-summary") },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-sanitize-summary"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const text = await response.text();
    const upsertPayload = summaryCache.upsert.mock.calls[0]?.[0];

    expect(text).toContain("강한 화력을 보여주는");
    expect(text).toContain("팀 지원 지표 보완이 필요");
    expect(text).not.toContain("혼자 다 해먹");
    expect(text).not.toContain("팀 지원 지표가 바닥");
    expect(upsertPayload.ai_result.final).toContain("강한 화력을 보여주는");
    expect(upsertPayload.ai_result.final).not.toContain("혼자 다 해먹");
  });

  it("ai-summary는 성공한 긴 백업을 느린 백업으로 단정하지 않도록 프롬프트에 결과 맥락을 포함한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const summaryCache = createQueryChain();
    const winningRecoveryMatch = createSummaryMatch("match-win", {
      player_id: "kangheesung_",
      stats: {
        name: "KangHeeSung_",
        kills: 4,
        assists: 1,
        DBNOs: 3,
        damageDealt: 520,
        processedDamageDealt: 520,
        winPlace: 1,
        timeSurvived: 1800,
      },
      tradeStats: {
        teammateKnocks: 1,
        tradeKills: 2,
        suppCount: 1,
        revCount: 1,
        smokeCount: 0,
        smokeRescues: 0,
        reactionLatencyMs: 600,
        tradeLatencyMs: 22000,
        enemyTeamWipes: 1,
      },
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-win",
        player_id: "kangheesung_",
        platform: "kakao",
        data: { fullResult: winningRecoveryMatch },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-win"],
      nickname: "KangHeeSung_",
      platform: "kakao",
      force: true,
    }));
    const text = await response.text();

    expect(text).toContain("\"type\":\"done\"");
    // Assert only after the route has returned. Assertions thrown from the
    // model callback are otherwise swallowed by the route's model fallback.
    expect(capturedPrompt).toContain("22.00s");
    expect(capturedPrompt).toContain("교전 정리 후 복구 성공");
    expect(capturedPrompt).toContain("느린 백업이라고 단정하지 말 것");
    expect(capturedPrompt).toContain("적 제압 2회/전멸 기여 1회와 소생 1회");
    expect(mockGenerateContentStream).toHaveBeenCalled();
  });

  it("ai-summary는 피해형 투척 수를 연막 포함 총 투척 수와 분리해 프롬프트에 전달한다", async () => {
    let capturedPrompt = "";
    mockSummaryGeminiResponse((prompt) => {
      capturedPrompt = prompt;
    });

    const summaryCache = createQueryChain();
    const utilityMatch = createSummaryMatch("match-utility", {
      player_id: "kangheesung_",
      platform: "kakao",
      stats: {
        name: "KangHeeSung_",
        kills: 2,
        assists: 1,
        DBNOs: 1,
        damageDealt: 320,
        processedDamageDealt: 320,
        winPlace: 4,
        timeSurvived: 1200,
      },
      combatPressure: {
        pressureIndex: 2.4,
        utilityStats: {
          throwCount: 12,
          lethalThrowCount: 3,
          hitCount: 1,
          totalDamage: 90,
          killCount: 0,
        },
      },
      itemUseSummary: { frags: 2, molotovs: 1, smokes: 9 },
      itemUseStats: { distanceDamage: { short: 100, mid: 150, long: 70 } },
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-utility",
        player_id: "kangheesung_",
        platform: "kakao",
        data: { fullResult: utilityMatch },
      }],
      error: null,
    });
    const globalBenchmarks = createQueryChain({ data: [], error: null });
    const tierBenchmarks = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      global_benchmarks: globalBenchmarks,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-utility"],
      nickname: "KangHeeSung_",
      platform: "kakao",
      force: true,
    }));
    const text = await response.text();

    expect(text).toContain("\"type\":\"done\"");
    expect(capturedPrompt).toContain("총 투척 12회 (연막 9회, 피해형 3회, 피해 적중 1회)");
    expect(mockGenerateContentStream).toHaveBeenCalled();
  });

  it("ai-summary는 충분한 표본에서도 NULL benchmark metric을 기본값으로 바꾸지 않고 비교 증거를 숨긴다", async () => {
    let capturedPrompt = "";
    const forbiddenComparisonFinal = createValidSummaryFinal({
      signature: "상위권 평균 화력 250 전술가",
      signatureSub: "엘리트 벤치마크 평균 화력 250 대비 강점",
      finalVerdict: "상위권 평균 화력 250보다 낮아 벤치마크 보완이 필요합니다.",
      debateIssues: createValidSummaryFinal().debateIssues.map((issue: any) => ({
        ...issue,
        question: "상위권 평균 화력 250과 비교해 충분한가?",
        spicyOpinion: "엘리트 벤치마크 평균 화력 250보다 낮습니다.",
        kindOpinion: "벤치마크 평균 화력 250 대비 가능성이 있습니다.",
        reason: "상위권 평균 화력 250 대비 차이",
        evaluation: "엘리트 벤치마크 평균 화력 250 평가",
      })),
      actionItems: [{ icon: "target", title: "벤치마크 평균 화력 250 개선", desc: "상위권 평균 화력 250을 따라가세요." }],
    });
    mockSummaryGeminiRawText(JSON.stringify(forbiddenComparisonFinal), (prompt) => {
      capturedPrompt = prompt;
    });

    const tierBenchmarks = createQueryChain({
      data: {
        game_mode: "squad",
        match_type: "competitive",
        tier: "B",
        match_count: 5,
        avg_damage: null,
        avg_duel_win_rate: null,
        avg_initiative_rate: null,
        avg_counter_latency_ms: null,
        avg_trade_latency_ms: null,
      },
      error: null,
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-null-benchmark-metric",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-null-benchmark-metric") },
      }],
      error: null,
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-null-benchmark-metric"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const finalData = JSON.parse(records.find((record) => record.type === "final")?.data || "{}");
    const focusStart = capturedPrompt.indexOf("### [분석 집중 영역 (Debate Issues)]");
    const focusSection = focusStart >= 0 ? capturedPrompt.slice(focusStart, focusStart + 240) : "";

    expect(response.status).toBe(200);
    expect(capturedPrompt).not.toContain("엘리트");
    expect(capturedPrompt).not.toContain("상위권");
    expect(capturedPrompt).not.toContain("동일 조건·동일 티어 BGMS 분석 표본 평균: 250");
    expect(capturedPrompt).not.toContain("Benchmark: 50");
    expect(focusSection).toContain("유틸리티 활용");
    expect(focusSection).toContain("포지셔닝");
    expect(focusSection).toContain("생존 운영");
    expect(focusSection).not.toContain("화력");
    expect(focusSection).not.toContain("교전 주도권");
    expect(focusSection).not.toContain("12");
    const proseFields = [
      finalData.signature,
      finalData.signatureSub,
      finalData.finalVerdict,
      ...finalData.debateIssues.flatMap((issue: any) => [
        issue.topic,
        issue.question,
        issue.spicyOpinion,
        issue.kindOpinion,
        issue.reason,
        issue.evaluation,
      ]),
      ...finalData.actionItems.flatMap((item: any) => [item.title, item.desc]),
    ].join(" ");
    expect(proseFields).not.toMatch(/상위권|엘리트|벤치마크|benchmark/i);
    expect(proseFields).not.toContain("250");
    expect(finalData.debateIssues.every((issue: any) => issue.benchmarkStats.length === 0)).toBe(true);
  });

  it("ai-summary partial NULL benchmark rows preserve observed damage while stripping unsupported duel prose and evidence", async () => {
    const providerFinal = createValidSummaryFinal({
      signature: "상위권 평균 화력 999 전술가",
      signatureSub: "상위권 평균 화력 999 대비 강점",
      finalVerdict: "상위권 평균 50%의 1:1 승률은 참고할 수 없고, 상위권 평균 화력 999 대비 화력은 좋습니다.",
      debateIssues: [
        {
          ...createValidSummaryFinal().debateIssues[0],
          topic: "화력",
          userStats: [{ label: "평균 화력", value: "999" }],
          benchmarkStats: [{ label: "상위권 평균 화력", value: "999" }],
        },
        {
          ...createValidSummaryFinal().debateIssues[1],
          topic: "1:1 결정력",
          question: "1:1 승률이 상위권 평균 50%보다 높은가?",
          spicyOpinion: "상위권 평균 50%의 1:1 승률과 비교하면 부족합니다.",
          kindOpinion: "상위권 평균 50%의 1:1 승률보다 안정적입니다.",
          reason: "상위권 평균 50%의 1:1 승률 대비 차이",
          evaluation: "상위권 평균 50%의 1:1 승률 평가",
          userStats: [{ label: "1:1 교전 승률", value: "79%" }],
          benchmarkStats: [{ label: "상위권 1:1 승률", value: "50%" }],
        },
        createValidSummaryFinal().debateIssues[2],
      ],
      actionItems: [{ icon: "target", title: "1:1 승률 50% 개선", desc: "상위권 평균 50%를 기준으로 보완하세요." }],
    });
    mockSummaryGeminiRawText(JSON.stringify(providerFinal));

    const tierBenchmarks = createQueryChain({
      data: {
        game_mode: "squad",
        match_type: "competitive",
        tier: "B",
        match_count: 5,
        filter_version: 8,
        population_evidence_version: POPULATION_EVIDENCE_VERSION,
        avg_damage: 300,
        avg_damage_count: 5,
        avg_duel_win_rate: null,
        avg_initiative_rate: null,
        avg_counter_latency_ms: null,
        avg_trade_latency_ms: null,
      },
      error: null,
    });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-partial-null-benchmark",
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult: createSummaryMatch("match-partial-null-benchmark") },
      }],
      error: null,
    });
    const summaryCache = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
      processed_match_telemetry: telemetry,
      benchmark_stats_by_tier: tierBenchmarks,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-partial-null-benchmark"],
      nickname: "Player_A",
      platform: "kakao",
      force: true,
    }));
    const records = parseSummaryNdjson(await response.text());
    const finalData = JSON.parse(records.find((record) => record.type === "final")?.data || "{}");
    const cachedFinal = JSON.parse(summaryCache.upsert.mock.calls[0]?.[0]?.ai_result?.final || "{}");
    const proseFields = [
      finalData.signature,
      finalData.signatureSub,
      finalData.finalVerdict,
      ...finalData.debateIssues.flatMap((issue: any) => [
        issue.topic,
        issue.question,
        issue.spicyOpinion,
        issue.kindOpinion,
        issue.reason,
        issue.evaluation,
      ]),
      ...finalData.actionItems.flatMap((item: any) => [item.title, item.desc]),
    ].join(" ");
    const cachedProseFields = [
      cachedFinal.signature,
      cachedFinal.signatureSub,
      cachedFinal.finalVerdict,
      ...cachedFinal.debateIssues.flatMap((issue: any) => [
        issue.topic,
        issue.question,
        issue.spicyOpinion,
        issue.kindOpinion,
        issue.reason,
        issue.evaluation,
      ]),
      ...cachedFinal.actionItems.flatMap((item: any) => [item.title, item.desc]),
    ].join(" ");

    expect(response.status).toBe(200);
    expect(finalData.debateIssues[0]).toMatchObject({
      userStats: [{ label: "평균 화력", value: "320" }],
      benchmarkStats: [{ label: "동일 티어 평균 화력", value: "300" }],
    });
    expect(cachedFinal.debateIssues[0]).toMatchObject({
      userStats: [{ label: "평균 화력", value: "320" }],
      benchmarkStats: [{ label: "동일 티어 평균 화력", value: "300" }],
    });
    expect(proseFields).not.toContain("50%");
    expect(cachedProseFields).not.toContain("50%");
    expect(proseFields).not.toContain("999");
    expect(cachedProseFields).not.toContain("999");
    expect(proseFields).not.toMatch(/(?:상위권|동일\s*티어|엘리트|벤치마크|benchmark).{0,20}(?:1:1|승률)|(?:1:1|승률).{0,20}(?:상위권|동일\s*티어|엘리트|벤치마크|benchmark)/i);
    expect(cachedProseFields).not.toMatch(/(?:상위권|동일\s*티어|엘리트|벤치마크|benchmark).{0,20}(?:1:1|승률)|(?:1:1|승률).{0,20}(?:상위권|동일\s*티어|엘리트|벤치마크|benchmark)/i);
    expect(finalData.debateIssues[1].userStats).toEqual([]);
    expect(finalData.debateIssues[1].benchmarkStats).toEqual([]);
    expect(cachedFinal.debateIssues[1].userStats).toEqual([]);
    expect(cachedFinal.debateIssues[1].benchmarkStats).toEqual([]);

    // Replay the same provider payload through the cache path as well: cache
    // normalization must apply the exact same metric-scoped prose guard.
    const firstHash = summaryCache.upsert.mock.calls[0]?.[0]?.match_ids_hash;
    configureSummaryCacheHitForHash(summaryCache, firstHash, {
      visuals: { latestMatchCount: 999, bestMatchCount: 999 },
      final: JSON.stringify(providerFinal),
    });
    mockGenerateContentStream.mockClear();
    const cacheResponse = await aiSummaryPOST(createRequest({
      matchIds: ["match-partial-null-benchmark"],
      nickname: "Player_A",
      platform: "kakao",
    }));
    const cacheRecords = parseSummaryNdjson(await cacheResponse.text());
    const cacheFinal = JSON.parse(cacheRecords.find((record) => record.type === "final")?.data || "{}");
    const cacheProseFields = [
      cacheFinal.signature,
      cacheFinal.signatureSub,
      cacheFinal.finalVerdict,
      ...cacheFinal.debateIssues.flatMap((issue: any) => [
        issue.topic,
        issue.question,
        issue.spicyOpinion,
        issue.kindOpinion,
        issue.reason,
        issue.evaluation,
      ]),
      ...cacheFinal.actionItems.flatMap((item: any) => [item.title, item.desc]),
    ].join(" ");
    expect(cacheResponse.status).toBe(200);
    expect(cacheRecords.map((record) => record.type)).toEqual(["visuals", "final", "done"]);
    expect(cacheProseFields).not.toContain("999");
    expect(cacheProseFields).not.toContain("50%");
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-squad는 Gemini 실패 시 측정되지 않은 fallback 대신 503을 반환한다", async () => {
    mockGenerateContent.mockRejectedValue(new Error("Gemini unavailable"));
    mockGetSquadAnalysisData.mockResolvedValue(canonicalSquadAnalysis);

    const squadCache = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      squad_ai_coaching_cache: squadCache,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSquadPOST(createRequest({
      groupKey: "alpha,beta",
      nickname: "Player_A",
      platform: "steam",
      coachingStyle: "mild",
      squadGrade: "A",
      matchIds: ["match-1", "match-2"],
      stats: {
        avgIsolation: 1.5,
        avgTradeLatency: 8000,
        avgCoverRate: 0.45,
        totalSmokeRescues: 2,
        totalRevives: 3,
        totalTeamWipes: 1,
      },
      scores: {
        formation: 70,
        backupSpeed: 75,
        survivalCare: 80,
        focusFire: 76,
        teamWipe: 65,
      },
      roleProfiles: [
        { name: "Player_A", role: "Entry", roleDesc: "진입", avgDamage: 300, avgKills: 2, avgAssists: 1, avgDbnos: 1, shares: { damage: 55, kill: 50, assist: 30, dbno: 50 } },
        { name: "Beta", role: "Support", roleDesc: "지원", avgDamage: 180, avgKills: 1, avgAssists: 2, avgDbnos: 1, shares: { damage: 45, kill: 50, assist: 70, dbno: 50 } },
      ],
    }));
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toContain("스쿼드 AI 분석을 완료하지 못했습니다");
    expect(json).toMatchObject({ errorCode: "PUBG_AI_SQUAD_PROVIDER_ERROR", retryable: true });
    expect(squadCache.eq).toHaveBeenCalledWith("player_id", "player_a");
    expect(squadCache.eq).toHaveBeenCalledWith("platform", "steam");
    expect(squadCache.eq).toHaveBeenCalledWith("prompt_version", AI_CACHE_VERSION);
  });

  it("ai-squad는 캐시된 스쿼드 코칭 결과를 순화해서 반환한다", async () => {
    mockGetSquadAnalysisData.mockResolvedValue(canonicalSquadAnalysis);
    const squadCache = createQueryChain({
      data: {
        ai_result: {
          squadGrade: "A",
          summary: "나머지 팀원들의 화력 지원이 전무합니다.",
          strength: "검증",
          weakness: "존재감이 희미합니다.",
          coaching: "혼자 다 해먹는 구조입니다.",
          memberFeedbacks: [
            { name: "Player_A", praise: "검증", fault: "팀 전체가 휘청거릴 수 있으니 조심하십시오.", advice: "검증" },
          ],
          overallOpinion: "검증",
        },
      },
      error: null,
    });
    const supabase = createSupabaseMock({
      squad_ai_coaching_cache: squadCache,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSquadPOST(createRequest({
      groupKey: "alpha,beta",
      nickname: "Player_A",
      platform: "steam",
      coachingStyle: "spicy",
      squadGrade: "A",
      matchIds: ["match-1", "match-2"],
      stats: {
        avgIsolation: 1.5,
        avgTradeLatency: 8000,
        avgCoverRate: 0.45,
        totalSmokeRescues: 2,
        totalRevives: 3,
        totalTeamWipes: 1,
      },
      scores: {
        formation: 70,
        backupSpeed: 75,
        survivalCare: 80,
        focusFire: 76,
        teamWipe: 65,
      },
      roleProfiles: [
        { name: "Player_A", role: "Entry", roleDesc: "진입", avgDamage: 300, avgKills: 2, avgAssists: 1, avgDbnos: 1, shares: { damage: 55, kill: 50, assist: 30, dbno: 50 } },
      ],
    }));
    const json = await response.json();
    const text = JSON.stringify(json);

    expect(text).toContain("다른 팀원들의 화력 지원 보완이 필요");
    expect(text).toContain("교전 기여를 더 선명하게 만들 필요가 있습니다");
    expect(text).toContain("강한 화력을 보여주는");
    expect(text).toContain("팀 교전 안정성이 흔들릴 수 있으니");
    expect(text).not.toContain("전무");
    expect(text).not.toContain("존재감이 희미");
    expect(text).not.toContain("혼자 다 해먹");
    expect(text).not.toContain("팀 전체가 휘청");
  });

  it("ai-squad는 신규 Gemini 스쿼드 코칭 결과도 순화해서 캐시에 저장한다", async () => {
    mockGetSquadAnalysisData.mockResolvedValue(canonicalSquadAnalysis);
    mockSquadGeminiJson({
      squadGrade: "A",
      summary: "나머지 팀원들의 화력 지원이 전무합니다.",
      strength: "검증",
      weakness: "존재감이 희미합니다.",
      coaching: "혼자 다 해먹는 구조입니다.",
      memberFeedbacks: [
        { name: "Player_A", praise: "검증", fault: "팀 전체가 휘청거릴 수 있으니 조심하십시오.", advice: "검증" },
      ],
      overallOpinion: "검증",
    });

    const squadCache = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({
      squad_ai_coaching_cache: squadCache,
    });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });

    const response = await aiSquadPOST(createRequest({
      groupKey: "alpha,beta",
      nickname: "Player_A",
      platform: "steam",
      coachingStyle: "spicy",
      squadGrade: "A",
      matchIds: ["match-1", "match-2"],
      stats: {
        avgIsolation: 1.5,
        avgTradeLatency: 8000,
        avgCoverRate: 0.45,
        totalSmokeRescues: 2,
        totalRevives: 3,
        totalTeamWipes: 1,
      },
      scores: {
        formation: 70,
        backupSpeed: 75,
        survivalCare: 80,
        focusFire: 76,
        teamWipe: 65,
      },
      roleProfiles: [
        { name: "Player_A", role: "Entry", roleDesc: "진입", avgDamage: 300, avgKills: 2, avgAssists: 1, avgDbnos: 1, shares: { damage: 55, kill: 50, assist: 30, dbno: 50 } },
      ],
    }));
    const json = await response.json();
    const text = JSON.stringify(json);
    const upsertPayload = squadCache.upsert.mock.calls[0]?.[0];

    expect(text).toContain("다른 팀원들의 화력 지원 보완이 필요");
    expect(text).toContain("교전 기여를 더 선명하게 만들 필요가 있습니다");
    expect(text).not.toContain("전무");
    expect(text).not.toContain("존재감이 희미");
    expect(text).not.toContain("혼자 다 해먹");
    expect(upsertPayload.ai_result.summary).toContain("다른 팀원들의 화력 지원 보완이 필요");
    expect(JSON.stringify(upsertPayload.ai_result)).not.toContain("혼자 다 해먹");
  });
});

describe("AI cache cleanup", () => {
  it("새 AI 캐시 테이블 3종을 created_at 기준 30일 보존 정책으로 정리한다", async () => {
    const calls: Array<{ table: string; column: string; cutoff: string }> = [];
    const supabase = {
      from: vi.fn((table: string) => ({
        delete: vi.fn(() => ({
          lt: vi.fn(async (column: string, cutoff: string) => {
            calls.push({ table, column, cutoff });
            return { count: 1, error: null };
          }),
        })),
      })),
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await cleanupExpiredCache(supabase as any, new Date("2026-06-11T00:00:00.000Z"));

    expect(AI_CACHE_RETENTION_DAYS).toBe(30);
    expect(AI_CACHE_TABLES.map((table) => table.name)).toEqual([
      "match_ai_coaching_cache",
      "player_ai_summary_cache",
      "squad_ai_coaching_cache",
    ]);
    expect(calls).toEqual(AI_CACHE_TABLES.map((table) => ({
      table: table.name,
      column: "created_at",
      cutoff: "2026-05-12T00:00:00.000Z",
    })));

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
