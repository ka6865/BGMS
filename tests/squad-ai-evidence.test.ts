import { describe, expect, it } from "vitest";
import { sanitizeAiCoachingLanguage } from "@/lib/pubg-analysis/aiCoachingQuality";
import { applySquadEvidencePolicy } from "@/lib/pubg-analysis/squadAiEvidence";

describe("squad partial evidence prose", () => {
  it("keeps member advice stable across fresh and cached evidence cleanup", () => {
    const source = { memberFeedbacks: [{ name: 'player', praise: '관측된 처치 기록입니다.', fault: '확인할 기록이 부족합니다.', advice: '집중사격을 더 연습하세요.' }] };
    const first = applySquadEvidencePolicy(source, { avgCoverRate: null }, null, { focusFire: null });
    expect(applySquadEvidencePolicy(first, { avgCoverRate: null }, null, { focusFire: null })).toEqual(first);
  });
  it("withholds derived focus-fire evaluation even with a raw rate", () => {
    const result = applySquadEvidencePolicy({ squadGrade: "A", summary: "집중사격이 우수합니다.", coaching: "평균 백업 속도는 5.36초입니다." },
      { avgCoverRate: 0.3, avgTradeLatency: 5360 }, null, { focusFire: null });
    expect(result.squadGrade).toBeNull();
    expect(result.summary).toContain("보류");
    expect(result.coaching).toBe("평균 백업 속도는 5.36초입니다.");
  });
  it("does not keep unsupported support-fire judgments introduced by language cleanup", () => {
    const result = applySquadEvidencePolicy(sanitizeAiCoachingLanguage({
      summary: "나머지 팀원들의 화력 지원이 전무합니다.",
      coaching: "지원 사격이 부족합니다. 집중 화력이 부족합니다.",
    }), { avgCoverRate: null }, null);
    expect(result.summary).toContain("보류");
    expect(result.coaching).toContain("보류");
    expect(result.summary).not.toContain("보완이 필요");
  });
  it("keeps real recovery counts but withholds rates without recovery evidence", () => {
    const result = applySquadEvidencePolicy({
      summary: "아군 소생은 3회입니다.", strength: "소생 성공률은 80%입니다.",
      weakness: "연막 구출 능력이 부족합니다.",
    }, { totalRevives: 3, totalSmokeRescues: 0, totalTeammateKnocks: null }, null, { survivalCare: null });
    expect(result.summary).toBe("아군 소생은 3회입니다.");
    expect(result.strength).toContain("보류");
    expect(result.weakness).toContain("보류");
  });
  it("preserves observed zero and canonical grades", () => {
    const result = applySquadEvidencePolicy({ squadGrade: "S", summary: "연막 구출은 0회입니다.", coaching: "백업 속도는 0초입니다." },
      { totalSmokeRescues: 0, avgTradeLatency: 0 }, "B");
    expect(result.squadGrade).toBe("B");
    expect(result.summary).toBe("연막 구출은 0회입니다.");
    expect(result.coaching).toBe("백업 속도는 0초입니다.");
  });
});
