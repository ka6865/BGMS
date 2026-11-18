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
      { avgCoverRate: 0.3, avgTradeLatency: 5360, totalTradeKills: 3 }, null, { focusFire: null });
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
      { totalSmokeRescues: 0, avgTradeLatency: 0, totalTradeKills: 3 }, "B");
    expect(result.squadGrade).toBe("B");
    expect(result.summary).toBe("연막 구출은 0회입니다.");
    expect(result.coaching).toBe("백업 속도는 0초입니다.");
  });
});

describe("스쿼드 서버 응답 품질", () => {
  const source = { summary: "요약", strength: "", weakness: "", coaching: "", overallOpinion: "요약", memberFeedbacks: [] };
  const gapStats = { totalTradeableKnocks: 20, totalTradeableTradeKills: 2 };
  const benchmarkStats = { avgTradeableTradeRate: 30 };

  it.each(["trade_rate_low", "knocks_many", "backup_slow"])("적격 팀 격차가 있으면 빈 약점과 조건부 점검을 채운다: %s", (id) => {
    const stats = id === "trade_rate_low" ? gapStats : id === "knocks_many"
      ? { totalTeammateKnocks: 30, observedMatchCount: 3 }
      : { totalTradeKills: 5, avgTradeLatency: 15000 };
    const options = { coachingStyle: "spicy", benchmarkStats: { ...benchmarkStats, avgTeammateKnocks: 4, avgTradeLatency: 10000 } };
    const once = applySquadEvidencePolicy(source, stats, null, undefined, [], options);
    expect(once.weakness).toMatch(/평균보다 (?:낮아|많아|느려)\./);
    expect(once.coaching).toMatch(/면.*(?:확인|점검)/);
    expect(applySquadEvidencePolicy(once, stats, null, undefined, [], options)).toEqual(once);
  });

  it("서버가 채운 약점 사실은 총평에서 반복하지 않는다", () => {
    const options = { coachingStyle: "spicy", benchmarkStats };
    const once = applySquadEvidencePolicy(source, gapStats, null, undefined, [], options);
    expect(once.weakness).toContain("복수 성공률 10%");
    expect(once.overallOpinion).not.toContain("복수 성공률 10%");
    expect(once.overallOpinion).not.toBe("");
    expect(applySquadEvidencePolicy(once, gapStats, null, undefined, [], options)).toEqual(once);
  });

  it("우승 0회 약점은 선택기의 최소 5경기 기준을 그대로 따른다", () => {
    for (const count of [4, 5]) {
      const options = { coachingStyle: "spicy", matchesSummary: Array.from({ length: count }, () => ({ winPlace: 4 })) };
      const once = applySquadEvidencePolicy(source, {}, null, undefined, [], options);
      expect(once.weakness).toBe(count === 5 ? "최근 5경기에서 우승 기록이 0회야." : "");
      expect(once.coaching).toBe(count === 5 ? "다음 경기에도 우승이 없다면, 마지막 교전 기록부터 함께 점검해 봐." : "");
      expect(applySquadEvidencePolicy(once, {}, null, undefined, [], options)).toEqual(once);
    }
  });

  it("공백뿐인 칸도 적격 근거로 채우고 이미 있는 코칭은 보존한다", () => {
    const options = { coachingStyle: "spicy", benchmarkStats };
    const once = applySquadEvidencePolicy({ ...source, weakness: "  ", coaching: " \n " }, gapStats, null, undefined, [], options);
    expect(once.weakness).toContain("복수 성공률 10%");
    expect(once.coaching).toContain("상황인지 점검");
    const existing = applySquadEvidencePolicy({ ...source, coaching: "기록을 함께 점검해 봐." }, gapStats, null, undefined, [], options);
    expect(existing.coaching).toBe("기록을 함께 점검해 봐.");
    expect(applySquadEvidencePolicy(once, gapStats, null, undefined, [], options)).toEqual(once);
  });

  it("킬 비중만 있으면 기록으로 쓰고 유효한 비중이 없으면 모델 칭찬을 남기지 않는다", () => {
    const profiles = [
      { name: "Kill", totalKills: 5, shares: { damage: null, kill: 25 } },
      { name: "Missing", totalKills: 0, shares: { damage: 101, kill: Number.NaN } },
    ];
    const input = { ...source, memberFeedbacks: profiles.map(({ name }) => ({ name, praise: "팀 화력의 중심이야", fault: "", advice: "" })) };
    const once = applySquadEvidencePolicy(input, {}, null, undefined, profiles, { coachingStyle: "spicy" });
    expect(once.memberFeedbacks[0].praise).toBe("팀 킬 25%를 기록했네.");
    expect(once.memberFeedbacks[1].praise).toBe("");
    expect(applySquadEvidencePolicy(once, {}, null, undefined, profiles, { coachingStyle: "spicy" })).toEqual(once);
  });

  it("후보가 없거나 딜 분배·낮은 구조율·연막 0회만 있으면 약점과 코칭을 비워 둔다", () => {
    for (const stats of [{}, { totalTeammateKnocks: 20, totalRevives: 1, totalSmokeRescues: 0 }]) {
      const profiles = [{ name: "A", shares: { damage: 90 } }, { name: "B", shares: { damage: 10 } }];
      const options = { coachingStyle: "spicy", benchmarkStats: { avgReviveRate: 30, avgSmokeRate: 7 } };
      const once = applySquadEvidencePolicy(source, stats, null, undefined, profiles, options);
      expect(once.weakness).toBe("");
      expect(once.coaching).toBe("");
      expect(applySquadEvidencePolicy(once, stats, null, undefined, profiles, options)).toEqual(once);
    }
  });

  it.each(["spicy", "mild"])("우승만 있어도 중복 제거 뒤 총평에 근거가 남는다: %s", (coachingStyle) => {
    const options = { coachingStyle, matchesSummary: [{ winPlace: 1 }, { winPlace: 1 }, { winPlace: 4 }] };
    const once = applySquadEvidencePolicy({ ...source, overallOpinion: "최근 3경기에서 우승 2회를 기록했습니다." }, {}, null, undefined, [], options);
    expect(once.overallOpinion).toContain("최근 3경기에서 우승 2회");
    expect(once.overallOpinion).not.toBe("기록부는 여기까지야.");
    expect(applySquadEvidencePolicy(once, {}, null, undefined, [], options)).toEqual(once);
  });

  it.each(["spicy", "mild"])("요약·강점에 이미 쓴 사실은 총평에서 반복하지 않는다: %s", (coachingStyle) => {
    const options = { coachingStyle, matchesSummary: [{ winPlace: 2 }, { winPlace: 4 }, { winPlace: 6 }], analyzedMatchCount: 2 };
    const once = applySquadEvidencePolicy({ ...source,
      summary: "최근 3경기에서 우승 기록이 0회입니다.",
      strength: "상세 분석 가능한 2경기 기준 최근 3경기 중 최고 순위는 2위입니다.",
      overallOpinion: "최근 3경기에서 우승 기록이 0회입니다." }, {}, null, undefined, [], options);
    expect(once.strength).toBe("최근 3경기 중 최고 순위는 2위입니다.");
    expect(once.overallOpinion).not.toContain("우승 기록이 0회");
    expect(once.overallOpinion).not.toContain("최고 순위는 2위");
    expect(once.overallOpinion).not.toBe("");
    expect(applySquadEvidencePolicy(once, {}, null, undefined, [], options)).toEqual(once);
  });

  it.each(["spicy", "mild"])("총평 연결은 근거의 방향으로 정한다: %s", (coachingStyle) => {
    for (const [avgTradeLatency, connector] of [[5000, "했고"], [15000, "지만"]] as const) {
      const stats = { avgTradeLatency, totalTradeKills: 5 };
      const options = { coachingStyle, benchmarkStats: { avgTradeLatency: 10000 }, matchesSummary: [{ winPlace: 1 }, { winPlace: 3 }, { winPlace: 5 }] };
      // 약점 칸이 비면 매운맛은 서버가 백업 사실로 채우고 총평에서 뺀다. 여기서는 총평 연결만 보려고 약점을 채워 둔다.
      const once = applySquadEvidencePolicy({ ...source, weakness: "약점", overallOpinion: "백업이 높은 반면 우승 1회를 기록했네." }, stats, null, undefined, [], options);
      expect(once.overallOpinion).toContain(connector);
      expect(once.overallOpinion).not.toContain("반면");
      expect(once.overallOpinion).toContain("백업 속도 평균");
      expect(once.overallOpinion).toContain("우승 1회");
      expect(applySquadEvidencePolicy(once, stats, null, undefined, [], options)).toEqual(once);
    }
  });

  it.each(["spicy", "mild"])("모든 팀원의 칭찬은 실측 비중으로 만들고 낮은 비중은 중립 서술한다: %s", (coachingStyle) => {
    const profiles = [
      { name: "Low", totalKills: 2, shares: { damage: 10, kill: 13 } },
      { name: "High", totalKills: 7, shares: { damage: 47, kill: 47 } },
      { name: "Other", totalKills: 6, shares: { damage: 43, kill: 40 } },
    ];
    const input = { ...source, memberFeedbacks: profiles.map(({ name }) => ({ name, praise: "딜 99%·킬 99%로 화력의 한 축을 맡았네", fault: "", advice: "" })) };
    const once = applySquadEvidencePolicy(input, {}, null, undefined, profiles, { coachingStyle });
    expect(once.memberFeedbacks[0].praise).toBe(coachingStyle === "spicy" ? "팀 딜 10%와 킬 13%를 기록했네." : "팀 딜 10%와 킬 13%를 기록했습니다.");
    expect(once.memberFeedbacks[1].praise).toMatch(/47%.*화력/);
    for (const member of once.memberFeedbacks) {
      expect(member.praise).not.toContain("99%");
      expect(member.praise).toMatch(/[.!?]$/);
    }
    expect(applySquadEvidencePolicy(once, {}, null, undefined, profiles, { coachingStyle })).toEqual(once);
  });
});
