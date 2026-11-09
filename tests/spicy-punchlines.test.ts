import { describe, expect, it } from "vitest";
import { applyMatchSpicyJab, matchSpicyJab, summaryCardSpicyJab } from "@/lib/pubg-analysis/spicyPunchlines";
import { applyMatchAiEvidencePolicy } from "@/lib/pubg-analysis/matchAiEvidence";
import { findAiCoachingQualityFindings, sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import { hasUnsupportedSummaryAdvice, hasUnsupportedSummaryInference } from "@/lib/pubg-analysis/aiSummaryJudgment";
import { applySquadEvidencePolicy } from "@/lib/pubg-analysis/squadAiEvidence";

const base = { matchId: "m1", stats: { processedDamageDealt: 300, timeSurvived: 1200, winPlace: 5, deathType: "byplayer" }, deathPhase: 6, duelStats: { totalDuels: 2, wins: 1 }, teamImpact: { totalTeamDamage: 600, teamDamageShare: 40 }, isolationData: { isolationIndex: 1.2 } };
const cases: Array<[string, any]> = [
  ["early_exit", { ...base, stats: { ...base.stats, timeSurvived: 120 }, deathPhase: 1 }],
  ["duel_losing", { ...base, duelStats: { totalDuels: 6, wins: 1 } }],
  ["quiet_gun", { ...base, stats: { ...base.stats, processedDamageDealt: 40 } }],
  ["share_tiny", { ...base, teamImpact: { totalTeamDamage: 900, teamDamageShare: 10 } }],
  ["far_from_team", { ...base, isolationData: { isolationIndex: 3 } }],
  ["chicken", { ...base, stats: { ...base.stats, winPlace: 1, deathType: "alive" } }],
  ["duel_winning", { ...base, duelStats: { totalDuels: 4, wins: 4 } }],
  ["damage_carry", { ...base, teamImpact: { totalTeamDamage: 900, teamDamageShare: 60 } }],
];

describe("spicy punchlines", () => {
  it.each(cases)("단일 경기 %s 한마디는 근거 정책을 다시 거쳐도 그대로 남고 한 번만 붙는다", (_id, match) => {
    const jab = matchSpicyJab(match);
    expect(jab).toBeTruthy();
    const once = applyMatchSpicyJab(JSON.stringify({ finalVerdict: "경기 기록을 확인했습니다." }), match);
    const reread = applyMatchSpicyJab(applyMatchAiEvidencePolicy(sanitizeAiCoachingLanguageText(once), match), match);
    expect(JSON.parse(reread).finalVerdict).toBe(`경기 기록을 확인했습니다. ${jab}`);
    expect(findAiCoachingQualityFindings(jab!, { blockingOnly: true })).toEqual([]);
  });

  it("못한 점을 먼저 비꼬고, 재료가 없으면 붙이지 않는다", () => {
    expect(matchSpicyJab({ ...base, stats: { ...base.stats, winPlace: 1 }, duelStats: { totalDuels: 6, wins: 1 } })).toMatch(/1:1/);
    expect(matchSpicyJab(base)).toBeNull();
    expect(matchSpicyJab({})).toBeNull();
    expect(applyMatchSpicyJab("not-json", cases[0][1])).toBe("not-json");
  });

  it("요약 한마디는 못 미친 지표를 비꼬고, 모두 평균 이상이면 인정하며, 비교 불가면 붙이지 않는다", () => {
    const ids = ["damage_average", "initiative_rate", "pressure_index", "counter_failure_rate", "reaction_latency", "duel_win_rate", "solo_kill_share", "death_phase", "isolation_average", "trade_success_rate", "backup_latency", "smoke_opportunity_rate"];
    for (const id of ids) {
      const jab = summaryCardSpicyJab([id], false, "ctx")!;
      expect(jab).toBeTruthy();
      expect(hasUnsupportedSummaryInference(jab) || hasUnsupportedSummaryAdvice(jab)).toBe(false);
      expect(findAiCoachingQualityFindings(jab, { blockingOnly: true })).toEqual([]);
    }
    expect(summaryCardSpicyJab([], true, "ctx")).toMatch(/인정|머쓱/);
    expect(summaryCardSpicyJab([], false, "ctx")).toBeNull();
  });
});

describe("실데이터 평가에서 나온 문장 보정", () => {
  const oneDuel = { duelStats: { totalDuels: 1, wins: 0 } };

  it("1:1 교전 1회로 성과를 단정하거나 승률을 올리라고 하지 않는다", () => {
    const input = {
      briefFeedback: ["교전 1회 중 1:1 교전 승률 0%를 기록하여 단 한 번의 교전 시도에서 성과를 내지 못했습니다."],
      actionItems: [{ icon: "🎯", title: "1:1 교전 집중", desc: "교전 시 명중률과 승률을 높이기 위해 사격 타이밍을 점검하십시오." }],
    };
    const result = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), oneDuel));
    expect(result.briefFeedback[0]).toBe("1:1 교전은 1회라 결정력을 평가하기에는 표본이 적습니다.");
    expect(result.actionItems[0]).toEqual({ icon: "🎯", title: "1:1 교전 기록 확인", desc: "다음 교전에서는 1:1 상황이 어떻게 시작되고 끝났는지 확인해 보세요." });
    expect(JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(result), oneDuel))).toEqual(result);
  });

  it.each([
    "고립 지수 0.35로 양호한 대열 유지를 보였으나 1:1 교전 승률 0%에 그쳤습니다.",
    "다음 경기에서는 교전 승률과 유틸리티 활용도를 보완해야 합니다.",
  ])("1:1 교전 1회의 다른 단정 표현도 보류한다: %s", sentence => {
    const result = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({ finalVerdict: sentence, actionItems: [{ icon: "🎯", title: "교전 승률 개선", desc: "1:1 교전 상황에서의 대응력을 높이기 위해 교전 전후의 사격 정확도를 점검하십시오." }] }), oneDuel));
    expect(result.finalVerdict).toBe("1:1 교전은 1회라 결정력을 평가하기에는 표본이 적습니다.");
    expect(result.actionItems[0].title).toBe("1:1 교전 기록 확인");
    const practice = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({ actionItems: [{ icon: "🎯", title: "교전 승률 개선", desc: "1:1 교전 상황에서의 대응 능력을 보완하기 위해 사격 연습을 시도하십시오." }] }), oneDuel));
    expect(practice.actionItems[0].title).toBe("1:1 교전 기록 확인");
  });

  it("확인된 모델 오타를 고친다", () => {
    expect(sanitizeAiCoachingLanguageText("다음 교전에서 아들과의 연계 상황도 함께 점검해 보세요.")).toBe("다음 교전에서 아군과의 연계 상황도 함께 점검해 보세요.");
    expect(sanitizeAiCoachingLanguageText("다음 경지에서 거리 유지 상황을 점검해 보세요.")).toBe("다음 경기에서 거리 유지 상황을 점검해 보세요.");
  });
});

