import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as aiSummaryPOST } from "../app/api/pubg/ai-summary/route";
import { adaptObservedBenchmark } from "../lib/pubg-analysis/benchmarkAdapter";
import { CALCULATION_5_REDEFINED_METRICS } from "../lib/pubg-analysis/benchmarkLookup";
import {
  applyCalculationVersionGuard,
  buildSummaryCards,
  CALCULATION_5_BENCHMARK_KEYS,
  CALCULATION_5_COMPARISON_METRIC_IDS,
  countPriorCalculationMatches,
  parseSummaryCards,
  type SummaryEvidenceContext,
  type SummaryEvidenceInput,
} from "../lib/pubg-analysis/aiSummaryCards";
import { ANALYSIS_CALCULATION_VERSION, POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";

const mocks = vi.hoisted(() => ({
  withAuthGuard: vi.fn(),
  streamText: vi.fn(),
  prompts: [] as string[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: vi.fn((task: Promise<unknown>) => task),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: mocks.streamText,
  Output: { json: () => ({ type: "json" }) },
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => (modelName: string) => ({ modelName }),
}));

vi.mock("@/utils/supabase/guard", () => ({
  withAuthGuard: mocks.withAuthGuard,
}));

vi.mock("@/lib/pubg-analysis/aiUsageTracker", () => ({
  trackAiUsage: vi.fn(),
  trackAiFailure: vi.fn(),
}));

vi.mock("@/lib/pubg/privatePlayers", () => ({
  isPlayerPrivate: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/pubg/privatePlayerIdentity", () => ({
  resolvePrivatePlayerAccountId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({
  getSquadAnalysisData: vi.fn().mockResolvedValue(null),
}));

// 공급자 응답은 서버 카드 계획의 topicId·evidenceIds를 그대로 따른다. 카드 행 검사만 목표로 하므로 내용은 단순하다.
async function* providerStream(text: string) {
  yield { type: "start-step" };
  yield { type: "text-delta", text };
}

function providerText(prompt: string): string {
  const plan = prompt.split("### [SERVER_CARD_PLAN_V2]\n")[1]?.split("\n### [END_SERVER_CARD_PLAN_V2]")[0];
  if (!plan) return JSON.stringify(createValidSummaryFinal());
  const issues = (JSON.parse(plan) as Array<{ topicId: string; evidenceIds: string[] }>).map((card) => ({
    topicId: card.topicId,
    evidenceIds: [...card.evidenceIds],
    kindOpinion: "확인된 기록에서 강점이 보입니다.",
    spicyOpinion: "다음 교전에서 같은 기록이 이어지는지 확인하세요.",
    winner: null,
    reason: "관측된 기록에 근거합니다.",
    evaluation: "다음 경기에서 확인하세요.",
  }));
  return JSON.stringify({ ...createValidSummaryFinal(), debateIssues: issues });
}

function createValidSummaryFinal(): Record<string, unknown> {
  return {
    signature: "테스트 전술가",
    signatureSub: "계산 버전 가드 테스트 응답",
    finalVerdict: "검증용 최종 판정입니다.",
    debateIssues: [],
    actionItems: [{ icon: "target", title: "교전 점검", desc: "다음 교전 전에 상대 위치를 확인해 보세요." }],
  };
}

const context: SummaryEvidenceContext = {
  contextId: "ctx-calc5",
  gameMode: "squad-fpp",
  matchType: "competitive",
  tier: "A+",
  userMatchCount: 5,
  benchmarkSampleCount: 30,
  filterVersion: 8,
  populationVersion: POPULATION_EVIDENCE_VERSION,
};

function initiativeRow(overrides: Partial<SummaryEvidenceInput> = {}): SummaryEvidenceInput {
  return {
    metricId: "initiative_rate",
    label: "선제 타격 성공률",
    userValue: "50%",
    benchmarkValue: "35%",
    userNumericValue: 50,
    benchmarkNumericValue: 35,
    benchmarkLabel: "동일 티어 평균 선제 타격 성공률",
    unit: "%",
    sampleCount: 30,
    userMatchCount: 5,
    ...overrides,
  };
}

function damageRow(overrides: Partial<SummaryEvidenceInput> = {}): SummaryEvidenceInput {
  return {
    metricId: "damage_average",
    label: "평균 화력",
    userValue: "320",
    benchmarkValue: "250",
    userNumericValue: 320,
    benchmarkNumericValue: 250,
    benchmarkLabel: "동일 티어 평균 화력",
    unit: "",
    sampleCount: 30,
    userMatchCount: 5,
    ...overrides,
  };
}

const topics = ["교전 주도권", "복수 성공률 및 백업", "화력"];

function buildCards(rows: SummaryEvidenceInput[]) {
  return buildSummaryCards({ topics, evidence: rows, context });
}

describe("계산 5 비교 지표의 이전 계산 경기 가드", () => {
  describe("입력 집계와 카드 행", () => {
    it("이전 계산 경기와 누락 버전을 세고 현재 계산 경기만 있으면 0을 반환한다", () => {
      expect(countPriorCalculationMatches([
        { calculationVersion: ANALYSIS_CALCULATION_VERSION },
        { calculationVersion: ANALYSIS_CALCULATION_VERSION - 1 },
        {},
      ])).toBe(2);
      expect(countPriorCalculationMatches([{ calculationVersion: ANALYSIS_CALCULATION_VERSION }])).toBe(0);
    });

    it("계산 5 비교 지표는 이전 계산 경기가 섞이면 비교 평균을 떼고 개인 값과 경기 수를 남긴다", () => {
      const guarded = applyCalculationVersionGuard([initiativeRow(), damageRow()], 2);
      expect(guarded[0]).toMatchObject({
        metricId: "initiative_rate",
        userValue: "50%",
        benchmarkValue: null,
        benchmarkNumericValue: null,
        sampleCount: null,
        legacyCalculationMatchCount: 2,
      });
      expect(guarded[1]).toMatchObject({ metricId: "damage_average", benchmarkValue: "250", sampleCount: 30 });
      expect(guarded[1]).not.toHaveProperty("legacyCalculationMatchCount");
    });

    it("이전 계산 경기가 없으면 입력을 바꾸지 않는다", () => {
      const guarded = applyCalculationVersionGuard([initiativeRow()], 0);
      expect(guarded[0]).toMatchObject({ benchmarkValue: "35%", sampleCount: 30 });
      expect(guarded[0]).not.toHaveProperty("legacyCalculationMatchCount");
    });

    it("카드 입력 단계에서도 이전 계산 경기가 섞인 계산 5 지표는 비교 행이 되지 않는다", () => {
      const cards = buildCards(applyCalculationVersionGuard([initiativeRow(), damageRow()], 2));
      const initiativeCard = cards.find((card) => card.topicId === "initiative")!;
      const initiative = initiativeCard.evidence.find((row) => row.metricId === "initiative_rate")!;
      expect(initiative).toMatchObject({ status: "user_only", userValue: "50%", benchmarkValue: null, legacyCalculationMatchCount: 2 });
      expect(initiativeCard.dataStatus).toBe("user_only");
    });

    it("입력에 이전 계산 경기 표시가 있어도 입력 단계에서 비교 값을 버린다", () => {
      const cards = buildCards([initiativeRow({ legacyCalculationMatchCount: 3 })]);
      const initiative = cards.find((card) => card.topicId === "initiative")!.evidence[0];
      expect(initiative).toMatchObject({ status: "user_only", benchmarkValue: null, legacyCalculationMatchCount: 3 });
    });

    it("계산 5 전용 입력의 계산 5 비교 지표는 기존처럼 비교 행으로 남는다", () => {
      const cards = buildCards([initiativeRow(), damageRow()]);
      const initiative = cards.find((card) => card.topicId === "initiative")!.evidence[0];
      expect(initiative).toMatchObject({ status: "comparable", benchmarkValue: "35%" });
      expect(initiative).not.toHaveProperty("legacyCalculationMatchCount");
    });

    it("딜량처럼 의미가 바뀌지 않은 지표는 이전 계산 경기가 섞여도 비교를 유지한다", () => {
      const cards = buildCards(applyCalculationVersionGuard([initiativeRow(), damageRow()], 2));
      const firepower = cards.find((card) => card.topicId === "firepower")!.evidence[0];
      expect(firepower).toMatchObject({ metricId: "damage_average", status: "comparable", benchmarkValue: "250" });
      expect(firepower).not.toHaveProperty("legacyCalculationMatchCount");
    });
  });

  describe("카드 계약 검사", () => {
    it("계산 5 비교 행에 이전 계산 경기 표시가 섞이면 카드 집합을 거부한다", () => {
      const valid = JSON.parse(JSON.stringify(buildCards([initiativeRow(), damageRow()])));
      expect(parseSummaryCards(valid)).not.toBeNull();

      const contaminated = JSON.parse(JSON.stringify(valid));
      const row = contaminated.find((card: { topicId: string }) => card.topicId === "initiative").evidence[0];
      row.legacyCalculationMatchCount = 2;
      expect(row.status).toBe("comparable");
      expect(parseSummaryCards(contaminated)).toBeNull();
    });

    it("비교 평균 없이 개인 값만 남은 카드 집합은 받아들인다", () => {
      const guarded = JSON.parse(JSON.stringify(buildCards(applyCalculationVersionGuard([initiativeRow(), damageRow()], 2))));
      expect(parseSummaryCards(guarded)).not.toBeNull();
    });
  });

  describe("비교 키와 계산 5 지표의 대응", () => {
    it("비교 키는 benchmarkLookup의 계산 5 의미 변경 지표 전체와 1:1로 맞는다", () => {
      const produced = new Set<string>();
      for (const field of Array.from(CALCULATION_5_REDEFINED_METRICS)) {
        const observed = adaptObservedBenchmark({ match_count: 10, sample_count: 10, [field]: 1, [`${field}_count`]: 10 });
        Object.keys(observed ?? {})
          .filter((key) => !["sampleCount", "calculationVersion", "metricSampleCounts", "rawMetricValues"].includes(key))
          .forEach((key) => produced.add(key));
      }
      expect([...produced].sort()).toEqual([...CALCULATION_5_BENCHMARK_KEYS].sort());
    });
  });

  describe("ai-summary 라우트", () => {
    const tierRow = {
      game_mode: "squad",
      match_type: "competitive",
      tier: "A+",
      match_count: 30,
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
      calculation_version: ANALYSIS_CALCULATION_VERSION,
      avg_damage: 250,
      avg_damage_count: 30,
      avg_initiative_rate: 35,
      avg_initiative_rate_count: 30,
      avg_trade_rate: 30,
      avg_trade_rate_count: 30,
      avg_duel_win_rate: 50,
      avg_duel_win_rate_count: 30,
      avg_solo_kill_rate: 50,
      avg_solo_kill_rate_count: 30,
    };

    function createSummaryMatch(matchId: string, overrides: Record<string, unknown> = {}) {
      return {
        matchId,
        player_id: "player_a",
        platform: "kakao",
        v: RESULT_VERSION,
        calculationVersion: ANALYSIS_CALCULATION_VERSION,
        populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        mapName: "Baltic_Main",
        gameMode: "squad",
        matchType: "competitive",
        totalTeams: 16,
        stats: { name: "Player_A", kills: 2, assists: 1, DBNOs: 1, damageDealt: 320, processedDamageDealt: 320, winPlace: 4, timeSurvived: 1200 },
        benchmark: { score: 77, breakdown: { combat: 78, tactical: 72, survival: 80 } },
        tradeStats: { teammateKnocks: 1, tradeKills: 1, suppCount: 1, revCount: 1, smokeCount: 1, smokeRescues: 1, reactionLatencyMs: 600, tradeLatencyMs: 9000 },
        combatPressure: { pressureIndex: 2.4, utilityStats: { throwCount: 1, hitCount: 1, totalDamage: 40, killCount: 0 } },
        teamImpact: { damageImpact: 110, killImpact: 100, teamDamageShare: 40, teamKillShare: 35 },
        duelStats: { wins: 2, losses: 1, reversals: 1, reversalAttempts: 1, duelWinRate: 67 },
        isolationData: { isolationIndex: 1.4, combatIsolation: 1.2, deathIsolation: 1.0, minDist: 12, heightDiff: 3, teammateCount: 3 },
        itemUseSummary: { smokes: 1 },
        itemUseStats: { distanceDamage: { short: 100, mid: 150, long: 70 } },
        goldenTimeDamage: { early: 100, mid1: 120, mid2: 80, late: 20 },
        killContribution: { solo: 1, cleanup: 1, assist: 0 },
        deathPhase: 4,
        initiative_rate: 50,
        initiativeSampleCount: 2,
        ...overrides,
      };
    }

    function createSupabaseMock(matches: ReturnType<typeof createSummaryMatch>[], tierOverrides: Record<string, unknown> = {}) {
      const rows = matches.map((fullResult) => ({
        match_id: fullResult.matchId,
        player_id: "player_a",
        platform: "kakao",
        data: { fullResult },
      }));
      const tables: Record<string, unknown> = {
        player_ai_summary_cache: createQueryChain(),
        processed_match_telemetry: createQueryChain({ data: rows, error: null }),
        benchmark_stats_by_tier_v2: createQueryChain({ data: { ...tierRow, ...tierOverrides }, error: null }),
        global_benchmarks: createQueryChain({ data: [], error: null }),
      };
      return {
        from: vi.fn((table: string) => {
          const chain = tables[table];
          if (!chain) throw new Error(`Unexpected table access: ${table}`);
          return chain;
        }),
      };
    }

    function createQueryChain(result: { data: unknown; error: null } = { data: null, error: null }) {
      const chain: Record<string, any> = {};
      const mutationBuilder = () => {
        const builder: Record<string, any> = {};
        const promise = Promise.resolve(result);
        builder.abortSignal = vi.fn().mockReturnValue(builder);
        builder.then = promise.then.bind(promise);
        builder.catch = promise.catch.bind(promise);
        builder.finally = promise.finally.bind(promise);
        return builder;
      };
      for (const name of ["select", "eq", "ilike", "in", "order", "abortSignal"]) chain[name] = vi.fn().mockReturnValue(chain);
      chain.or = vi.fn().mockResolvedValue(result);
      chain.limit = vi.fn().mockResolvedValue(result);
      chain.maybeSingle = vi.fn().mockResolvedValue(result);
      chain.upsert = vi.fn().mockImplementation(() => mutationBuilder());
      return chain;
    }

    function createRequest(body: Record<string, unknown>) {
      return new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    function parseNdjson(text: string): Array<{ type: string; data?: any }> {
      return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    }

    beforeEach(() => {
      vi.clearAllMocks();
      mocks.prompts.length = 0;
      vi.stubEnv("GOOGLE_GEMINI_API_KEY", "test-gemini-key");
      mocks.streamText.mockImplementation((options: { prompt: string }) => {
        mocks.prompts.push(options.prompt);
        return { fullStream: providerStream(providerText(options.prompt)), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
      });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const mixedMatches = () => [
      createSummaryMatch("mixed-v4", { calculationVersion: ANALYSIS_CALCULATION_VERSION - 1, initiative_rate: 34.5, initiativeSampleCount: 2 }),
      createSummaryMatch("mixed-v5", { initiative_rate: 100, initiativeSampleCount: 2 }),
    ];
    const v5Matches = () => [
      createSummaryMatch("v5-a", { initiative_rate: 100, initiativeSampleCount: 2 }),
      createSummaryMatch("v5-b", { initiative_rate: 100, initiativeSampleCount: 2 }),
    ];

    it("이전 계산 경기가 섞이면 프롬프트에서 계산 5 비교 평균을 붙이지 않고 개인 값과 안내만 남긴다", async () => {
      const matches = mixedMatches();
      mockWithAuth(createSupabaseMock(matches));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true }));
      await response.text();

      const prompt = mocks.prompts[0];
      expect(prompt).toContain("[계산 기록] 이전 계산 경기 1판 포함");
      expect(prompt).not.toContain("선제 타격 성공률 35%");
      expect(prompt).not.toContain("복수 성공률 30%");
      expect(prompt).not.toContain("1:1 교전 승률 50%");
      expect(prompt).toContain("평균 화력 250");
    });

    it("계산 5 경기만 있으면 프롬프트의 계산 5 비교 평균을 그대로 붙인다", async () => {
      const matches = v5Matches();
      mockWithAuth(createSupabaseMock(matches));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true }));
      await response.text();

      const prompt = mocks.prompts[0];
      expect(prompt).not.toContain("[계산 기록] 이전 계산 경기");
      expect(prompt).toContain("선제 타격 성공률 35%");
      expect(prompt).toContain("평균 화력 250");
    });

    it("v2 카드에서 이전 계산 경기가 섞이면 계산 5 지표는 비교 주제·비교 행이 되지 않고, 딜량은 comparable로 남는다", async () => {
      const matches = mixedMatches();
      mockWithAuth(createSupabaseMock(matches));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true, summaryContractVersion: 2 }));
      const cards = parseNdjson(await response.text()).find((record) => record.type === "cards")?.data;
      const rows = (cards ?? []).flatMap((card: { evidence: any[] }) => card.evidence);

      // 계산 정의가 다른 값의 차이로 교전 주도권을 비교 주제로 고르지 않는다.
      expect((cards ?? []).map((card: { topicId: string }) => card.topicId)).not.toContain("initiative");
      for (const row of rows.filter((row: any) => CALCULATION_5_COMPARISON_METRIC_IDS.has(row.metricId))) {
        expect(row).toMatchObject({ status: "user_only", benchmarkValue: null, legacyCalculationMatchCount: 1 });
      }
      expect(rows.find((row: any) => row.metricId === "damage_average")).toMatchObject({ status: "comparable", benchmarkValue: "250" });
    });

    it("v2 카드에서 계산 5 경기만 있으면 선제 타격 비교 행이 comparable로 남는다", async () => {
      const matches = v5Matches();
      mockWithAuth(createSupabaseMock(matches));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true, summaryContractVersion: 2 }));
      const cards = parseNdjson(await response.text()).find((record) => record.type === "cards")?.data;
      const rows = (cards ?? []).flatMap((card: { evidence: any[] }) => card.evidence);

      expect(rows.find((row: any) => row.metricId === "initiative_rate")).toMatchObject({ status: "comparable", benchmarkValue: "35%" });
      expect(rows.find((row: any) => row.metricId === "initiative_rate")).not.toHaveProperty("legacyCalculationMatchCount");
    });

    // 최근 5판과 이전 5판의 교전 승률 추세. 한쪽 창이라도 이전 계산 경기가 있으면 승률 추세는 비교 근거가 아니다.
    const trendMatches = (priorIndex?: number) => Array.from({ length: 10 }, (_, index) => createSummaryMatch(`trend-${index}`, {
      createdAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
      duelStats: index < 5 ? { wins: 3, losses: 0 } : { wins: 0, losses: 3 },
      ...(index === priorIndex ? { calculationVersion: ANALYSIS_CALCULATION_VERSION - 1 } : {}),
    }));

    it("이전 계산 경기가 한 창에라도 섞이면 교전 승률 추세와 창별 승률을 내지 않고 딜량 추세는 유지한다", async () => {
      const matches = trendMatches(7);
      mockWithAuth(createSupabaseMock(matches));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true }));
      const visuals = parseNdjson(await response.text()).find((record) => record.type === "visuals")?.data;

      expect(visuals.trends).toMatchObject({ dmgTrend: 0, winTrend: null, recent: { winRate: null }, older: { winRate: null } });
      expect(mocks.prompts[0]).toContain("교전 승률: 계산 기준이 달라 창 간 변화 비교 보류");
      expect(mocks.prompts[0]).not.toMatch(/교전 승률: [^\n]*→/);
    });

    it("계산 5 경기만 있으면 교전 승률 추세와 창별 승률을 그대로 낸다", async () => {
      const matches = trendMatches();
      mockWithAuth(createSupabaseMock(matches));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true }));
      const visuals = parseNdjson(await response.text()).find((record) => record.type === "visuals")?.data;

      expect(visuals.trends).toMatchObject({ dmgTrend: 0, winTrend: 100, recent: { winRate: 100 }, older: { winRate: 0 } });
      expect(mocks.prompts[0]).toMatch(/교전 승률: [^\n]*→[^\n]*\(\+100%\)/);
    });

    // 백업 기준(visuals.backupTier, benchmarkScope)도 이전 계산 경기가 섞이면 계산 5 평균을 쓰지 않는다.
    const slowBackupStats = { teammateKnocks: 1, tradeKills: 1, suppCount: 1, revCount: 1, smokeCount: 1, smokeRescues: 1, reactionLatencyMs: 600, tradeLatencyMs: 19000 };
    const slowBackupTier = { avg_trade_latency_ms: 16000, avg_trade_latency_ms_count: 30 };

    it("이전 계산 경기가 섞이면 visuals의 백업 판정과 비교 표본 수에 계산 5 백업 기준을 쓰지 않는다", async () => {
      const matches = [
        createSummaryMatch("backup-prior", { calculationVersion: ANALYSIS_CALCULATION_VERSION - 1, tradeStats: slowBackupStats }),
        createSummaryMatch("backup-v5", { tradeStats: slowBackupStats }),
      ];
      mockWithAuth(createSupabaseMock(matches, slowBackupTier));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true }));
      const visuals = parseNdjson(await response.text()).find((record) => record.type === "visuals")?.data;

      // 계산 5 기준 16초를 빼면 19초는 기준 없이(12초 기본) 지연 백업으로 보고 복구 성공 맥락으로 분류된다.
      expect(visuals.backupTier).toBe("B");
      expect(visuals.benchmarkScope?.metricSampleCounts?.avgTradeLatency ?? null).toBeNull();
    });

    it("계산 5 경기만 있으면 visuals의 백업 판정은 계산 5 기준을 반영한다", async () => {
      const matches = [
        createSummaryMatch("backup-v5-a", { tradeStats: slowBackupStats }),
        createSummaryMatch("backup-v5-b", { tradeStats: slowBackupStats }),
      ];
      mockWithAuth(createSupabaseMock(matches, slowBackupTier));
      const response = await aiSummaryPOST(createRequest({ matchIds: matches.map((m) => m.matchId), nickname: "Player_A", platform: "kakao", force: true }));
      const visuals = parseNdjson(await response.text()).find((record) => record.type === "visuals")?.data;

      expect(visuals.backupTier).toBe("C");
      expect(visuals.benchmarkScope?.metricSampleCounts?.avgTradeLatency).toBe(30);
    });
  });
});

function mockWithAuth(supabase: unknown) {
  mocks.withAuthGuard.mockResolvedValue({ user: { id: "user-1" }, supabaseAdmin: supabase });
}
