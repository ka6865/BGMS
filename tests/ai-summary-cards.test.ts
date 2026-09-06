import { describe, expect, it } from "vitest";
import {
  buildSummaryCards,
  normalizeSummaryCardFinal,
  parseSummaryCards,
  type SummaryCard,
  type SummaryEvidenceInput,
  type SummaryEvidenceContext,
} from "@/lib/pubg-analysis/aiSummaryCards";

const context: SummaryEvidenceContext = {
  contextId: "ctx-v2",
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

function buildFixture(topics: readonly string[] = ["화력", "유틸리티 활용", "포지셔닝"]): SummaryCard[] {
  return buildSummaryCards({
    topics,
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
    kindOpinion: `${card.topic} 순한 의견`,
    spicyOpinion: `${card.topic} 매운 의견`,
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
    actionItems: [{ icon: "🎯", title: "다음 목표", desc: "근거를 확인하세요." }],
    ...overrides,
  };
}

describe("ai summary v2 card catalog", () => {
  it("builds stable topic/evidence IDs and preserves zero, user-only, and unavailable states", () => {
    const cards = buildFixture();
    expect(cards.map((card) => card.topicId)).toEqual(["firepower", "utility", "positioning"]);

    const firepower = cards[0];
    expect(firepower.question).toBe("화력은 비슷한 조건 평균과 비교해 어떤가?");
    expect(firepower.dataStatus).toBe("comparable");
    expect(firepower.evidenceIds).toEqual(["ctx-v2:damage_average"]);
    expect(firepower.evidence[0]).toMatchObject({ userValue: "0", benchmarkValue: "0", status: "comparable" });

    const utility = cards[1];
    expect(utility.dataStatus).toBe("user_only");
    expect(utility.question).toBe("유틸리티 활용에 대한 두 코치의 평가는?");
    expect(utility.evidenceIds).toEqual(["ctx-v2:utility_throws"]);
    expect(utility.evidence).toContainEqual(expect.objectContaining({ metricId: "smoke_opportunity_rate", status: "unavailable", userValue: null, benchmarkValue: null }));

    const positioning = cards[2];
    expect(positioning.dataStatus).toBe("user_only");
    expect(positioning.evidenceIds).toEqual(["ctx-v2:isolation_average"]);
  });

  it("does not turn a non-positive denominator into 0% and keeps missing benchmark samples user-only", () => {
    const cards = buildSummaryCards({
      topics: ["유틸리티 활용", "화력", "포지셔닝"],
      context,
      evidence: [
        evidence({ metricId: "smoke_opportunity_rate", label: "아군 기절 대비 연막 구출률", unit: "%", userValue: "0%", benchmarkValue: "0%", sampleCount: 12, numerator: 0, denominator: -1 }),
        evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "100", benchmarkValue: "90", sampleCount: 0 }),
        evidence({ metricId: "isolation_average", label: "평균 고립 지수", unit: "", userValue: "1.0" }),
      ],
    });
    expect(cards[0]).toMatchObject({ dataStatus: "unavailable", evidenceIds: [] });
    expect(cards[0].evidence[0]).toMatchObject({ status: "unavailable", userValue: null, benchmarkValue: null, denominator: -1 });
    expect(cards[1]).toMatchObject({ dataStatus: "user_only", evidenceIds: ["ctx-v2:damage_average"] });
    expect(cards[1].evidence[0]).toMatchObject({ status: "user_only", userValue: "100", benchmarkValue: null, sampleCount: 0 });
  });

  it("fails closed for inherited topic and metric names without throwing", () => {
    expect(() => buildSummaryCards({
      topics: ["toString", "화력", "포지셔닝"] as unknown as string[],
      context,
      evidence: [evidence({ metricId: "toString", label: "상속된 키", unit: "" })],
    })).not.toThrow();
    expect(buildSummaryCards({
      topics: ["toString", "화력", "포지셔닝"] as unknown as string[],
      context,
      evidence: [evidence({ metricId: "toString", label: "상속된 키", unit: "" })],
    })).toEqual([]);

    const cards = buildFixture();
    const inheritedTopic = providerFinal(cards);
    (inheritedTopic.debateIssues as Array<Record<string, unknown>>)[0].topicId = "__proto__";
    expect(() => normalizeSummaryCardFinal(inheritedTopic, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    })).not.toThrow();
    expect(normalizeSummaryCardFinal(inheritedTopic, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    })).toBeNull();

    const assembled = normalizeSummaryCardFinal(providerFinal(cards), cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    const inheritedCard = JSON.parse(JSON.stringify(assembled?.final)) as { cards: SummaryCard[] };
    inheritedCard.cards[0].topicId = "toString" as SummaryCard["topicId"];
    expect(() => parseSummaryCards(inheritedCard)).not.toThrow();
    expect(parseSummaryCards(inheritedCard)).toBeNull();
  });

  it("rejects a three-card catalog whose contexts are not identical", () => {
    const cards = buildSummaryCards({
      topics: ["교전 주도권", "1:1 결정력", "유틸리티 활용"],
      context,
      evidence: [],
    });
    const mixedCards = cards.map((card, index) => index === 1
      ? { ...card, context: { ...card.context, matchType: "arcade" } }
      : card);
    expect(normalizeSummaryCardFinal(providerFinal(mixedCards), mixedCards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    })).toBeNull();
  });

  it("normalizes shuffled provider cards by exact topic ID and keeps server facts", () => {
    const cards = buildFixture();
    const provider = providerFinal([...cards].reverse());
    const result = normalizeSummaryCardFinal(provider, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: (value) => typeof value === "string" && /foreign-mode/i.test(value),
    });

    expect(result?.cacheable).toBe(true);
    expect(result?.final.schemaVersion).toBe(2);
    expect(result?.final.cards.map((card) => card.topicId)).toEqual(["firepower", "utility", "positioning"]);
    expect(result?.final.cards[0]).toMatchObject({ analysisStatus: "ready", winner: "kind", dataStatus: "comparable" });
    expect(result?.final.cards[1]).toMatchObject({ analysisStatus: "ready", winner: null, dataStatus: "user_only" });
    expect(result?.final.cards[1].evidence).toEqual(cards[1].evidence);
    expect(result?.final.debateIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "화력", userStats: [{ label: "평균 화력", value: "0" }], benchmarkStats: [{ label: "동일 티어 평균", value: "0" }] }),
    ]));
  });

  it("does not treat structured solo_kill_share IDs as foreign mode text", () => {
    const cards = buildSummaryCards({
      topics: ["1:1 결정력", "화력", "포지셔닝"],
      context,
      evidence: [
        evidence({ metricId: "solo_kill_share", label: "솔로 킬 비중", unit: "%", userValue: "0%", benchmarkValue: "0%", sampleCount: 12 }),
        evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "100", benchmarkValue: "90", sampleCount: 12 }),
        evidence({ metricId: "isolation_average", label: "평균 고립 지수", unit: "", userValue: "1.0" }),
      ],
    });
    const result = normalizeSummaryCardFinal(providerFinal(cards), cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: (value) => typeof value === "string" && /(?:solo|foreign)/i.test(value),
    });
    expect(result?.cacheable).toBe(true);
    expect(result?.final.cards[0]).toMatchObject({ analysisStatus: "ready", winner: "kind" });
  });

  it("keeps facts and marks only a card unavailable for invalid references", () => {
    const cards = buildSummaryCards({
      topics: ["화력", "1:1 결정력", "포지셔닝"],
      context,
      evidence: [
        evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "100", benchmarkValue: "90", sampleCount: 12 }),
        evidence({ metricId: "duel_win_rate", label: "1:1 교전 승률", unit: "%", userValue: "60%", benchmarkValue: "50%", sampleCount: 12 }),
        evidence({ metricId: "isolation_average", label: "평균 고립 지수", unit: "", userValue: "1.0" }),
      ],
    });
    const invalid = providerFinal(cards);
    (invalid.debateIssues as Array<Record<string, unknown>>)[0].evidenceIds = ["other-context:damage_average"];
    const result = normalizeSummaryCardFinal(invalid, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });

    expect(result?.cacheable).toBe(false);
    expect(result?.final.cards[0]).toMatchObject({ analysisStatus: "unavailable", winner: null, dataStatus: "comparable" });
    expect(result?.final.cards[0].evidence).toEqual(cards[0].evidence);
    expect(result?.final.cards[1]).toMatchObject({ analysisStatus: "ready", winner: "kind" });
  });

  it("rejects malformed card sets, duplicate IDs, and missing evidenceIds strictly", () => {
    const cards = buildFixture();
    expect(normalizeSummaryCardFinal(providerFinal(cards, {
      debateIssues: cards.map((card) => providerIssue(card, { topicId: "firepower" })),
    }), cards, { sanitizeText: (value) => value, hasUnsupportedMode: () => false })).toBeNull();

    const missingRefs = providerFinal(cards);
    delete (missingRefs.debateIssues as Array<Record<string, unknown>>)[0].evidenceIds;
    expect(normalizeSummaryCardFinal(missingRefs, cards, { sanitizeText: (value) => value, hasUnsupportedMode: () => false })).toBeNull();

    expect(parseSummaryCards([])).toBeNull();
    expect(parseSummaryCards({ schemaVersion: 2, cards: [] })).toBeNull();
  });

  it("marks foreign-mode prose and all-neutral sanitized prose unavailable while retaining facts", () => {
    const cards = buildFixture();
    const foreign = providerFinal(cards);
    (foreign.debateIssues as Array<Record<string, unknown>>)[0].kindOpinion = "squad foreign-mode claim";
    const foreignResult = normalizeSummaryCardFinal(foreign, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: (value) => typeof value === "string" && /foreign-mode|squad/i.test(value),
    });
    expect(foreignResult?.cacheable).toBe(false);
    expect(foreignResult?.final.cards[0]).toMatchObject({ analysisStatus: "unavailable", winner: null });
    expect(foreignResult?.final.cards[0].evidence).toEqual(cards[0].evidence);

    const neutral = providerFinal(cards);
    const neutralResult = normalizeSummaryCardFinal(neutral, cards, {
      sanitizeText: () => "검증된 경기 지표를 바탕으로 분석합니다.",
      hasUnsupportedMode: () => false,
    });
    expect(neutralResult?.cacheable).toBe(false);
    expect(neutralResult?.final.cards[0]).toMatchObject({ analysisStatus: "unavailable", winner: null });
  });

  it("rejects two neutral coach opinions even when reason and evaluation contain text", () => {
    const cards = buildFixture();
    const provider = providerFinal(cards);
    const issue = (provider.debateIssues as Array<Record<string, unknown>>)[0];
    issue.kindOpinion = "검증된 경기 지표를 바탕으로 분석합니다.";
    issue.spicyOpinion = "AI 해석을 표시할 수 없습니다.";
    issue.reason = "서버가 확인한 근거 설명";
    issue.evaluation = "전술 적용 가능";
    const result = normalizeSummaryCardFinal(provider, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    expect(result?.cacheable).toBe(false);
    expect(result?.final.cards[0]).toMatchObject({ analysisStatus: "unavailable", winner: null });
    expect(result?.final.cards[0].evidence).toEqual(cards[0].evidence);
  });

  it("keeps an expected unavailable card unavailable without rejecting a usable catalog", () => {
    const cards = buildSummaryCards({
      topics: ["교전 주도권", "화력", "포지셔닝"],
      context,
      evidence: [
        evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "100", benchmarkValue: "90", sampleCount: 12 }),
        evidence({ metricId: "isolation_average", label: "평균 고립 지수", unit: "", userValue: "1.0" }),
      ],
    });
    const result = normalizeSummaryCardFinal(providerFinal(cards), cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    expect(result?.cacheable).toBe(true);
    expect(result?.final.cards[0]).toMatchObject({ dataStatus: "unavailable", analysisStatus: "unavailable", winner: null });
    expect(result?.final.cards[1]).toMatchObject({ dataStatus: "comparable", analysisStatus: "ready", winner: "kind" });
  });

  it("accepts neutral unavailable-copy prose for a no-observation card", () => {
    const cards = buildSummaryCards({
      topics: ["교전 주도권", "화력", "포지셔닝"],
      context,
      evidence: [
        evidence({ metricId: "damage_average", label: "평균 화력", unit: "", userValue: "100", benchmarkValue: "90", sampleCount: 12 }),
        evidence({ metricId: "isolation_average", label: "평균 고립 지수", unit: "", userValue: "1.0" }),
      ],
    });
    const provider = providerFinal(cards);
    const unavailableIssue = (provider.debateIssues as Array<Record<string, unknown>>)[0];
    unavailableIssue.kindOpinion = "AI 해석을 표시할 수 없습니다.";
    unavailableIssue.spicyOpinion = "AI 해석을 표시할 수 없습니다.";
    unavailableIssue.reason = "AI 해석을 표시할 수 없습니다.";
    unavailableIssue.evaluation = "AI 해석을 표시할 수 없습니다.";

    const result = normalizeSummaryCardFinal(provider, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    expect(result?.cacheable).toBe(true);
    expect(result?.final.cards[0]).toMatchObject({ dataStatus: "unavailable", analysisStatus: "unavailable", winner: null });
    expect(result?.final.cards[1]).toMatchObject({ dataStatus: "comparable", analysisStatus: "ready", winner: "kind" });
  });

  it("marks an all-unavailable catalog non-cacheable even with valid neutralized cards", () => {
    const cards = buildSummaryCards({
      topics: ["교전 주도권", "1:1 결정력", "유틸리티 활용"],
      context,
      evidence: [],
    });
    const provider = providerFinal(cards);
    for (const issue of provider.debateIssues as Array<Record<string, unknown>>) {
      issue.kindOpinion = "AI 해석을 표시할 수 없습니다.";
      issue.spicyOpinion = "AI 해석을 표시할 수 없습니다.";
      issue.reason = "AI 해석을 표시할 수 없습니다.";
      issue.evaluation = "AI 해석을 표시할 수 없습니다.";
    }
    const result = normalizeSummaryCardFinal(provider, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    expect(result?.cacheable).toBe(false);
    expect(result?.final.cards.every((card) => card.analysisStatus === "unavailable")).toBe(true);
  });

  it("allows a valid action after simple sanitization but rejects empty, neutral, and raw foreign-mode actions", () => {
    const cards = buildFixture();
    const changed = providerFinal(cards);
    (changed.actionItems as Array<Record<string, unknown>>)[0].title = "다음 목표";
    const changedResult = normalizeSummaryCardFinal(changed, cards, {
      sanitizeText: (value) => value === "다음 목표" ? "다음 목표 정리" : value,
      hasUnsupportedMode: () => false,
    });
    expect(changedResult?.cacheable).toBe(true);
    expect(changedResult?.final.actionItems).toEqual([{ icon: "🎯", title: "다음 목표 정리", desc: "근거를 확인하세요." }]);

    const neutralAction = providerFinal(cards);
    (neutralAction.actionItems as Array<Record<string, unknown>>)[0].title = "AI 해석을 표시할 수 없습니다.";
    const neutralActionResult = normalizeSummaryCardFinal(neutralAction, cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    expect(neutralActionResult?.cacheable).toBe(false);

    const rawForeignAction = providerFinal(cards);
    (rawForeignAction.actionItems as Array<Record<string, unknown>>)[0].title = "foreign-mode 목표";
    const rawForeignResult = normalizeSummaryCardFinal(rawForeignAction, cards, {
      sanitizeText: (value) => value.includes("foreign-mode") ? "안전한 목표" : value,
      hasUnsupportedMode: (value) => typeof value === "string" && value.includes("foreign-mode"),
    });
    expect(rawForeignResult?.cacheable).toBe(false);
    expect(rawForeignResult?.final.actionItems).toEqual([{ icon: "🎯", title: "안전한 목표", desc: "근거를 확인하세요." }]);
  });

  it("parses assembled cards only when IDs, context, statuses, and display numbers agree", () => {
    const cards = buildFixture();
    const normalized = normalizeSummaryCardFinal(providerFinal(cards), cards, {
      sanitizeText: (value) => value,
      hasUnsupportedMode: () => false,
    });
    expect(normalized).not.toBeNull();
    const parsed = parseSummaryCards(normalized?.final);
    expect(parsed?.map((card) => card.topicId)).toEqual(["firepower", "utility", "positioning"]);

    const malformed = JSON.parse(JSON.stringify(normalized?.final)) as { cards: SummaryCard[] };
    malformed.cards[0].evidence[0].userValue = "NaN";
    expect(parseSummaryCards(malformed)).toBeNull();
    const wrongContext = JSON.parse(JSON.stringify(normalized?.final)) as { cards: SummaryCard[] };
    wrongContext.cards[1].context.contextId = "other";
    expect(parseSummaryCards(wrongContext)).toBeNull();

    const emptyReadyProse = JSON.parse(JSON.stringify(normalized?.final)) as { cards: SummaryCard[] };
    emptyReadyProse.cards[0].kindOpinion = "";
    expect(parseSummaryCards(emptyReadyProse)).toBeNull();

    const neutralReadyProse = JSON.parse(JSON.stringify(normalized?.final)) as { cards: SummaryCard[] };
    neutralReadyProse.cards[0].kindOpinion = "검증된 경기 지표를 바탕으로 분석합니다.";
    neutralReadyProse.cards[0].spicyOpinion = "AI 해석을 표시할 수 없습니다.";
    neutralReadyProse.cards[0].reason = "근거 설명";
    neutralReadyProse.cards[0].evaluation = "평가";
    expect(parseSummaryCards(neutralReadyProse)).toBeNull();
  });
});