describe("스쿼드 총평 보정", () => {
  it("다른 칸 문장을 반복한 총평은 빼고, 대조가 아닌 '~지만'은 문장을 나눈다", () => {
    const spicy = applySquadEvidencePolicy({
      summary: "최근 10경기에서 우승 2회를 기록했습니다. 치킨 기록이 있다는 건 부인할 수 없는 사실입니다.",
      strength: "연막 구출 성공 기록이 5회입니다.",
      overallOpinion: "최근 10경기에서 우승 2회를 기록했습니다. 치킨 기록이 있다는 건 부인할 수 없는 사실입니다. 연막 구출 성공 기록이 5회입니다.",
    }, {}, null, undefined, [], { coachingStyle: "spicy" }) as any;
    // 반복만 있던 총평은 서버 마무리 한마디만 남고, 다시 적용해도 한 번만 붙는다.
    // 이 입력은 팀 재료가 없어 마무리 한마디 없이 짧은 마감 문장만 남는다.
    expect(spicy.overallOpinion).toBe("기록부는 여기까지입니다.");
    expect(applySquadEvidencePolicy(spicy, {}, null, undefined, [], { coachingStyle: "spicy" })).toEqual(spicy);
    const mild = applySquadEvidencePolicy({ overallOpinion: "최근 10경기에서 우승 2회를 거두었지만 다음 경기도 기대됩니다." }, {}, null, undefined, [], { coachingStyle: "mild" }) as any;
    expect(mild.overallOpinion).toBe("최근 10경기에서 우승 2회를 기록했습니다. 다음 경기도 기대됩니다.");
    const zero = applySquadEvidencePolicy({ overallOpinion: "최근 10경기에서 우승 0회를 기록했지만 다음 경기도 기대됩니다." }, {}, null, undefined, [], { coachingStyle: "mild" }) as any;
    expect(zero.overallOpinion).toContain("기록했지만");
    const conjunction = applySquadEvidencePolicy({ strength: "최근 10경기에서 우승 2회를 기록했습니다.", overallOpinion: "하지만 최근 10경기에서 우승 2회를 기록했습니다. 다음 경기도 기대됩니다." }, {}, null, undefined, [], { coachingStyle: "mild" }) as any;
    expect(conjunction.overallOpinion).toBe("다음 경기도 기대됩니다.");
    const withheld = applySquadEvidencePolicy({ overallOpinion: "해당 평가는 행동 근거가 부족해 보류합니다." }, {}, null, undefined, [], { coachingStyle: "mild" }) as any;
    expect(withheld.overallOpinion).toBe("다음 경기에서도 지금의 호흡을 이어가 보세요.");
  });
});

