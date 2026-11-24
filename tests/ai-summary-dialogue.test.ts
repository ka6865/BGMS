import { describe, expect, it } from "vitest";
import { buildSummaryCards, normalizeSummaryCardFinal, parseSummaryCards, summaryCardIntensity, type SummaryEvidenceInput } from "@/lib/pubg-analysis/aiSummaryCards";

const context = { contextId: "dialogue", gameMode: "squad", matchType: "competitive", tier: "B", userMatchCount: 5, benchmarkSampleCount: 40, filterVersion: 8, populationVersion: 1 };
const options = { sanitizeText: (value: string) => value, hasUnsupportedMode: () => false };

function metric(metricId: string, label: string, user: number, average: number, unit = ""): SummaryEvidenceInput {
  return { metricId, label, unit, userValue: `${user}${unit}`, userNumericValue: user, benchmarkValue: `${average}${unit}`, benchmarkNumericValue: average, benchmarkLabel: "동일 티어 평균", sampleCount: 40, userMatchCount: 5 };
}

// 화력만 보이는 단순한 카드 묶음. 첫 카드(화력)의 대사를 검사한다.
function run(damage: number, cell: { spicyOpinion?: string; kindCounter?: string }) {
  const cards = buildSummaryCards({ topics: ["화력", "교전 주도권", "포지셔닝"], context, evidence: [metric("damage_average", "평균 화력", damage, 100)] });
  const provider = {
    signature: "화력",
    debateIssues: cards.map((card, index) => ({
      topicId: card.topicId, evidenceIds: card.evidenceIds,
      kindOpinion: "기록을 확인했습니다.",
      spicyOpinion: index === 0 && cell.spicyOpinion ? cell.spicyOpinion : "다음 교전 후 기록을 확인해 봐.",
      ...(index === 0 && cell.kindCounter ? { kindCounter: cell.kindCounter } : {}),
    })),
    actionItems: [],
  };
  const result = normalizeSummaryCardFinal(provider, cards, options)!;
  return { cards, result, card: result.final.cards.find(card => card.topicId === "firepower")! };
}

