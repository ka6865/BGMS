import { describe, expect, it } from "vitest";
import { buildSummaryCardEvidence } from "@/lib/pubg-analysis/aiSummaryCardEvidence";
import { buildSummaryCards, parseSummaryCards, type SummaryEvidenceInput } from "@/lib/pubg-analysis/aiSummaryCards";

const context = {
  contextId: "precision-guard",
  gameMode: "squad",
  matchType: "official",
  tier: "B+",
  userMatchCount: 5,
  benchmarkSampleCount: 20,
  filterVersion: 8,
  populationVersion: 1,
};

function evidence(overrides: Partial<SummaryEvidenceInput> & Pick<SummaryEvidenceInput, "metricId" | "label" | "unit">): SummaryEvidenceInput {
  return {
    benchmarkLabel: "동일 티어 평균",
    userValue: null,
    benchmarkValue: null,
    sampleCount: null,
    ...overrides,
  };
}

function cards() {
  return buildSummaryCards({
    topics: ["화력", "유틸리티 활용", "복수 성공률 및 백업"],
    context,
    evidence: [
      evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "412.12", benchmarkValue: "373.46", userNumericValue: 412.123, benchmarkNumericValue: 373.456, sampleCount: 20 }),
      evidence({ metricId: "smoke_opportunity_rate", label: "아군 기절 대비 연막 구출률", unit: "%", userValue: "5.6%", benchmarkValue: "5.8%", userNumericValue: 1 / 18 * 100, benchmarkNumericValue: 5.78, numerator: 1, denominator: 18, sampleCount: 20 }),
      evidence({ metricId: "trade_success_rate", label: "복수 성공률", unit: "%", userValue: "16.7%", benchmarkValue: "8.4%", userNumericValue: 3 / 18 * 100, benchmarkNumericValue: 8.4, numerator: 3, denominator: 18, sampleCount: 20 }),
      evidence({ metricId: "backup_latency", label: "백업 속도", unit: "s", userValue: "23.25s", benchmarkValue: "11.21s", userNumericValue: 23.251, benchmarkNumericValue: 11.211123, sampleCount: 20 }),
    ],
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function rowFor(input: ReturnType<typeof cards>, metricId: string) {
  return input.flatMap(card => card.evidence).find(row => row.metricId === metricId)!;
}

describe("summary evidence raw precision contract", () => {
  it("accepts builder-rounded displays backed by precise raw values and rate counts", () => {
    const value = cards();
    expect(rowFor(value, "smoke_opportunity_rate")).toMatchObject({ userValue: "5.6%", benchmarkValue: "5.8%" });
    expect(parseSummaryCards(value)).not.toBeNull();
  });

  it.each([
    ["userNumericValue", 99],
    ["benchmarkNumericValue", 99],
  ] as const)("rejects a %s that rounds to a different displayed value", (field, forgedValue) => {
    const value = clone(cards());
    const row = rowFor(value, "smoke_opportunity_rate") as any;
    row[field] = forgedValue;
    expect(parseSummaryCards(value)).toBeNull();
  });

  it("rejects a raw rate that disagrees with its numerator and denominator", () => {
    const value = clone(cards());
    const row = rowFor(value, "smoke_opportunity_rate") as any;
    row.denominator = 18.01; // Still displays as 5.6%, but no longer equals 1 / 18.01.
    expect(parseSummaryCards(value)).toBeNull();
  });

  it.each([
    { stats: { totalSmokeRescues: 1 }, numerator: 1, denominator: null },
    { stats: { totalTeammateKnocks: 18 }, numerator: null, denominator: 18 },
  ])("keeps buildSummaryCardEvidence unavailable rows with partial counts: %j", ({ stats, numerator, denominator }) => {
    const partialRate = buildSummaryCardEvidence({ ...stats, metricMatchCounts: { smoke_opportunity_rate: 1 } }, null)
      .find(row => row.metricId === "smoke_opportunity_rate")!;
    expect(partialRate).toMatchObject({ userValue: null, userNumericValue: null });
    expect(partialRate.numerator ?? null).toBe(numerator);
    expect(partialRate.denominator ?? null).toBe(denominator);
    const value = buildSummaryCards({
      topics: ["화력", "유틸리티 활용", "복수 성공률 및 백업"],
      context,
      evidence: cards().flatMap(card => card.evidence).map(row => row.metricId === "smoke_opportunity_rate"
        ? partialRate
        : row),
    });
    expect(value.find(card => card.topicId === "utility")?.dataStatus).toBe("unavailable");
    expect(parseSummaryCards(value)).not.toBeNull();
  });

  it("requires unavailable raw values to remain null while accepting legacy rows without raw fields", () => {
    const value = buildSummaryCards({
      topics: ["화력", "유틸리티 활용", "복수 성공률 및 백업"],
      context,
      evidence: cards().flatMap(card => card.evidence).map(row => row.metricId === "smoke_opportunity_rate"
        ? { ...row, userValue: null, benchmarkValue: null, userNumericValue: null, benchmarkNumericValue: null, numerator: 0, denominator: 0 }
        : row),
    });
    const utility = value.find(card => card.topicId === "utility")!;
    const unavailable = utility.evidence.find(row => row.metricId === "smoke_opportunity_rate")! as any;
    expect(parseSummaryCards(value)).not.toBeNull();

    unavailable.userNumericValue = 0;
    expect(parseSummaryCards(value)).toBeNull();

    const legacy = clone(cards());
    for (const row of legacy.flatMap(card => card.evidence) as any[]) {
      delete row.userNumericValue;
      delete row.benchmarkNumericValue;
    }
    expect(parseSummaryCards(legacy)).not.toBeNull();
  });
});