describe("스쿼드 매운맛 마무리", () => {
  it("놀림 재료가 있으면 비꼬고, 칭찬 재료만 있으면 머쓱해한다", async () => {
    const { squadSpicyCloser } = await import("@/lib/pubg-analysis/squadPunchlines");
    expect(squadSpicyCloser([{ kind: "hype" }, { kind: "roast" }], "a,b")).toMatch(/^(?:기록부가 할 말이 많은|매운맛이 할 일이 많았던)/u);
    expect(squadSpicyCloser([{ kind: "hype" }], "a,b")).toMatch(/^(?:트집 잡을 데가 없어|칭찬만 하다 끝나는)/u);
    expect(squadSpicyCloser([], "a,b")).toBeNull();
  });
});

describe("남은 문장 보정", () => {
  it("첫 타격 적중률처럼 측정하지 않는 지표 조언을 점검 문장으로 바꾼다", () => {
    const result = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({ actionItems: [{ icon: "🎯", title: "교전 집중", desc: "다음 경기에서는 교전 상황에서 조금 더 여유를 가지고 첫 타격 적중률을 높이는 데 집중해 보세요." }] }), {}));
    expect(result.actionItems[0].desc).toBe("다음 교전에서는 선제 타격 이후 교전 결과를 확인해 보세요.");
  });

  it("에임·집중도처럼 측정하지 않는 능력 점검 제안을 바꾼다", () => {
    const result = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({ actionItems: [{ icon: "🎯", title: "교전 점검", desc: "교전 상황에서 생존율을 높이기 위해 첫 반격 타이밍과 에임 집중도를 점검하십시오." }] }), {}));
    expect(result.actionItems[0].desc).toBe("다음 교전에서는 교전이 시작된 위치와 결과를 확인해 보세요.");
  });

  it("수치 뒤 어색한 '~면서' 연결을 '~이고'로 고친다", () => {
    const mild = applySquadEvidencePolicy({ overallOpinion: "최근 10경기 우승 기록이 2회면서 다음 경기도 기대됩니다." }, {}, null, undefined, [], { coachingStyle: "mild" }) as any;
    expect(mild.overallOpinion).toBe("최근 10경기 우승 기록이 2회이고 다음 경기도 기대됩니다.");
  });
});
