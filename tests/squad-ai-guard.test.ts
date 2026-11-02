import { describe, expect, it } from "vitest";
import { COACHING_JUDGMENT_WITHHELD } from "@/lib/pubg-analysis/aiCoachingQuality";
import { sanitizeSquadAbilityClaims, sanitizeSquadAbilityText } from "@/lib/pubg-analysis/squadAiPolicy";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";
import { SQUAD_AI_FACTS_ONLY_ERROR_CODE, SQUAD_AI_MIN_MATCH_COUNT, SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE } from "@/lib/pubg-analysis/squadAiContract";

describe("squad ability guard", () => {
  it.each([
    ["에임이 나쁩니다. 팀 기여는 좋습니다.", "팀 기여는 좋습니다."],
    ["뇌 빼고 배그함? 백업은 빨랐습니다.", "백업은 빨랐습니다."],
    ["손가락 압수 마렵다. 대열은 유지됐습니다.", "대열은 유지됐습니다."],
    ["반동 제어가 약합니다. 간격을 좁히세요.", "간격을 좁히세요."],
    ["조준이 느립니다. 팀 기여는 좋습니다.", "팀 기여는 좋습니다."],
    ["집중력이 떨어집니다. 대열은 유지됐습니다.", "대열은 유지됐습니다."],
    ["판단력이 부족합니다. 백업은 빨랐습니다.", "백업은 빨랐습니다."],
    ["명중률을 확인하세요. 간격을 좁히세요.", "간격을 좁히세요."],
    ["샷발이 원툴입니다. 팀 기여는 좋습니다.", "팀 기여는 좋습니다."],
  ])("removes the unmeasured ability sentence: %s", (input, expected) => {
    expect(sanitizeSquadAbilityText(input)).toBe(expected);
  });

  it("keeps the base summary policy for squad prose, such as an unsupported damage claim", () => {
    expect(sanitizeSquadAbilityText("꾸준한 딜링 능력을 입증했습니다. 팀 기여는 좋습니다.")).toBe("팀 기여는 좋습니다.");
  });

  it("keeps measured facts, decimal seconds and line structure untouched", () => {
    const measured = "백업 반응 속도는 5.36초입니다.\n연막 구출은 2회였습니다.";
    expect(sanitizeSquadAbilityText(measured)).toBe(measured);
    expect(sanitizeSquadAbilityText("팀 고립도가 5.6입니다. 피해 비중은 45%입니다.")).toBe("팀 고립도가 5.6입니다. 피해 비중은 45%입니다.");
  });

  it("replaces a fully removed text with the neutral withheld sentence", () => {
    expect(sanitizeSquadAbilityText("에임이 나쁩니다.")).toBe(COACHING_JUDGMENT_WITHHELD);
  });

  it.each([
    "에임이 나쁩니다. 팀 기여는 좋습니다.",
    "뇌 빼고 배그함? 백업은 5.36초입니다.",
    "집중력을 보완하세요.\n간격을 좁히세요.",
    "팀 기여는 좋습니다.",
    "에임이 나쁩니다.",
  ])("is idempotent for %j", (input) => {
    const once = sanitizeSquadAbilityText(input);
    expect(sanitizeSquadAbilityText(once)).toBe(once);
  });

  it("sanitizes only prose fields and member praise, fault and advice, and leaves names and grade alone", () => {
    const result = {
      squadGrade: "A",
      summary: "에임이 좋습니다. 팀 기여는 좋습니다.",
      strength: "백업 반응 속도는 8초입니다.",
      weakness: "집중력이 흔들립니다.",
      coaching: "간격을 좁히세요.",
      overallOpinion: "뇌 빼고 배그함?",
      memberFeedbacks: [
        { name: "에임왕", praise: "명중률이 높습니다. 진입을 맡았습니다.", fault: "기록이 부족해 판단을 보류합니다.", advice: "손가락을 쉬세요." },
      ],
    };
    const cleaned = sanitizeSquadAbilityClaims(result);

    expect(cleaned.squadGrade).toBe("A");
    expect(cleaned.summary).toBe("팀 기여는 좋습니다.");
    expect(cleaned.strength).toBe("백업 반응 속도는 8초입니다.");
    expect(cleaned.weakness).toBe(COACHING_JUDGMENT_WITHHELD);
    expect(cleaned.overallOpinion).toBe(COACHING_JUDGMENT_WITHHELD);
    expect(cleaned.memberFeedbacks[0].name).toBe("에임왕");
    expect(cleaned.memberFeedbacks[0].praise).toBe("진입을 맡았습니다.");
    expect(cleaned.memberFeedbacks[0].fault).toBe("기록이 부족해 판단을 보류합니다.");
    expect(cleaned.memberFeedbacks[0].advice).toBe(COACHING_JUDGMENT_WITHHELD);
    expect(result.summary).toBe("에임이 좋습니다. 팀 기여는 좋습니다.");
  });

  it("is idempotent on whole results and passes non-object values through", () => {
    const result = { summary: "에임이 좋습니다. 팀 기여는 좋습니다.", memberFeedbacks: [{ name: "A", praise: "뇌 빼고", fault: "", advice: "간격" }] };
    const once = sanitizeSquadAbilityClaims(result);
    expect(sanitizeSquadAbilityClaims(once)).toEqual(once);
    expect(sanitizeSquadAbilityClaims(null)).toBeNull();
    expect(sanitizeSquadAbilityClaims("text")).toBe("text");
  });
});

