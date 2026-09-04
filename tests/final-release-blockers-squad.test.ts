import { beforeEach, describe, expect, it, vi } from "vitest";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: mockCreateClient,
}));

function queryChain(result: any) {
  const chain: any = {};
  for (const method of ["select", "eq", "order", "limit", "like", "in"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: any) => Promise.resolve(result).catch(reject);
  return chain;
}

function filteredBenchmarkQueryChain(rows: any[] = [], error: any = null, ignoreTierFilter = false) {
  const chain: any = {};
  const equalities: Array<[string, any]> = [];
  const memberships: Array<[string, any[]]> = [];
  const prefixes: Array<[string, string]> = [];
  chain.select = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn((field: string, value: any) => {
    equalities.push([field, value]);
    return chain;
  });
  chain.in = vi.fn((field: string, values: any[]) => {
    memberships.push([field, values]);
    return chain;
  });
  chain.like = vi.fn((field: string, prefix: string) => {
    prefixes.push([field, prefix.replace(/%$/, "")]);
    return chain;
  });
  const result = () => ({
    data: rows.filter((row) => (
      equalities.every(([field, value]) => ignoreTierFilter && field === "tier" ? true : row?.[field] === value)
      && memberships.every(([field, values]) => ignoreTierFilter && field === "tier" ? true : values.includes(row?.[field]))
      && prefixes.every(([field, prefix]) => ignoreTierFilter && field === "tier" ? true : String(row?.[field] || "").startsWith(prefix))
    )),
    error,
  });
  chain.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
  chain.catch = (reject: any) => Promise.resolve(result()).catch(reject);
  return chain;
}

function configureSquadClientIgnoringTier(
  processed: any,
  benchmarkResponses: any[][],
  benchmarkError: any = null,
) {
  const benchmarkChains: any[] = [];
  let benchmarkCall = 0;
  const from = vi.fn((table: string) => {
    if (table === "processed_match_telemetry") return processed;
    if (table === "global_benchmarks") {
      const response = benchmarkResponses[Math.min(benchmarkCall++, benchmarkResponses.length - 1)] || [];
      const chain = filteredBenchmarkQueryChain(response, benchmarkError, true);
      benchmarkChains.push(chain);
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });
  const supabase = { from };
  mockCreateClient.mockResolvedValue(supabase);
  return { from, benchmarkChains, supabase };
}

function configureSquadClient(processed: any, benchmarkRows: any[] = [], benchmarkError: any = null) {
  const benchmarkChains: any[] = [];
  const from = vi.fn((table: string) => {
    if (table === "processed_match_telemetry") return processed;
    if (table === "global_benchmarks") {
      const chain = filteredBenchmarkQueryChain(benchmarkRows, benchmarkError);
      benchmarkChains.push(chain);
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });
  const supabase = { from };
  mockCreateClient.mockResolvedValue(supabase);
  return { from, benchmarkChains, supabase };
}

function benchmarkRow(index: number, tier = "B", overrides: Record<string, any> = {}) {
  return {
    tier,
    platform: "steam",
    game_mode: "squad-fpp",
    match_type: "official",
    filter_version: 8,
    population_evidence_version: POPULATION_EVIDENCE_VERSION,
    isolation_index: 10 + index,
    trade_latency_ms: 300 + index,
    revive_rate: 20 + index,
    smoke_rate: 30 + index,
    team_wipes: 40 + index,
    ...overrides,
  };
}

function trustedBenchmarkRows(count: number, tier = "B", overrides: Record<string, any> = {}) {
  return Array.from({ length: count }, (_, index) => benchmarkRow(index, tier, overrides));
}

function canonicalRow(index: number, overrides: Record<string, any> = {}) {
  const matchId = `match-${index}`;
  const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, 12 - index)).toISOString();
  const fullResult = {
    matchId,
    player_id: "player_a",
    platform: "steam",
    v: RESULT_VERSION,
    populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
    createdAt,
    gameMode: "squad-fpp",
    matchType: "official",
    mapName: "Baltic_Main",
    benchmark: { tier: "B", score: index },
    stats: { name: "Player_A", winPlace: index, damageDealt: index * 100 },
    isolationData: { isolationIndex: 1 + index / 100 },
    tradeStats: { tradeLatencyMs: 7_000 + index, coverRate: 0.4, teammateKnocks: 1 },
    team: [
      { name: "Player_A", damageDealt: index * 100, kills: index, assists: 0, DBNOs: 1 },
      { name: "Teammate_B", damageDealt: 100, kills: 1, assists: 1, DBNOs: 0 },
    ],
    ...overrides,
  };
  return {
    match_id: matchId,
    player_id: "player_a",
    platform: "steam",
    updated_at: createdAt,
    data: { fullResult },
  };
}

describe("strict squad analysis population", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("filters non-human/non-BR rows, selects latest ten, then best five only within that ten", async () => {
    const rowsByIndex = new Map(
      Array.from({ length: 12 }, (_, index) => [index + 1, canonicalRow(index + 1)] as const),
    );
    // Deliberately adversarial source order: the database query's arrival
    // order must not become the latest-ten order.
    const rows = [
      rowsByIndex.get(8),
      rowsByIndex.get(2),
      rowsByIndex.get(12),
      rowsByIndex.get(5),
      rowsByIndex.get(1),
      rowsByIndex.get(11),
      rowsByIndex.get(4),
      rowsByIndex.get(10),
      rowsByIndex.get(3),
      rowsByIndex.get(9),
      rowsByIndex.get(6),
      rowsByIndex.get(7),
      // Same canonical ID as match-5, but an older/lower-quality payload.
      canonicalRow(5, {
        createdAt: "2026-08-01T00:00:00.000Z",
        benchmark: { score: 0 },
        stats: { name: "Player_A", winPlace: 99, damageDealt: 1 },
      }),
      canonicalRow(20, { gameMode: "squad-fpp", matchType: "official", benchmark: { score: 100 } }),
      canonicalRow(21, { gameMode: "squad-fpp", matchType: "official", populationEvidenceVersion: undefined }),
      canonicalRow(22, { gameMode: "squad-fpp", matchType: "tdm" }),
      canonicalRow(23, { gameMode: "squad-fpp", matchType: "custom" }),
      canonicalRow(24, { gameMode: "squad-fpp", isBotMatch: true }),
      canonicalRow(25, { gameMode: "unknown", matchType: "official" }),
    ];

    const processed = queryChain({ data: rows, error: null });
    const { benchmarkChains } = configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const result = await getSquadAnalysisData("Player_A", "steam", "Teammate_B");
    const analysis = result as any;

    expect(analysis.matchesSummary).toHaveLength(10);
    expect(analysis.matchesSummary.map((match: any) => match.matchId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `match-${index + 1}`),
    );
    expect(analysis.matchesSummary.find((match: any) => match.matchId === "match-5")?.winPlace).toBe(5);
    expect(analysis.selectedMatchIds).toHaveLength(5);
    expect(analysis.selectedMatchIds).toEqual([
      "match-10",
      "match-9",
      "match-8",
      "match-7",
      "match-6",
    ]);
    expect(analysis.selectedMatchIds).not.toContain("match-20");
    expect(analysis.bestMatchCount).toBe(5);
    expect(analysis.latestMatchCount).toBe(10);
    expect(processed.limit).toHaveBeenCalledWith(100);
    expect(benchmarkChains).toHaveLength(1);
    expect(benchmarkChains[0].eq).toHaveBeenCalledWith("platform", "steam");
    expect(benchmarkChains[0].eq).toHaveBeenCalledWith("tier", "B");
    expect(benchmarkChains[0].eq).toHaveBeenCalledWith("filter_version", 8);
    expect(benchmarkChains[0].eq).toHaveBeenCalledWith("population_evidence_version", POPULATION_EVIDENCE_VERSION);
    expect(benchmarkChains[0].in).toHaveBeenCalledWith("game_mode", ["squad", "squad-fpp"]);
    expect(benchmarkChains[0].in).toHaveBeenCalledWith("match_type", ["official", "competitive"]);
  });

  it("keeps absent isolation, cover, and latency unavailable", async () => {
    const row = canonicalRow(1, {
      isolationData: {},
      tradeStats: { teammateKnocks: 0 },
    });
    const processed = queryChain({ data: [row], error: null });
    configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const result = await getSquadAnalysisData("Player_A", "steam", "Teammate_B");
    const analysis = result as any;

    expect(analysis.stats.avgIsolation).toBeNull();
    expect(analysis.stats.avgCoverRate).toBeNull();
    expect(analysis.stats.avgTradeLatency).toBeNull();
    expect(analysis.squadGrade).toBeNull();
    expect(JSON.stringify(analysis)).not.toContain("12000");
    expect(JSON.stringify(analysis)).not.toContain("2.0");
    expect(JSON.stringify(analysis)).not.toContain("0.3");
  });

  it("weights observed cover-rate percentages by their sample counts and exposes the percent in the prompt", async () => {
    const rows = [
      canonicalRow(1, {
        tradeStats: { teammateKnocks: 1, coverRate: 50, coverRateSampleCount: 2 },
      }),
      canonicalRow(2, {
        tradeStats: { teammateKnocks: 1, coverRate: 100, coverRateSampleCount: 1 },
      }),
    ];
    const processed = queryChain({ data: rows, error: null });
    configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.stats.avgCoverRate).toBe(0.67);
    const prompt = buildSquadAiCoachingPrompt({
      groupKey: analysis.groupKey,
      nickname: "Player_A",
      stats: analysis.stats,
      scores: analysis.scores,
      roleProfiles: analysis.roleProfiles,
      squadGrade: analysis.squadGrade,
      benchmarkStats: analysis.benchmarkStats,
      matchCount: analysis.matchCount,
    });
    expect(prompt.squadReportSummary).toContain("Average Cover Rate (평균 아군 집중사격 커버율): 67%");
  });

  it("treats a zero cover-rate sample count as unavailable rather than a measured 0%", async () => {
    const row = canonicalRow(1, {
      tradeStats: { teammateKnocks: 0, coverRate: 0, coverRateSampleCount: 0 },
    });
    const processed = queryChain({ data: [row], error: null });
    configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.stats.avgCoverRate).toBeNull();
    const prompt = buildSquadAiCoachingPrompt({
      groupKey: analysis.groupKey,
      nickname: "Player_A",
      stats: analysis.stats,
      scores: analysis.scores,
      roleProfiles: analysis.roleProfiles,
      squadGrade: analysis.squadGrade,
      benchmarkStats: analysis.benchmarkStats,
      matchCount: analysis.matchCount,
    });
    expect(prompt.squadReportSummary).toContain("Average Cover Rate (평균 아군 집중사격 커버율): 측정 불가");
    expect(prompt.squadReportSummary).not.toContain("Average Cover Rate (평균 아군 집중사격 커버율): 0%");
  });

  it("fails closed when the benchmark database query errors", async () => {
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    const benchmarkError = { message: "database unavailable", code: "PGRST000" };
    configureSquadClient(processed, [], benchmarkError);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow("Squad benchmark data unavailable");
  });

  it.each([0, 4])("fails closed when only %s trusted benchmark rows exist", async (count) => {
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    configureSquadClient(processed, trustedBenchmarkRows(count));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
  });

  it("fails closed when processed and benchmark tiers are malformed", async () => {
    const processed = queryChain({
      data: [canonicalRow(1, { benchmark: { tier: "BLAH" } })],
      error: null,
    });
    configureSquadClient(processed, trustedBenchmarkRows(5, "BLAH"));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
  });

  it("fails closed before querying benchmarks when the best five omit tier evidence", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => canonicalRow(index + 1, {
      benchmark: { score: index + 1 },
    }));
    const processed = queryChain({ data: rows, error: null });
    const { benchmarkChains } = configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
    expect(benchmarkChains).toHaveLength(0);
  });

  it("fails closed when one selected row omits tier evidence among canonical rows", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => canonicalRow(index + 1, {
      benchmark: index === 2 ? { score: index + 1 } : { tier: "B", score: index + 1 },
    }));
    const processed = queryChain({ data: rows, error: null });
    const { benchmarkChains } = configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
    expect(benchmarkChains).toHaveLength(0);
  });

  it("retains a finite zero trade latency observation", async () => {
    const row = canonicalRow(1, {
      tradeStats: { tradeLatencyMs: 0, coverRate: 0.4, teammateKnocks: 1 },
    });
    const processed = queryChain({ data: [row], error: null });
    configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.stats.avgTradeLatency).toBe(0);
  });

  it("marks partial squad recovery totals unavailable instead of summing only observed rows", async () => {
    const rows = [
      canonicalRow(1, {
        tradeStats: {
          smokeRescues: 2,
          revCount: 3,
          enemyTeamWipes: 4,
          teammateKnocks: 1,
        },
      }),
      canonicalRow(2, {
        tradeStats: {
          // No teammate-knock or recovery fields: every aggregate must
          // remain unavailable rather than exposing a partial sum.
        },
      }),
    ];
    const processed = queryChain({ data: rows, error: null });
    configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.stats.totalSmokeRescues).toBeNull();
    expect(analysis.stats.totalRevives).toBeNull();
    expect(analysis.stats.totalTeamWipes).toBeNull();
    expect(analysis.stats.totalTeammateKnocks).toBeNull();
  });

  it("marks all-missing squad recovery totals unavailable while preserving observed zero totals", async () => {
    const missingRow = canonicalRow(1, {
      tradeStats: {},
    });
    const missingProcessed = queryChain({ data: [missingRow], error: null });
    configureSquadClient(missingProcessed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const missingAnalysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(missingAnalysis.stats.totalSmokeRescues).toBeNull();
    expect(missingAnalysis.stats.totalRevives).toBeNull();
    expect(missingAnalysis.stats.totalTeamWipes).toBeNull();
    expect(missingAnalysis.stats.totalTeammateKnocks).toBeNull();

    const zeroRow = canonicalRow(1, {
      tradeStats: {
        smokeRescues: 0,
        revCount: 0,
        enemyTeamWipes: 0,
        teammateKnocks: 1,
      },
    });
    const zeroProcessed = queryChain({ data: [zeroRow], error: null });
    configureSquadClient(zeroProcessed, trustedBenchmarkRows(5));
    const zeroAnalysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(zeroAnalysis.stats.totalSmokeRescues).toBe(0);
    expect(zeroAnalysis.stats.totalRevives).toBe(0);
    expect(zeroAnalysis.stats.totalTeamWipes).toBe(0);
    expect(zeroAnalysis.stats.totalTeammateKnocks).toBe(1);

    const zeroOnlyRow = canonicalRow(1, {
      tradeStats: {
        smokeRescues: 0,
        revCount: 0,
        enemyTeamWipes: 0,
        teammateKnocks: 0,
      },
    });
    const zeroOnlyProcessed = queryChain({ data: [zeroOnlyRow], error: null });
    configureSquadClient(zeroOnlyProcessed, trustedBenchmarkRows(5));
    const zeroOnlyAnalysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(zeroOnlyAnalysis.stats.totalSmokeRescues).toBe(0);
    expect(zeroOnlyAnalysis.stats.totalRevives).toBe(0);
    expect(zeroOnlyAnalysis.stats.totalTeamWipes).toBe(0);
    expect(zeroOnlyAnalysis.stats.totalTeammateKnocks).toBe(0);
  });

  it("keeps survival care and squad grade unavailable when no teammate-knock denominator exists", async () => {
    const row = canonicalRow(1, {
      tradeStats: {
        teammateKnocks: 0,
        revCount: 0,
        smokeRescues: 0,
        coverRate: null,
        coverRateSampleCount: 0,
      },
    });
    const processed = queryChain({ data: [row], error: null });
    configureSquadClient(processed, trustedBenchmarkRows(5));
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.scores.survivalCare).toBeNull();
    expect(analysis.squadGrade).toBeNull();
    expect(analysis.roleProfiles[0].shares).toEqual({
      damage: 50,
      kill: 50,
      assist: 0,
      dbno: 100,
    });
  });

  it("does not turn nullable squad prompt metrics into zero, null%, or an inferred one-man warning", () => {
    const prompt = buildSquadAiCoachingPrompt({
      groupKey: "Player_A, Teammate_B",
      nickname: "Player_A",
      stats: {
        avgIsolation: null,
        avgTradeLatency: null,
        totalSmokeRescues: null,
        totalRevives: null,
        avgCoverRate: null,
        totalTeamWipes: null,
      },
      scores: {
        formation: null,
        backupSpeed: null,
        survivalCare: null,
        focusFire: null,
        teamWipe: null,
      },
      roleProfiles: [{
        name: "Player_A",
        role: "전술가",
        roleDesc: "측정 불가",
        avgDamage: null,
        avgKills: null,
        avgAssists: null,
        avgDbnos: null,
        shares: { damage: null, kill: null, assist: null, dbno: null },
      }],
      squadGrade: null,
      benchmarkStats: {
        tier: "B",
        avgIsolation: null,
        avgTradeLatency: null,
        avgReviveRate: null,
        avgSmokeRate: null,
        avgTeamWipes: null,
      },
      matchCount: 0,
    });

    expect(prompt.squadReportSummary).toContain("Damage 측정 불가");
    expect(prompt.squadReportSummary).toContain("Formation & Cohesion (대열 유지): 측정 불가");
    expect(prompt.squadReportSummary).not.toMatch(/null%|undefined|NaN|측정 불가%/);
    expect(prompt.systemInstruction).toContain("Current top damage share is 측정 불가");
    expect(prompt.systemInstruction).not.toContain("Current top damage share is 0%");
    expect(prompt.systemInstruction).not.toContain("one-man show");
  });

  it("accepts exactly five trusted rows and exposes only their observed metrics", async () => {
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    const validRows = trustedBenchmarkRows(5, "B", {
      isolation_index: 9,
      trade_latency_ms: 321,
      revive_rate: 4,
      smoke_rate: 8,
      team_wipes: 6,
    });
    const adversarialRows = [
      benchmarkRow(100, "BLAH", { isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
      benchmarkRow(101, "B", { platform: "kakao", isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
      benchmarkRow(102, "B", { filter_version: 7, isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
      benchmarkRow(103, "B", { population_evidence_version: 99, isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
      benchmarkRow(104, "B", { game_mode: "tdm", isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
      benchmarkRow(105, "B", { match_type: "custom", isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
    ];
    const { benchmarkChains } = configureSquadClient(processed, [...validRows, ...adversarialRows]);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.benchmarkStats).toEqual({
      tier: "B",
      avgIsolation: 9,
      avgTradeLatency: 321,
      avgReviveRate: 4,
      avgSmokeRate: 8,
      avgTeamWipes: 6,
    });
    expect(analysis.benchmarkStats).not.toMatchObject({
      avgIsolation: 1.53,
      avgTradeLatency: 11642,
      avgReviveRate: 9.53,
      avgSmokeRate: 3.62,
      avgTeamWipes: 2.8,
    });
    expect(benchmarkChains).toHaveLength(1);
    expect(benchmarkChains[0].like).not.toHaveBeenCalled();
  });

  it("falls back from an under-sampled exact tier to five same-base-tier rows", async () => {
    const processed = queryChain({ data: [canonicalRow(1, { benchmark: { tier: "B+" } })], error: null });
    const exactRows = trustedBenchmarkRows(4, "B+", { isolation_index: 1, trade_latency_ms: 1, revive_rate: 1, smoke_rate: 1, team_wipes: 1 });
    const baseRows = trustedBenchmarkRows(5, "B", { isolation_index: 7, trade_latency_ms: 707, revive_rate: 17, smoke_rate: 27, team_wipes: 37 });
    const { benchmarkChains } = configureSquadClient(processed, [
      ...exactRows,
      ...baseRows,
      benchmarkRow(200, "BLAH", { isolation_index: 900, trade_latency_ms: 900, revive_rate: 900, smoke_rate: 900, team_wipes: 900 }),
    ]);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.benchmarkStats).toMatchObject({
      tier: "B",
      avgIsolation: 4.33,
      avgTradeLatency: 393,
      avgReviveRate: 9.89,
      avgSmokeRate: 15.44,
      avgTeamWipes: 21,
    });
    expect(benchmarkChains).toHaveLength(2);
    expect(benchmarkChains[0].eq).toHaveBeenCalledWith("tier", "B+");
    expect(benchmarkChains[1].in).toHaveBeenCalledWith("tier", ["B+", "B", "B-"]);
    expect(benchmarkChains[1].like).not.toHaveBeenCalled();
  });

  it("filters malformed and cross-family rows even when the database adapter ignores tier predicates", async () => {
    const processed = queryChain({ data: [canonicalRow(1, { benchmark: { tier: "B+" } })], error: null });
    const exactRows = trustedBenchmarkRows(5, "BLAH", {
      isolation_index: 900,
      trade_latency_ms: 900,
      revive_rate: 90,
      smoke_rate: 90,
      team_wipes: 90,
    });
    const familyRows = [
      ...trustedBenchmarkRows(5, "B", {
        isolation_index: 7,
        trade_latency_ms: 707,
        revive_rate: 17,
        smoke_rate: 27,
        team_wipes: 37,
      }),
      ...trustedBenchmarkRows(5, "BLAH", {
        isolation_index: 800,
        trade_latency_ms: 800,
        revive_rate: 80,
        smoke_rate: 80,
        team_wipes: 80,
      }),
      ...trustedBenchmarkRows(5, "A", {
        isolation_index: 700,
        trade_latency_ms: 700,
        revive_rate: 70,
        smoke_rate: 70,
        team_wipes: 70,
      }),
    ];
    const { benchmarkChains } = configureSquadClientIgnoringTier(processed, [exactRows, familyRows]);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const analysis = await getSquadAnalysisData("Player_A", "steam", "Teammate_B") as any;

    expect(analysis.benchmarkStats).toMatchObject({
      tier: "B",
      avgIsolation: 7,
      avgTradeLatency: 707,
      avgReviveRate: 17,
      avgSmokeRate: 27,
      avgTeamWipes: 37,
    });
    expect(benchmarkChains).toHaveLength(2);
    expect(benchmarkChains[0].eq).toHaveBeenCalledWith("tier", "B+");
    expect(benchmarkChains[1].in).toHaveBeenCalledWith("tier", ["B+", "B", "B-"]);
  });

  it("fails closed when a required benchmark metric has fewer than five valid samples", async () => {
    const rows = trustedBenchmarkRows(5).map((row, index) => (
      index === 0 ? { ...row, isolation_index: null } : row
    ));
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    configureSquadClient(processed, rows);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
  });

  it("fails closed when finite benchmark values overflow during averaging", async () => {
    const rows = trustedBenchmarkRows(5, "B", {
      isolation_index: Number.MAX_VALUE,
      trade_latency_ms: Number.MAX_VALUE,
      revive_rate: Number.MAX_VALUE,
      smoke_rate: Number.MAX_VALUE,
      team_wipes: Number.MAX_VALUE,
    });
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    configureSquadClient(processed, rows);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
  });

  it("does not aggregate rows missing the current benchmark provenance markers", async () => {
    const rows = trustedBenchmarkRows(5).map((row, index) => (
      index === 0 ? { ...row, filter_version: 7 } : row
    ));
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    configureSquadClient(processed, rows);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");

    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow(new Error("Squad benchmark data unavailable."));
  });
});
