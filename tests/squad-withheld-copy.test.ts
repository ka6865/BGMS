import { describe, expect, it } from "vitest";
import { COACHING_JUDGMENT_WITHHELD, sanitizeAiCoachingLanguage } from "@/lib/pubg-analysis/aiCoachingQuality";
import { applySquadEvidencePolicy } from "@/lib/pubg-analysis/squadAiEvidence";
import {
  isSquadWithheldCopy,
  sanitizeSquadAbilityClaims,
  sanitizeSquadAbilityText,
  SQUAD_SPICY_PASS_LINES,
  squadMetricWithheldCopy,
  squadWithheldCopy,
} from "@/lib/pubg-analysis/squadAiPolicy";

const METRIC_LABELS = ["대열 유지", "백업 속도", "연막 구출", "아군 소생", "엄호·집중사격", "전멸 기여", "생존 케어"];

// 측정값이 전부 없는 팀이다. 모든 평가 지표가 보류 대상이 된다.
const EMPTY_STATS = {
  avgIsolation: null,
  avgTradeLatency: null,
  totalSmokeRescues: null,
  totalRevives: null,
  totalTeammateKnocks: null,
  avgCoverRate: null,
  totalTeamWipes: null,
};
const EMPTY_SCORES = { formation: null, backupSpeed: null, survivalCare: null, focusFire: null, teamWipe: null };

const ALL_WITHHELD_COPY = [
  COACHING_JUDGMENT_WITHHELD,
  ...SQUAD_SPICY_PASS_LINES,
  ...METRIC_LABELS.flatMap(label => [squadMetricWithheldCopy("mild", label), squadMetricWithheldCopy("spicy", label)]),
  squadWithheldCopy("mild", "grade"),
  squadWithheldCopy("spicy", "grade"),
  squadWithheldCopy("mild", "rescueNoOpportunity"),
  squadWithheldCopy("spicy", "rescueNoOpportunity"),
  squadWithheldCopy("mild", "rescueLow"),
  squadWithheldCopy("spicy", "rescueLow"),
  squadWithheldCopy("mild", "member"),
];

describe("squad spicy pass lines", () => {
  it("are short, unique, and free of numbers, metric names and ability claims", () => {
    expect(new Set(SQUAD_SPICY_PASS_LINES).size).toBe(SQUAD_SPICY_PASS_LINES.length);
    for (const line of SQUAD_SPICY_PASS_LINES) {
      expect(line).not.toMatch(/\d/);
      expect(line).not.toMatch(/에임|뇌|손가락|명중|조준|집중력|판단력|멘탈|샷발|보류/);
      expect(line.length).toBeLessThan(40);
      expect(isSquadWithheldCopy(line)).toBe(true);
    }
  });

  it("chooses a line deterministically from the seed and never picks the dry copy for spicy", () => {
    const first = squadWithheldCopy("spicy", "generic", "팀 기여는 좋습니다.#1");
    expect(squadWithheldCopy("spicy", "generic", "팀 기여는 좋습니다.#1")).toBe(first);
    expect(SQUAD_SPICY_PASS_LINES).toContain(first);
    expect(first).not.toBe(COACHING_JUDGMENT_WITHHELD);
  });

  it("keeps the mild copy for every key", () => {
    expect(squadWithheldCopy("mild", "generic")).toBe(COACHING_JUDGMENT_WITHHELD);
    expect(squadWithheldCopy(undefined, "member")).toBe("개인 행동을 단정할 근거가 부족해 해당 평가는 보류합니다.");
    expect(squadMetricWithheldCopy("mild", "백업 속도")).toBe("백업 속도 평가는 근거가 부족해 보류합니다.");
  });
});

describe("squad ability text policy with coaching style", () => {
  it("replaces a fully removed unsupported sentence with a spicy pass line", () => {
    const result = sanitizeSquadAbilityText("에임이 나쁩니다.", "spicy");
    expect(SQUAD_SPICY_PASS_LINES).toContain(result as never);
    expect(sanitizeSquadAbilityText("에임이 나쁩니다.")).toBe(COACHING_JUDGMENT_WITHHELD);
  });

  it("replaces only the dry sentinel in place for spicy and keeps it for mild", () => {
    const text = `팀 기여는 좋습니다. ${COACHING_JUDGMENT_WITHHELD}`;
    const spicy = sanitizeSquadAbilityText(text, "spicy");
    expect(spicy.startsWith("팀 기여는 좋습니다. ")).toBe(true);
    expect(spicy).not.toContain(COACHING_JUDGMENT_WITHHELD);
    expect(SQUAD_SPICY_PASS_LINES.some(line => spicy.endsWith(line))).toBe(true);
    expect(sanitizeSquadAbilityText(text, "mild")).toBe(text);
  });

  it.each([
    "에임이 나쁩니다. 팀 기여는 좋습니다.",
    `뇌 빼고 배그함? 백업은 5.36초입니다.\n${COACHING_JUDGMENT_WITHHELD}`,
    "집중력을 보완하세요.\n간격을 좁히세요.",
    "팀 기여는 좋습니다.",
    "에임이 나쁩니다.",
  ])("is idempotent for spicy and mild: %j", (input) => {
    for (const style of ["spicy", "mild"] as const) {
      const once = sanitizeSquadAbilityText(input, style);
      expect(sanitizeSquadAbilityText(once, style)).toBe(once);
    }
  });
});

