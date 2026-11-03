import { describe, expect, it } from "vitest";
import { buildSquadObservationBlock } from "@/lib/pubg-analysis/squadMemberDistribution";
import { buildSquadOutputSchema } from "@/lib/pubg-analysis/squadAiSchema";

// 실제 KangHeeSung_ 4인 파티(상세 분석 5경기)의 팀원 비중이다.
const SQUAD = [
  { name: "KangHeeSung_", shares: { damage: 45, kill: 36, assist: 32, dbno: 50 } },
  { name: "ckadmfdls__", shares: { damage: 26, kill: 28, assist: 37, dbno: 25 } },
  { name: "MiaeQ_Q", shares: { damage: 13, kill: 22, assist: 5, dbno: 10 } },
  { name: "Suk-Cun", shares: { damage: 15, kill: 14, assist: 26, dbno: 15 } },
];

describe("buildSquadObservationBlock", () => {
  it("팀 내 순위와 최고·최저를 서버가 정해 적는다", () => {
    const block = buildSquadObservationBlock({ roleProfiles: SQUAD, analyzedMatchCount: 5, totalMatchCount: 10 });
    expect(block).toContain("[MEASURED OBSERVATIONS]");
    expect(block).toContain("함께 뛴 10경기 중 상세 분석된 5경기 기준");
    expect(block).toContain("팀 딜 비중은 최고 45%(KangHeeSung_), 최저 13%(MiaeQ_Q)로 갈렸습니다.");
    expect(block).toContain("KangHeeSung_: 딜 45%(팀 1위) · 킬 36%(팀 1위) · 어시스트 32%(팀 2위) · 기절 50%(팀 1위) [팀 최고: 딜 45%, 킬 36%, 기절 50%]");
    expect(block).toContain("MiaeQ_Q: 딜 13%(팀 4위) · 킬 22%(팀 3위) · 어시스트 5%(팀 4위) · 기절 10%(팀 4위) [팀 최저(균등 분배 25% 미만): 어시스트 5%, 기절 10%]");
    expect(block).toContain("Suk-Cun: 딜 15%(팀 3위) · 킬 14%(팀 4위) · 어시스트 26%(팀 3위) · 기절 15%(팀 3위) [팀 최저(균등 분배 25% 미만): 킬 14%]");
  });

  it("딜은 미애큐큐가 최저지만 숙쿤과 2%p 차이라 최저로 지목하지 않는다", () => {
    const block = buildSquadObservationBlock({ roleProfiles: SQUAD, analyzedMatchCount: 5, totalMatchCount: 10 });
    const miae = block.split("\n").find(line => line.startsWith("- MiaeQ_Q"))!;
    expect(miae).not.toContain("딜 13%]");
    expect(miae).not.toMatch(/팀 최저[^\]]*딜/);
  });

  it("측정된 팀원이 2명 미만이면 빈 문자열이다", () => {
    expect(buildSquadObservationBlock({ roleProfiles: [] })).toBe("");
    expect(buildSquadObservationBlock({ roleProfiles: [SQUAD[0]] })).toBe("");
    expect(buildSquadObservationBlock({ roleProfiles: [{ name: "A", shares: {} }, { name: "B", shares: null }] })).toBe("");
  });

  it("듀오(2명)는 서로의 보수라서 최고·최저를 지목하지 않는다", () => {
    const block = buildSquadObservationBlock({
      roleProfiles: [
        { name: "A", shares: { damage: 70, kill: 80, assist: 10, dbno: 60 } },
        { name: "B", shares: { damage: 30, kill: 20, assist: 90, dbno: 40 } },
      ],
    });
    expect(block).toContain("A: 딜 70%(팀 1위)");
    expect(block).not.toMatch(/팀 최고:|팀 최저/);
  });

  it("값이 같으면 같은 순위로 세고, 범위를 벗어난 값은 측정값으로 보지 않는다", () => {
    const block = buildSquadObservationBlock({
      roleProfiles: [
        { name: "A", shares: { damage: 40, kill: 101 } },
        { name: "B", shares: { damage: 40, kill: 30 } },
        { name: "C", shares: { damage: 20, kill: null } },
      ],
    });
    expect(block).toContain("A: 딜 40%(팀 1위)");
    expect(block).toContain("B: 딜 40%(팀 1위) · 킬 30%(팀 1위)");
    expect(block).not.toContain("101%");
  });

  it("분석 경기 수가 없으면 일반 문구를 쓴다", () => {
    expect(buildSquadObservationBlock({ roleProfiles: SQUAD })).toContain("상세 분석된 경기 기준");
  });
});

describe("buildSquadOutputSchema", () => {
  it("못한 점과 조언은 근거가 없으면 빈 문자열을 허용한다고 알린다", () => {
    const schema = buildSquadOutputSchema(null).jsonSchema as any;
    const member = schema.properties.memberFeedbacks.items.properties;
    expect(member.fault.description).toContain('Empty string ""');
    expect(member.advice.description).toContain('Empty string ""');
    expect(schema.properties.weakness.description).toContain('Empty string ""');
    expect(schema.properties.coaching.description).toContain('Empty string ""');
    expect(member.fault.description).not.toMatch(/Detailed vulnerabilities, mistakes/);
  });
});
