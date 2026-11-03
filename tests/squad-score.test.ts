import { describe, expect, it } from "vitest";
import { computeSquadGrade, computeSquadScores, placementPoints, SQUAD_GRADE_MIN_AXES } from "@/lib/pubg-analysis/squadScore";

// KangHeeSung_ 4인 파티와 같은 모양이다. 소생 14/30, 백업 12.4초(복수 2건), 연막 3회.
const STATS = { avgTradeLatency: 12409, totalTradeKills: 2, totalRevives: 14, totalTeammateKnocks: 30 };
const base = {
  stats: STATS, smokeRescues: 3, knocks: 30,
  damageShares: [45, 26, 13, 15], placements: [1, 2, 5, 7, 8], matchCount: 5,
};

describe("computeSquadScores", () => {
  it("고정 기준값으로 환산하고 표본이 모자란 항목은 비운다", () => {
    expect(computeSquadScores(base)).toEqual({
      survivalCare: 78, // 46.7% / 60%
      backupSpeed: null, // 복수 2건은 표본 미달
      smokeRescue: 40, // 3/30 = 10% / 25%
      damageBalance: 20, // 최대 45%, 균등 25%에서 25%p 넘으면 0점
      placement: 62, // (100 + 80 + 60 + 35 + 35) / 5
    });
  });

  it("경기 수가 3경기 미만이면 모든 점수를 비운다", () => {
    expect(Object.values(computeSquadScores({ ...base, matchCount: 2 }))).toEqual([null, null, null, null, null]);
  });

  it("복수가 3건 이상이면 백업 속도를 점수로 낸다", () => {
    const scores = computeSquadScores({ ...base, stats: { ...STATS, totalTradeKills: 3, avgTradeLatency: 5000 } });
    expect(scores.backupSpeed).toBe(100);
    expect(computeSquadScores({ ...base, stats: { ...STATS, totalTradeKills: 3, avgTradeLatency: 30000 } }).backupSpeed).toBe(0);
  });

  it("딜 분배는 인원수별 균등 비중을 기준으로 한다", () => {
    expect(computeSquadScores({ ...base, damageShares: [25, 25, 25, 25] }).damageBalance).toBe(100);
    expect(computeSquadScores({ ...base, damageShares: [50, 50] }).damageBalance).toBe(100);
    expect(computeSquadScores({ ...base, damageShares: [75, 25] }).damageBalance).toBe(0);
    expect(computeSquadScores({ ...base, damageShares: [60, null, 20, 20] }).damageBalance).toBeNull();
  });

  it("같은 플레이는 다른 팀의 성적과 관계없이 같은 점수다", () => {
    expect(computeSquadScores(base)).toEqual(computeSquadScores({ ...base }));
  });

  it("순위 점수는 구간표를 따른다", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 11, 15, 16].map(placementPoints)).toEqual([100, 80, 80, 60, 60, 35, 35, 15, 15, 0]);
  });
});

describe("computeSquadGrade", () => {
  it("측정된 축의 가중 평균을 개인 티어 경계표로 등급화한다", () => {
    const result = computeSquadGrade(computeSquadScores(base));
    expect(result.measuredAxes).toBe(4);
    expect(result.totalAxes).toBe(5);
    expect(result.grade).toMatch(/^[SABCD][+-]?$/);
  });

  it("측정된 축이 모자라면 등급을 내지 않는다", () => {
    const scores = { survivalCare: 80, backupSpeed: null, smokeRescue: null, damageBalance: 70, placement: null };
    expect(SQUAD_GRADE_MIN_AXES).toBe(3);
    expect(computeSquadGrade(scores)).toMatchObject({ grade: null, score: null, measuredAxes: 2 });
  });

  it("측정되지 않은 축은 0점이 아니라 가중치에서 빠진다", () => {
    const withMissing = computeSquadGrade({ survivalCare: 80, backupSpeed: null, smokeRescue: 80, damageBalance: 80, placement: null });
    expect(withMissing.score).toBe(80);
  });
});
