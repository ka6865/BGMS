import { describe, expect, it, vi } from "vitest";
import { fetchTierBenchmarkStats } from "@/lib/pubg-analysis/benchmarkLookup";

// 계산 6 행만 두고(현재 계산), 티어별로 행을 돌려주는 최소 DB 흉내.
function db(rows: any[]) {
  return { from: () => {
    const filters: Record<string, unknown> = {};
    let tiers: string[] | null = null;
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return query; }),
      in: vi.fn((_key: string, values: string[]) => { tiers = values; return query; }),
      maybeSingle: async () => ({ data: rows.find(row => row.calculation_version === filters.calculation_version && row.tier === filters.tier) ?? null, error: null }),
      limit: async () => ({ data: rows.filter(row => row.calculation_version === filters.calculation_version && tiers?.includes(row.tier)), error: null }),
    };
    return query;
  } };
}

const row = (tier: string, count: number, initiative: number) => ({
  tier, filter_version: 8, population_evidence_version: 1, calculation_version: 6, match_count: count,
  avg_damage: 300, avg_damage_count: count, avg_initiative_rate: initiative, avg_initiative_rate_count: count,
});
const scope = { gameMode: "duo", matchType: "competitive", tier: "A-" };

describe("비교 평균 티어 계열 확장", () => {
  it("같은 티어 지표 표본이 30 미만이고 계열이 30 이상이면 계열(기본 티어)로 비교한다", async () => {
    const stats = await fetchTierBenchmarkStats(db([row("A-", 15, 70), row("A", 10, 80), row("A+", 9, 90)]), scope);
    expect(stats).toMatchObject({ tier: "A", match_count: 34, avg_initiative_rate_count: 34 });
  });

  it("같은 티어만으로 모든 지표를 비교할 수 있으면 같은 티어를 쓴다", async () => {
    const stats = await fetchTierBenchmarkStats(db([row("A-", 40, 70), row("A", 40, 80)]), scope);
    expect(stats).toMatchObject({ tier: "A-", match_count: 40, avg_initiative_rate: 70 });
  });

  it("계열로 넓혀도 비교 가능한 지표가 늘지 않으면 같은 티어를 쓴다", async () => {
    const stats = await fetchTierBenchmarkStats(db([row("A-", 10, 70), row("A", 5, 80)]), scope);
    expect(stats).toMatchObject({ tier: "A-", match_count: 10 });
  });
});
