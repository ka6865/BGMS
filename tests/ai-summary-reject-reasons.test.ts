import { describe, expect, it } from "vitest";
import {
  buildSummaryCards,
  buildSummaryCardComparisonText,
  normalizeSummaryCardFinal,
  type SummaryCard,
  type SummaryEvidenceContext,
  type SummaryEvidenceInput,
} from "@/lib/pubg-analysis/aiSummaryCards";
import {
  hasUnsupportedSummaryAdvice,
  hasUnsupportedSummaryInference,
  summaryAdviceRuleId,
  summaryInferenceRuleId,
} from "@/lib/pubg-analysis/aiSummaryJudgment";

const context: SummaryEvidenceContext = {
  contextId: "ctx-reasons",
  gameMode: "squad-fpp",
  matchType: "official",
  tier: "A",
  userMatchCount: 5,
  benchmarkSampleCount: 12,
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

function buildFixture(): SummaryCard[] {
  return buildSummaryCards({
    topics: ["화력", "유틸리티 활용", "포지셔닝"],
    context,
    evidence: [
      evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "0", benchmarkValue: "0", sampleCount: 12 }),
      evidence({ metricId: "utility_throws", label: "총 투척 횟수", unit: "회", userValue: "4회" }),
      evidence({ metricId: "smoke_opportunity_rate", label: "아군 기절 대비 연막 구출률", unit: "%", userValue: "0%", benchmarkValue: "0%", sampleCount: 12, numerator: 0, denominator: 0 }),
      evidence({ metricId: "isolation_average", label: "평균 고립 지수", unit: "", userValue: "2.5" }),
    ],
  });
}

function providerIssue(card: SummaryCard, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topicId: card.topicId,
    evidenceIds: [...card.evidenceIds],
    kindOpinion: buildSummaryCardComparisonText(card) || `${card.topic}의 기록이 관측되었습니다.`,
    spicyOpinion: `다음 경기 후 ${card.topic} 기록을 점검하세요.`,
    winner: "kind",
    reason: `${card.topic} 근거`,
    evaluation: `${card.topic} 평가`,
    ...overrides,
  };
}

function providerFinal(cards: SummaryCard[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signature: "전술가",
    signatureSub: "검증된 이유",
    finalVerdict: "검증된 판정",
    debateIssues: cards.map((card) => providerIssue(card)),
    actionItems: [{ icon: "🎯", title: "다음 목표", desc: "다음 경기 후 근거를 확인하세요." }],
    ...overrides,
  };
}

const plainOptions = {
  sanitizeText: (text: string) => text,
  hasUnsupportedMode: () => false,
};

describe("summary judgment rule ids", () => {
  it("names the inference and advice rule that matched, and nothing when no rule matched", () => {
    expect(summaryInferenceRuleId("이 교전에서 명중률이 높습니다.")).toBe("inference:unmeasured_shooting");
    expect(summaryInferenceRuleId("집중력을 보완하세요.")).toBe("inference:unmeasured_focus_improvement");
    expect(summaryInferenceRuleId("다음 교전 전에 위치를 확인하세요.")).toBeNull();
    expect(summaryAdviceRuleId("투척을 더 많이 던지세요.")).toBe("advice:throw_usage");
    expect(summaryAdviceRuleId("다음 교전 전에 위치를 확인하세요.")).toBeNull();
  });

  it("keeps the boolean checks in agreement with the rule ids", () => {
    const samples = [
      "이 교전에서 명중률이 높습니다.",
      "집중력을 보완하세요.",
      "집중력을 보완할 필요는 없습니다.",
      "투척을 더 많이 던지세요.",
      "투척을 더 던지지 마세요.",
      "다음 교전 전에 위치를 확인하세요.",
    ];
    for (const sample of samples) {
      expect(hasUnsupportedSummaryInference(sample)).toBe(summaryInferenceRuleId(sample) !== null);
      expect(hasUnsupportedSummaryAdvice(sample)).toBe(summaryAdviceRuleId(sample) !== null);
    }
  });
});

describe("normalizeSummaryCardFinal reject reasons", () => {
  it("adds the conclusion rule under the existing topic:conclusion code without changing the verdict", () => {
    const cards = buildFixture();
    const positioning = cards.findIndex((card) => card.topicId === "positioning");
    const issues = cards.map((card) => providerIssue(card));
    issues[positioning].kindOpinion = "고립 지수가 다소 높게 관측됩니다.";

    const result = normalizeSummaryCardFinal(providerFinal(cards, { debateIssues: issues }), cards, plainOptions);

    expect(result).toMatchObject({ cacheable: false, usable: true, final: { analysisStatus: "partial" } });
    expect(result?.rejectReasons).toContain("positioning:conclusion");
    expect(result?.rejectReasons).toContain("positioning:conclusion:kind:conclusion:isolation_unmeasured");
    expect(result?.final.cards[positioning]).toMatchObject({ analysisStatus: "unavailable", winner: null });
    expect(result?.final.cards[0].analysisStatus).toBe("ready");
  });

  it("names the population mismatch rule for a conclusion that cites another match count", () => {
    const cards = buildFixture();
    const firepower = cards.findIndex((card) => card.topicId === "firepower");
    const issues = cards.map((card) => providerIssue(card));
    issues[firepower].reason = "최근 9판 기준 화력이 평균보다 높습니다.";

    const result = normalizeSummaryCardFinal(providerFinal(cards, { debateIssues: issues }), cards, plainOptions);

    expect(result?.cacheable).toBe(false);
    expect(result?.rejectReasons).toContain("firepower:conclusion");
    expect(result?.rejectReasons).toContain("firepower:conclusion:reason:conclusion:population_mismatch");
  });

  it("names the prose field whose sanitized text came out empty", () => {
    const cards = buildFixture();
    const issues = cards.map((card) => providerIssue(card));
    issues[0].spicyOpinion = "SPECIAL 점검 문장";

    const result = normalizeSummaryCardFinal(providerFinal(cards, { debateIssues: issues }), cards, {
      sanitizeText: (text) => (text.includes("SPECIAL") ? "" : text),
      hasUnsupportedMode: () => false,
    });

    expect(result?.cacheable).toBe(false);
    expect(result?.rejectReasons).toContain(`${cards[0].topicId}:prose`);
    expect(result?.rejectReasons).toContain(`${cards[0].topicId}:prose:spicy:empty`);
  });

  it("reports dropped action items as reasons without changing acceptance or the kept items", () => {
    const cards = buildFixture();
    const validItem = { icon: "🎯", title: "다음 목표", desc: "다음 경기 후 근거를 확인하세요." };
    const clean = normalizeSummaryCardFinal(providerFinal(cards, { actionItems: [validItem] }), cards, plainOptions);
    const dirty = normalizeSummaryCardFinal(providerFinal(cards, {
      actionItems: [validItem, "not-an-object", { icon: "🎯", title: "", desc: "비어 있는 제목" }],
    }), cards, plainOptions);

    expect(dirty?.cacheable).toBe(clean?.cacheable);
    expect(dirty?.rejectReasons).toEqual(clean?.rejectReasons);
    expect(dirty?.final.actionItems).toEqual(clean?.final.actionItems);
    expect(dirty?.actionDropReasons).toEqual(["action_items:shape", "action_items:shape"]);
    expect(clean?.actionDropReasons).toEqual([]);
    expect(dirty?.rejectReasons).not.toContain("action_items");
  });
});
