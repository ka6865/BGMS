import { beforeEach, describe, expect, it, vi } from "vitest";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "@/lib/pubg-analysis/constants";

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
    const benchmark = queryChain({ data: null, error: null });
    mockCreateClient.mockResolvedValue({
      from: vi.fn((table: string) => table === "processed_match_telemetry" ? processed : benchmark),
    });
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
  });

  it("keeps absent isolation, cover, and latency unavailable", async () => {
    const row = canonicalRow(1, {
      isolationData: {},
      tradeStats: { teammateKnocks: 0 },
    });
    const processed = queryChain({ data: [row], error: null });
    const benchmark = queryChain({ data: null, error: null });
    mockCreateClient.mockResolvedValue({
      from: vi.fn((table: string) => table === "processed_match_telemetry" ? processed : benchmark),
    });
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const result = await getSquadAnalysisData("Player_A", "steam", "Teammate_B");
    const analysis = result as any;

    expect(analysis.stats.avgIsolation).toBeNull();
    expect(analysis.stats.avgCoverRate).toBeNull();
    expect(analysis.stats.avgTradeLatency).toBeNull();
    expect(JSON.stringify(analysis)).not.toContain("12000");
    expect(JSON.stringify(analysis)).not.toContain("2.0");
    expect(JSON.stringify(analysis)).not.toContain("0.3");
  });

  it("fails closed when the benchmark database query errors", async () => {
    const processed = queryChain({ data: [canonicalRow(1)], error: null });
    const benchmarkError = { message: "database unavailable", code: "PGRST000" };
    const benchmark = queryChain({ data: null, error: benchmarkError });
    mockCreateClient.mockResolvedValue({
      from: vi.fn((table: string) => table === "processed_match_telemetry" ? processed : benchmark),
    });
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    await expect(getSquadAnalysisData("Player_A", "steam", "Teammate_B"))
      .rejects.toThrow("Squad benchmark data unavailable");
  });
});
