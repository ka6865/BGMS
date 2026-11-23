import { describe, expect, it } from "vitest";
import { applyMatchAiTitlePolicy, judgeMatchTitleKeywords, toMatchSpicyBanmal } from "@/lib/pubg-analysis/matchAiTitlePolicy";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";

const baseMatch = (overrides: Record<string, unknown> = {}) => ({
  stats: { name: "Tester_01", kills: 1, DBNOs: 1, assists: 0, damageDealt: 183.1289, processedDamageDealt: 150.555, longestKill: 17, winPlace: 9, timeSurvived: 790.4, deathType: "byplayer" },
  badges: [],
  timeline: [{ ts: 1000, type: "KILL", weapon: "M416", distance: 17, isMe: true }],
  combatPressure: { utilityStats: { throwCount: 4, lethalThrowCount: 2, hitCount: 1, accuracyStatus: "observed" } },
  ...overrides,
});

const response = (fields: Record<string, unknown>) => JSON.stringify({
  coach: "매운맛 분석가", signature: "칭호", signatureSub: "이유야.", briefFeedback: ["하나야.", "둘이야.", "셋이야."], finalVerdict: "끝이야.", actionItems: [], ...fields,
});

const run = (fields: Record<string, unknown>, match: unknown = baseMatch(), style = "spicy") =>
  JSON.parse(applyMatchAiTitlePolicy(response(fields), match, style));

describe("단일 경기 칭호 키워드 판정", () => {
  it("최장 킬 150m 미만이고 원거리 지정사수 처치가 없으면 저격 계열을 막는다", () => {
    expect(judgeMatchTitleKeywords(baseMatch()).sniper).toBe(false);
    expect(judgeMatchTitleKeywords(baseMatch({ stats: { kills: 1, longestKill: 195 } })).sniper).toBe(true);
    expect(judgeMatchTitleKeywords(baseMatch({ timeline: [{ type: "KNOCK", weapon: "Kar98k", distance: 120, isMe: true }] })).sniper).toBe(true);
    // 근거리 지정사수 처치는 저격으로 보지 않는다.
    expect(judgeMatchTitleKeywords(baseMatch({ timeline: [{ type: "KILL", weapon: "SKS", distance: 22, isMe: true }] })).sniper).toBe(false);
  });

  it("백발백중은 피해형 투척 3회 이상·80% 이상일 때만, 폭파는 적중 30% 이상이거나 투척 처치일 때 허용한다", () => {
    expect(judgeMatchTitleKeywords(baseMatch()).perfect).toBe(false);
    expect(judgeMatchTitleKeywords(baseMatch()).explosive).toBe(true);
    const sharp = baseMatch({ combatPressure: { utilityStats: { lethalThrowCount: 4, hitCount: 4, accuracyStatus: "observed" } } });
    expect(judgeMatchTitleKeywords(sharp).perfect).toBe(true);
    const missing = baseMatch({ combatPressure: { utilityStats: { lethalThrowCount: 4, hitCount: 4, accuracyStatus: "missing" } } });
    expect(judgeMatchTitleKeywords(missing)).toMatchObject({ perfect: false, explosive: false });
  });

  it("생존왕은 배지나 생존 시간 상위 20% 이내 백분위가 있을 때만 허용한다", () => {
    expect(judgeMatchTitleKeywords(baseMatch()).survivor).toBe(false);
    expect(judgeMatchTitleKeywords(baseMatch(), [{ metric: "survival_time", direction: "top", percent: 12 }]).survivor).toBe(true);
    expect(judgeMatchTitleKeywords(baseMatch({ badges: [{ id: "survivor", name: "생존왕", desc: "자기장 버팀" }] })).survivor).toBe(true);
  });
});