describe("최근 요약 토론 대사 칸", () => {
  it("차이 크기로 놀림 강도를 정한다", () => {
    const strength = (damage: number) => summaryCardIntensity({ evidence: run(damage, {}).card.evidence }).roast;
    expect(strength(90)).toBe("weak");
    expect(strength(75)).toBe("mid");
    expect(strength(50)).toBe("strong");
  });

  it("규칙을 지킨 모델 반박과 재반박을 쓰고 다시 정규화해도 같다", () => {
    const { cards, result, card } = run(75, { spicyOpinion: "다정 코치는 감싸 주겠지만 딜은 더 넣었어야지.", kindCounter: "그 부분은 인정합니다. 다음 경기에서 함께 챙겨 보세요." });
    expect(card.winner).toBe("spicy");
    expect(card.spicyOpinion).toContain("다정 코치는 감싸 주겠지만 딜은 더 넣었어야지.");
    expect(card.counterOpinion).toBe("그 부분은 인정합니다. 다음 경기에서 함께 챙겨 보세요.");
    expect(result.dialogueAdoption.rebuttal.adopted).toBeGreaterThanOrEqual(1);
    expect(result.dialogueAdoption.counter.adopted).toBeGreaterThanOrEqual(1);
    expect(parseSummaryCards(result.final)?.[0].counterOpinion).toBe(card.counterOpinion);
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it.each([
    ["숫자", "딜이 25나 모자랐어."],
    ["비교 문구", "평균보다 한참 낮았어."],
    ["영어", "딜량이 완전 low 했어."],
    ["존댓말", "딜을 더 넣으셔야 합니다."],
  ])("반박에 %s이 있으면 차이 크기에 맞는 서버 한마디로 바꾼다", (_, spicyOpinion) => {
    const { card, result } = run(75, { spicyOpinion });
    expect(card.spicyOpinion).not.toContain(spicyOpinion);
    expect(card.spicyOpinion).toMatch(/^평균 화력은 비교 평균보다 낮아\./u);
    expect(result.dialogueAdoption.dropped.some(reason => reason.startsWith("firepower:rebuttal:"))).toBe(true);
    expect(card.analysisStatus).toBe("ready");
  });

  it("작은 차이에는 센 놀림 대사를 쓰지 않는다", () => {
    const { card, result } = run(90, { spicyOpinion: "딜량은 거의 관전 모드였어." });
    expect(card.spicyOpinion).not.toContain("관전");
    expect(result.dialogueAdoption.dropped).toContain("firepower:rebuttal:intensity");
  });

  it("모두 유리한 카드의 반박은 인정할 때만 쓴다", () => {
    expect(run(150, { spicyOpinion: "그래도 다음엔 더 잘해야지." }).card.spicyOpinion).not.toContain("그래도 다음엔");
    expect(run(150, { spicyOpinion: "이건 인정할 수밖에 없네." }).card.spicyOpinion).toContain("이건 인정할 수밖에 없네.");
  });

  it("재반박은 승자를 따르고 없으면 승자별 서버 문장을 쓴다", () => {
    // 매운맛 승인데 다정이 물러서지 않으면 버린다.
    const stubborn = run(50, { kindCounter: "그래도 화력은 충분히 좋았습니다." }).card;
    expect(stubborn.counterOpinion).not.toContain("충분히 좋았");
    expect(stubborn.counterOpinion).toMatch(/인정|아쉬운|맞는/u);
    // 다정 승인데 패배를 인정하면 버린다.
    const givesUp = run(150, { kindCounter: "매운맛 말이 맞습니다." }).card;
    expect(givesUp.counterOpinion).not.toContain("매운맛 말이 맞");
    // 판정이 없는 카드에는 재반박이 없다.
    expect(run(100, {}).card.counterOpinion).toBeUndefined();
  });

  it.each([
    ["매운맛 승", 50, "지적하신 부분을 새겨듣고 다음 판에는 꼭 보완하겠습니다."],
    ["다정 승", 150, "앞으로도 이 좋은 흐름을 계속 이어가겠습니다."],
  ])("%s 재반박이 선수 대신 1인칭으로 다짐하면 서버 문장으로 바꾼다", (_, damage, kindCounter) => {
    const { card, result } = run(damage, { kindCounter });
    expect(card.counterOpinion).not.toBe(kindCounter);
    expect(card.counterOpinion).not.toMatch(/겠습니다$/u);
    expect(result.dialogueAdoption.dropped).toContain("firepower:counter:voice");
  });

  it("코치가 바람을 말하는 재반박은 쓴다", () => {
    const kindCounter = "아쉬운 부분은 인정해요. 다음 경기에서 함께 챙기면 좋겠습니다.";
    expect(run(50, { kindCounter }).card.counterOpinion).toBe(kindCounter);
  });

  it("근거 줄의 보류 사유에 지표 이름을 붙인다", () => {
    const held: SummaryEvidenceInput = { metricId: "counter_failure_rate", label: "3초 내 대응 실패율", unit: "%", userValue: "100%", userNumericValue: 100, benchmarkValue: null, benchmarkNumericValue: null, benchmarkLabel: "동일 티어 평균", sampleCount: null, userMatchCount: 4, numerator: 4, denominator: 4, unavailableReason: "내 관측이 4건이라 비교 평균과 견주지 않습니다." };
    const cards = buildSummaryCards({ topics: ["교전 주도권", "화력", "포지셔닝"], context, evidence: [metric("pressure_index", "평균 압박 지수", 2, 1), held] });
    const provider = { signature: "압박", debateIssues: cards.map(card => ({ topicId: card.topicId, evidenceIds: card.evidenceIds, kindOpinion: "기록을 확인했습니다.", spicyOpinion: "다음 교전 후 기록을 확인해 봐." })), actionItems: [] };
    const initiative = normalizeSummaryCardFinal(provider, cards, options)!.final.cards.find(card => card.topicId === "initiative")!;
    expect(initiative.evaluation).toContain("3초 내 대응 실패율: 내 관측이 4건이라 비교 평균과 견주지 않습니다.");
  });
});

describe("최근 요약 토론 장면 근거", () => {
  const fight = (openedBy: "us" | "them", outcome: string, enemyDowns: number, teamDowns: number, startMs: number) =>
    ({ startMs, endMs: startMs + 5000, opponentTeamIds: [], opponents: [], dealt: 100, taken: 100, enemyDowns, teamDowns, openedBy, outcome });
  const matches = [
    { matchId: "m1", mapName: "에란겔", matchReport: { fights: [fight("them", "lost", 0, 2, 600000), fight("us", "won", 3, 0, 900000)] }, timeline: [{ type: "DIED", ts: 1200000 }] },
    { matchId: "m2", mapName: "미라마", matchReport: { fights: [fight("them", "lost", 0, 3, 300000)] }, timeline: [{ type: "DIED", ts: 480000 }] },
  ];

  it("판정 방향과 맞는 가장 뚜렷한 장면을 고른다", async () => {
    const { pickSummaryCardScene } = await import("@/lib/pubg-analysis/aiSummaryScenes");
    expect(pickSummaryCardScene("initiative", "spicy", matches)).toEqual({ matchId: "m2", clock: "5:00", text: "미라마 경기 5:00 교전: 상대가 먼저 쏴서 우리 팀만 3명 쓰러졌습니다." });
    expect(pickSummaryCardScene("initiative", "kind", matches)?.text).toBe("에란겔 경기 15:00 교전: 우리가 먼저 쏴서 적 3명을 쓰러뜨렸습니다.");
    expect(pickSummaryCardScene("survival", "spicy", matches)?.text).toBe("미라마 경기 8:00에 쓰러져 경기가 끝났습니다.");
    // 무승부, 지원하지 않는 주제, 맞는 장면이 없으면 붙이지 않는다.
    expect(pickSummaryCardScene("initiative", "draw", matches)).toBeNull();
    expect(pickSummaryCardScene("firepower", "spicy", matches)).toBeNull();
    expect(pickSummaryCardScene("survival", "kind", matches)).toBeNull();
    expect(pickSummaryCardScene("initiative", "spicy", [{ matchId: "m3", matchReport: { fights: [] } }])).toBeNull();
  });

  it("정규화가 장면을 판정 난 카드에만 붙이고 다시 읽어도 유지한다", () => {
    const cards = buildSummaryCards({ topics: ["화력", "교전 주도권", "포지셔닝"], context, evidence: [metric("damage_average", "평균 화력", 50, 100)] });
    const provider = { signature: "화력", debateIssues: cards.map(card => ({ topicId: card.topicId, evidenceIds: card.evidenceIds, kindOpinion: "기록을 확인했습니다.", spicyOpinion: "다음 교전 후 기록을 확인해 봐." })), actionItems: [] };
    const scene = { matchId: "m1", clock: "1:00", text: "에란겔 경기 1:00 교전" };
    const result = normalizeSummaryCardFinal(provider, cards, { ...options, sceneFor: (topicId) => topicId === "firepower" ? scene : null })!;
    const firepower = result.final.cards.find(card => card.topicId === "firepower")!;
    expect(firepower.scene).toEqual(scene);
    expect(result.final.cards.filter(card => card.scene)).toHaveLength(1);
    expect(parseSummaryCards(result.final)?.find(card => card.topicId === "firepower")?.scene).toEqual(scene);
  });
});