describe("squad withheld copy is a fixed point of the evidence policy", () => {
  it.each(ALL_WITHHELD_COPY)("keeps %j in summary when it is already withheld copy", (copy) => {
    const result = applySquadEvidencePolicy({ summary: copy }, EMPTY_STATS, null, EMPTY_SCORES, [], { coachingStyle: "spicy" });
    expect(result.summary).toBe(copy);
    expect(applySquadEvidencePolicy({ summary: copy }, EMPTY_STATS, null, EMPTY_SCORES, [], { coachingStyle: "mild" }).summary).toBe(copy);
  });

  it.each(SQUAD_SPICY_PASS_LINES)("keeps the spicy pass line %j in member fields", (line) => {
    const result = applySquadEvidencePolicy({
      memberFeedbacks: [{ name: "A", praise: line, fault: line, advice: line }],
    }, EMPTY_STATS, null, EMPTY_SCORES, [{ name: "A", shares: {} }], { coachingStyle: "spicy" });
    expect(result.memberFeedbacks[0]).toEqual({ name: "A", praise: line, fault: line, advice: line });
  });

  it.each(ALL_WITHHELD_COPY)("is idempotent in member fields for %j", (copy) => {
    for (const style of ["spicy", "mild"] as const) {
      const once = applySquadEvidencePolicy({
        memberFeedbacks: [{ name: "A", praise: copy, fault: copy, advice: copy }],
      }, EMPTY_STATS, null, EMPTY_SCORES, [{ name: "A", shares: {} }], { coachingStyle: style });
      const twice = applySquadEvidencePolicy(once, EMPTY_STATS, null, EMPTY_SCORES, [{ name: "A", shares: {} }], { coachingStyle: style });
      expect(twice).toEqual(once);
    }
  });
});

describe("squad evidence copy by coaching style", () => {
  it("uses the spicy label copy for a missing metric and the mild copy otherwise", () => {
    const spicy = applySquadEvidencePolicy({ summary: "백업 속도가 빠릅니다." }, EMPTY_STATS, null, EMPTY_SCORES, [], { coachingStyle: "spicy" });
    expect(spicy.summary).toBe("백업 속도 기록이 없어서 오늘은 봐드립니다.");
    const mild = applySquadEvidencePolicy({ summary: "백업 속도가 빠릅니다." }, EMPTY_STATS, null, EMPTY_SCORES, []);
    expect(mild.summary).toBe("백업 속도 평가는 근거가 부족해 보류합니다.");
  });

  it("uses the spicy rescue copy for both rescue branches", () => {
    const noOpportunity = { totalTeammateKnocks: 0, totalSmokeRescues: 0, totalRevives: 1, avgTradeLatency: 5000 };
    expect(applySquadEvidencePolicy({ weakness: "연막 구출 능력이 부족합니다." }, noOpportunity, null, undefined, [], { coachingStyle: "spicy" }).weakness)
      .toBe("연막 구출 기회가 안 잡혀서 오늘은 봐드립니다.");
    expect(applySquadEvidencePolicy({ weakness: "연막 구출 능력이 부족합니다." }, noOpportunity, null, undefined, [], { coachingStyle: "mild" }).weakness)
      .toBe("연막 구출 기회가 관측되지 않아 해당 평가는 보류합니다.");
    // 연막 기록이 관측되지 않은 경우에만 기록 부족 분기가 열린다.
    const lowRecord = { totalTeammateKnocks: 4, totalSmokeRescues: null, totalRevives: 1, avgTradeLatency: 5000 };
    expect(applySquadEvidencePolicy({ weakness: "연막 구출 능력이 부족합니다." }, lowRecord, null, undefined, [], { coachingStyle: "spicy" }).weakness)
      .toBe("연막 구출 기록이 모자라 이번 판은 봐드립니다.");
  });

  it("uses the spicy grade copy when the grade is withheld", () => {
    const spicy = applySquadEvidencePolicy({ summary: "종합 등급은 A입니다." }, EMPTY_STATS, null, EMPTY_SCORES, [], { coachingStyle: "spicy" });
    expect(spicy.summary).toBe("종합 등급은 증거가 부족해 이번엔 면제입니다.");
    const mild = applySquadEvidencePolicy({ summary: "종합 등급은 A입니다." }, EMPTY_STATS, null, EMPTY_SCORES, []);
    expect(mild.summary).toBe("미측정 지표가 있어 종합 등급은 보류합니다.");
  });

  it("keeps a full spicy result stable when the cache path re-applies the policies", () => {
    const raw = {
      squadGrade: "A",
      summary: "백업 속도는 빠릅니다. 연막 구출은 2회였습니다.",
      strength: "대열은 좋습니다.",
      weakness: "구조 성공률이 낮습니다. 에임이 흔들립니다.",
      coaching: "기절 시 같이 움직이세요.",
      overallOpinion: "뇌 빼고 배그함? 종합 등급은 A입니다.",
      memberFeedbacks: [
        { name: "KangHeeSung_", praise: "팀 딜 비중 73%입니다.", fault: "백업이 느립니다.", advice: "연막을 아꼈습니다." },
      ],
    };
    const stats = { ...EMPTY_STATS, avgTradeLatency: 15300, totalSmokeRescues: 2, totalRevives: 1, totalTeammateKnocks: 6 };
    const roles = [{ name: "KangHeeSung_", shares: { damage: 73 } }];
    const apply = (value: unknown, style: "spicy" | "mild"): Record<string, unknown> => applySquadEvidencePolicy(
      sanitizeSquadAbilityClaims(sanitizeAiCoachingLanguage(value), style),
      stats,
      null,
      EMPTY_SCORES,
      roles,
      { coachingStyle: style },
    ) as Record<string, unknown>;
    for (const style of ["spicy", "mild"] as const) {
      const once = apply(raw, style);
      const twice = apply(JSON.parse(JSON.stringify(once)), style);
      expect(twice).toEqual(once);
      expect(JSON.stringify(once)).not.toMatch(/에임|뇌 빼고|연막을 아꼈/);
      expect(once.squadGrade).toBeNull();
    }
  });
});
