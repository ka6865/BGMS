import { describe, expect, it } from "vitest";
import {
  buildMetricTables,
  buildScoreTables,
  calibrationWeights,
  evaluateRoleReference,
  roleStatsOf,
  searchedMedianPercentiles,
  tierBandOf,
  type CalibrationPlayer,
} from "@/lib/pubg-analysis/roleReferenceCalibration";
import { DEFAULT_ROLE_REFERENCE_TABLES, ROLE_REFERENCE_PERCENTILES, ROLE_REFERENCE_QUANTILES, ROLE_SCORE_QUANTILES } from "@/lib/pubg-analysis/roleReference";

const player = (key: string, source: CalibrationPlayer["source"], score: number | null, shortDamage: number, midDamage = 0): CalibrationPlayer => ({
  key,
  source,
  mainMode: "squad",
  score,
  stats: {
    mLen: 1,
    totalDistanceDamage: { short: shortDamage, mid: midDamage, long: 0 },
    goldenTimeAvg: { early: 0, mid1: 0, mid2: 0, late: 0 },
    modeDistribution: { main: "squad" },
  },
});

describe("tier bands", () => {
  it("uses the operating score bands A 60, B 36, C 12 and D below", () => {
    expect(tierBandOf(60)).toBe("A");
    expect(tierBandOf(59.9)).toBe("B");
    expect(tierBandOf(36)).toBe("B");
    expect(tierBandOf(12)).toBe("C");
    expect(tierBandOf(11.9)).toBe("D");
    expect(tierBandOf(null)).toBe("D");
  });
});

describe("calibration weights", () => {
  it("returns null without searched users", () => {
    expect(calibrationWeights([player("a", "sampled", 70, 300)])).toBeNull();
  });

  it("matches the searched tier-band shares by weighting each band by target over sample share", () => {
    // 검색 사용자는 전부 A 구간, 표본은 A 25%, D 75%
    const players = [player("s", "searched", 70, 300), player("a", "other", 5, 300), player("b", "other", 5, 300), player("c", "other", 5, 300)];
    const result = calibrationWeights(players)!;
    expect(result.targetShare.A).toBe(1);
    expect(result.sampleShare.A).toBe(0.25);
    expect(result.weights).toEqual([4, 0, 0, 0]);
    expect(result.effectiveSampleSize).toBe(1);
    expect(result.searchedCount).toBe(1);
  });
});

describe("metric and score tables", () => {
  const many = Array.from({ length: 40 }, (_, index) => player(`p${index}`, "sampled", index % 2 ? 70 : 5, 300, index * 10));

  it("computes a non-decreasing table on the requested levels when samples are enough", () => {
    const result = buildMetricTables(many, null, ROLE_REFERENCE_QUANTILES, ROLE_REFERENCE_PERCENTILES);
    expect(result.quantiles.shortShare).toHaveLength(ROLE_REFERENCE_PERCENTILES.length);
    expect(result.coverage.shortShare.source).toBe("computed");
    const table = result.quantiles.shortShare;
    for (let index = 1; index < table.length; index++) expect(table[index]).toBeGreaterThanOrEqual(table[index - 1]);
  });

  it("keeps the previous table for held metrics and fails when no previous table exists", () => {
    const held = buildMetricTables(many, null, ROLE_REFERENCE_QUANTILES, ROLE_REFERENCE_PERCENTILES);
    expect(held.quantiles.reactionSec).toBe(ROLE_REFERENCE_QUANTILES.reactionSec);
    expect(held.coverage.reactionSec.source).toBe("fallback");
    expect(() => buildMetricTables([], null, {}, ROLE_REFERENCE_PERCENTILES)).toThrow("표본이 부족하고 이전 기준도 없습니다");
  });

  it("uses the previous score table when a role has too few comparable samples", () => {
    const result = buildScoreTables([player("x", "sampled", 5, 300)], null, DEFAULT_ROLE_REFERENCE_TABLES, ROLE_SCORE_QUANTILES);
    expect(result.quantiles.pointMan).toBe(ROLE_SCORE_QUANTILES.pointMan);
    expect(result.coverage.pointMan.source).toBe("fallback");
  });
});

describe("distribution evaluation", () => {
  const players = [
    player("s1", "searched", 70, 300), player("s2", "searched", 40, 0),
    player("o1", "other", 5, 300, 900), player("o2", "sampled", 20, 0, 600), player("o3", "elite", 65, 400),
  ];
  const summary = evaluateRoleReference(players, {
    population: "테스트",
    tables: DEFAULT_ROLE_REFERENCE_TABLES,
    weights: null,
    pendingReferenceMetrics: ["reactionSec"],
  });

  it("partitions every judged player into confirmed, below threshold, or insufficient", () => {
    expect(summary.confirmed + summary.belowThreshold + summary.insufficient).toBeCloseTo(summary.total, 6);
    expect(summary.total).toBe(players.length);
    expect(summary.confirmedRate).toBeGreaterThanOrEqual(0);
    expect(summary.confirmedRate).toBeLessThanOrEqual(1);
  });

  it("reports title shares that add up to the confirmed rate", () => {
    const titleSum = Object.values(summary.byTitle).reduce((total, share) => total + share, 0);
    expect(titleSum).toBeCloseTo(summary.confirmedRate, 3);
  });

  it("filters the population before judging", () => {
    const searched = evaluateRoleReference(players, {
      population: "검색 사용자",
      tables: DEFAULT_ROLE_REFERENCE_TABLES,
      weights: null,
      pendingReferenceMetrics: ["reactionSec"],
      filter: (row) => row.source === "searched",
    });
    expect(searched.total).toBe(2);
  });

  it("returns no median percentile for groups below the minimum sample size", () => {
    expect(searchedMedianPercentiles(players, DEFAULT_ROLE_REFERENCE_TABLES)).toEqual({});
  });

  it("builds the stats the route feeds to the classifier with the reaction hold applied", () => {
    const stats = roleStatsOf(players[0]);
    expect(stats.avgReactionLatency).toBe("측정 불가");
    expect(stats.modeDistribution).toEqual({ main: "squad" });
  });
});
