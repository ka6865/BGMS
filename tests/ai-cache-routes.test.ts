import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { POST as aiAnalyzePOST } from "../app/api/pubg/ai-analyze/route";
import { POST as aiSummaryPOST } from "../app/api/pubg/ai-summary/route";
import { POST as aiSquadPOST } from "../app/api/pubg/ai-squad/route";
import { AI_CACHE_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";
import { buildMatchSelectionKey, RECENT_MATCH_SELECTION_VERSION } from "../lib/pubg-analysis/recentMatchSelection";
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
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.or = vi.fn().mockResolvedValue(result);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.upsert = vi.fn().mockResolvedValue({ data: null, error: null });
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

function createRequest(body: any) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createSummaryMatch(matchId = "match-1", overrides: Record<string, any> = {}) {
  return {
    matchId,
    player_id: "player_a",
    platform: "kakao",
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

function mockSummaryGeminiResponse(assertPrompt?: (prompt: string) => void) {
  const json = JSON.stringify({
    signature: "테스트 전술가",
    signatureSub: "캐시 안정화 테스트 응답",
    finalVerdict: "검증용 최종 판정입니다.",
    debateIssues: [
      {
        topic: "전투력",
        question: "교전력이 충분한가?",
        spicyOpinion: "수치 확인 필요",
        kindOpinion: "개선 여지 있음",
        winner: "kind",
        reason: "검증 데이터",
        evaluation: "정상",
        userStats: [{ label: "딜량", value: "320" }],
        benchmarkStats: [{ label: "상위권", value: "300" }],
      },
    ],
    actionItems: [{ icon: "target", title: "검증", desc: "테스트 유지" }],
  });

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
  });

  it("ai-analyze는 match_id뿐 아니라 player_id, platform, prompt_version으로 캐시를 조회한다", async () => {
    const matchCache = createQueryChain({
      data: { ai_result: { text: "cached-player-a-analysis" } },
      error: null,
    });
    const telemetry = createQueryChain({ data: null, error: null });
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
    expect(telemetry.select).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-analyze는 캐시된 단일 경기 코칭의 과한 표현을 순화해서 반환한다", async () => {
    const matchCache = createQueryChain({
      data: { ai_result: { text: "혼자 다 해먹는 화력이고 팀 지원 지표가 바닥입니다." } },
      error: null,
    });
    const supabase = createSupabaseMock({
      match_ai_coaching_cache: matchCache,
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
    const telemetry = createQueryChain({ data: null, error: null });
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
    expect(telemetry.select).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("ai-summary는 force=true일 때 기존 AI 캐시 조회를 건너뛰고 새 결과를 upsert한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-1",
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
        prompt_version: AI_CACHE_VERSION,
      }),
      { onConflict: "player_id,platform,match_ids_hash,prompt_version" }
    );
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
    const expectedHash = crypto.createHash("sha256").update(`${AI_CACHE_VERSION}\n${selectionKey}`).digest("hex");
    expect(upsertPayload.match_ids_hash).toBe(expectedHash);
  });

  it("ai-summary는 매치 결과가 전혀 없으면 metadata-only cache miss 뒤 Gemini/upsert를 호출하지 않는다", async () => {
    const summaryCache = createQueryChain({ data: null, error: null });
    const supabase = createSupabaseMock({ player_ai_summary_cache: summaryCache });
    mockWithAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await aiSummaryPOST(createRequest({
      matchIds: ["match-without-data"],
      nickname: "Player_A",
      platform: "kakao",
    }));

    expect(response.status).toBe(400);
    expect(summaryCache.select).toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(summaryCache.upsert).not.toHaveBeenCalled();
  });

  it("ai-summary는 processed row ID와 embedded fullResult ID가 다르면 row를 무시한다", async () => {
    mockSummaryGeminiResponse();

    const summaryCache = createQueryChain({ data: null, error: null });
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-requested",
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

    expect(response.status).toBe(400);
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

    expect(response.status).toBe(400);
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

    expect(response.status).toBe(400);
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
    const cachedFinal = JSON.stringify({
      signature: "테스트",
      signatureSub: "검증",
      finalVerdict: "혼자 다 해먹는 화력이고 팀 지원 지표가 바닥입니다.",
      debateIssues: [],
      actionItems: [],
    });
    const summaryCache = createQueryChain({
      data: {
        ai_result: {
          visuals: { ok: true },
          final: cachedFinal,
        },
      },
      error: null,
    });
    const supabase = createSupabaseMock({
      player_ai_summary_cache: summaryCache,
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
    mockSummaryGeminiRawText(JSON.stringify({
      signature: "테스트",
      signatureSub: "검증",
      finalVerdict: "혼자 다 해먹는 화력이고 팀 지원 지표가 바닥입니다.",
      debateIssues: [],
      actionItems: [],
    }));

    const summaryCache = createQueryChain();
    const telemetry = createQueryChain({
      data: [{
        match_id: "match-sanitize-summary",
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
    mockSummaryGeminiResponse((prompt) => {
      expect(prompt).toContain("22.00s");
      expect(prompt).toContain("교전 정리 후 복구 성공");
      expect(prompt).toContain("느린 백업이라고 단정하지 말 것");
      expect(prompt).toContain("적 제압 2회/전멸 기여 1회와 소생 1회");
      expect(prompt).toContain("팀원을 방패");
      expect(prompt).toContain("팀원을 들러리");
      expect(prompt).toContain("화력 분담 보완");
      expect(prompt).toContain("팀 지원 지표 보완");
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
    expect(mockGenerateContentStream).toHaveBeenCalled();
  });

  it("ai-summary는 피해형 투척 수를 연막 포함 총 투척 수와 분리해 프롬프트에 전달한다", async () => {
    mockSummaryGeminiResponse((prompt) => {
      expect(prompt).toContain("총 투척 12회, 피해형 투척 3회, 피해 적중 1회");
      expect(prompt).toContain("연막 9회");
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
    expect(mockGenerateContentStream).toHaveBeenCalled();
  });

  it("ai-squad는 Gemini 실패 시 측정되지 않은 fallback 대신 503을 반환한다", async () => {
    mockGenerateContent.mockRejectedValue(new Error("Gemini unavailable"));

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
    expect(squadCache.eq).toHaveBeenCalledWith("player_id", "player_a");
    expect(squadCache.eq).toHaveBeenCalledWith("platform", "steam");
    expect(squadCache.eq).toHaveBeenCalledWith("prompt_version", AI_CACHE_VERSION);
  });

  it("ai-squad는 캐시된 스쿼드 코칭 결과를 순화해서 반환한다", async () => {
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