describe("squad prompt rules", () => {
  const promptFor = (coachingStyle: "spicy" | "mild") => buildSquadAiCoachingPrompt({
    groupKey: "alpha,beta",
    stats: { avgIsolation: 1.5, avgTradeLatency: 8000, avgCoverRate: 0.45, totalSmokeRescues: 2, totalRevives: 3, totalTeamWipes: 1 },
    scores: { formation: 70, backupSpeed: 75, survivalCare: 80, focusFire: 76, teamWipe: 65 },
    roleProfiles: [{ name: "Player_A", role: "Entry", roleDesc: "진입", avgDamage: 300, avgKills: 2, avgAssists: 1, avgDbnos: 1, shares: { damage: 55, kill: 50, assist: 30, dbno: 50 } }],
    nickname: "Player_A",
    coachingStyle,
    squadGrade: "A",
    benchmarkStats: { avgIsolation: 1.36, avgTradeLatency: 12143, avgReviveRate: 17, avgSmokeRate: 3.58, avgTeamWipes: 5.33, tier: "A" },
    matchCount: 3,
    teamMode: "squad",
  });

  it.each(["spicy", "mild"] as const)("forbids unmeasured ability judgments in the shared rules (%s)", (style) => {
    const { systemInstruction } = promptFor(style);
    expect(systemInstruction).toContain("집중력");
    expect(systemInstruction).toContain("판단력");
    expect(systemInstruction).toContain("멘탈");
    expect(systemInstruction).toContain("에임");
    expect(systemInstruction).toContain("명중률");
    expect(systemInstruction).toContain("반응속도");
    expect(systemInstruction).toContain("Only the measured metrics above may support a judgment.");
  });

  it("removes the four unmeasured mockery examples from the spicy persona", () => {
    const { systemInstruction } = promptFor("spicy");
    for (const phrase of ["뇌 빼고 배그함?", "손가락 압수 마렵다", "에임 실화냐?", "어휴 그저 샷발 원툴", "걸어다니는 파밍"]) {
      expect(systemInstruction).not.toContain(phrase);
    }
  });

  it("ties the remaining spicy jabs to measured conditions", () => {
    const { systemInstruction } = promptFor("spicy");
    expect(systemInstruction).toContain("킬로그 배달부");
    expect(systemInstruction).toMatch(/measured damage share is low \(below 20%\)/);
    expect(systemInstruction).toMatch(/isolation index is high, e\.g\. > 3\.0/);
  });

  it("exposes the stable error and minimum-match contract constants", () => {
    expect(SQUAD_AI_MIN_MATCH_COUNT).toBe(3);
    expect(SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE).toBe("PUBG_SQUAD_TOO_FEW_MATCHES");
    expect(SQUAD_AI_FACTS_ONLY_ERROR_CODE).toBe("PUBG_AI_SQUAD_FACTS_ONLY");
  });
});