describe("단일 경기 칭호 교체", () => {
  it("근거 없는 저격수 칭호를 서버 칭호로 바꾸고 지운 단어를 가리키는 이유 문장만 뺀다", () => {
    const result = run({ signature: "대치선 저격수", signatureSub: "저격수답게 한 발로 끝냈네. 1킬을 챙겼잖아." });
    expect(result.signature).toBe("화력 기여형 플레이어");
    expect(result.signatureSub).toBe("1킬을 챙겼잖아.");
  });

  it("근거 있는 단어만 남으면 그 칭호를 쓰고, 배지가 있으면 배지 이름을 쓴다", () => {
    expect(run({ signature: "백발백중 폭파 전문가" }).signature).toBe("폭파 전문가");
    const slayer = baseMatch({ stats: { kills: 6, damageDealt: 700 }, badges: [{ id: "slayer", name: "슬레이어", desc: "한 매치에서 5킬 이상 달성" }] });
    expect(run({ signature: "백중세의 저격수" }, slayer).signature).toBe("슬레이어");
  });

  it("0킬 백병전 저격수처럼 근접과 저격이 함께 있으면 둘 다 근거가 있어도 바꾼다", () => {
    const both = baseMatch({ stats: { kills: 3, longestKill: 210, damageDealt: 300 }, timeline: [
      { type: "KILL", weapon: "P90", distance: 5, isMe: true }, { type: "KNOCK", weapon: "P90", distance: 12, isMe: true },
    ] });
    expect(judgeMatchTitleKeywords(both)).toMatchObject({ sniper: true, melee: true });
    expect(run({ signature: "백병전 저격수" }, both).signature).toBe("화력 기여형 플레이어");
    expect(run({ signature: "백병전 스페셜리스트" }, both).signature).toBe("백병전 스페셜리스트");
  });

  it("근거가 있는 칭호는 그대로 두고 재적용해도 결과가 같다", () => {
    const sniper = baseMatch({ stats: { kills: 2, longestKill: 300, damageDealt: 250 } });
    const once = applyMatchAiTitlePolicy(response({ signature: "원거리 저격수" }), sniper, "spicy");
    expect(JSON.parse(once).signature).toBe("원거리 저격수");
    const replaced = applyMatchAiTitlePolicy(response({ signature: "백발백중 저격수", finalVerdict: "표본이 적습니다." }), baseMatch(), "spicy");
    expect(applyMatchAiTitlePolicy(replaced, baseMatch(), "spicy")).toBe(replaced);
  });
});

describe("단일 경기 숫자·말투·영어 정리", () => {
  it("소수점 셋째 자리 이상 숫자를 피해량은 정수, 나머지는 한 자리로 줄인다", () => {
    const result = run({ signatureSub: "공식 피해량 54.16811과 고립 지수 1.23456을 기록했네.", briefFeedback: ["반격 소요 시간은 1.25초야.", "유효 딜량 769.1489야.", "셋이야."] });
    expect(result.signatureSub).toBe("공식 피해량 54과 고립 지수 1.2을 기록했네.");
    expect(result.briefFeedback.slice(0, 2)).toEqual(["반격 소요 시간은 1.25초야.", "유효 딜량 769야."]);
  });

  it("매운맛 결론의 존댓말 끝을 반말로 바꾸고 다정한 코치는 그대로 둔다", () => {
    expect(run({ finalVerdict: "1:1 교전은 2회라 표본이 적습니다. 다음 판엔 먼저 확인해 보세요." }).finalVerdict).toBe("1:1 교전은 2회라 표본이 적어. 다음 판엔 먼저 확인해 봐.");
    expect(run({ finalVerdict: "표본이 적습니다." }, baseMatch(), "mild").finalVerdict).toBe("표본이 적습니다.");
    expect(toMatchSpicyBanmal("측정 불가입니다. 기록은 3킬입니다. 많이 남았습니다. 보완이 필요합니다.")).toBe("측정 불가야. 기록은 3킬이야. 많이 남았어. 보완이 필요해.");
  });

  it("허용 밖 영어 단어가 든 문장을 빼고 닉네임·무기 이름은 남긴다", () => {
    const result = run({
      briefFeedback: ["Tester_01이 M416으로 먼저 쐈어. 근데 timing이 늦었어.", "positioning was bad.", "셋이야."],
      finalVerdict: "Kar98k로 마무리했네.",
    });
    expect(result.briefFeedback[0]).toBe("Tester_01이 M416으로 먼저 쐈어.");
    expect(result.briefFeedback[1]).toBe("이번 경기에서 1킬, 공식 피해량 183를 기록했습니다.");
    expect(result.finalVerdict).toBe("Kar98k로 마무리했네.");
  });
});

describe("단일 경기 프롬프트 입력", () => {
  it("피해량은 정수로, 칭호 키워드 근거를 함께 넘긴다", () => {
    const { fullPrompt } = buildMatchAiCoachingPrompt({ matchData: { ...baseMatch(), mapName: "에란겔", gameMode: "squad" }, coachingStyle: "spicy" });
    expect(fullPrompt).toContain("공식 피해량 183 / 유효 딜량 151");
    expect(fullPrompt).toContain("생존: 13분 10초");
    expect(fullPrompt).toMatch(/근거 없음\(사용 금지\):[^\n]*저격/u);
    expect(fullPrompt).toMatch(/근거 확인:[^\n]*폭파/u);
  });
});
