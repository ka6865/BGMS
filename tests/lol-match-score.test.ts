import { scoreLolMatch } from "@/lib/lol/matchScore";

const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const player = (teamId: number, index: number, extra: Record<string, number | boolean | string> = {}) => ({
  teamId, win: teamId === 100, teamPosition: POSITIONS[index], kills: 3, deaths: 3, assists: 5,
  totalDamageDealtToChampions: 15000, goldEarned: 10000, damageSelfMitigated: 10000, damageDealtToObjectives: 5000,
  visionScore: 20, totalHealsOnTeammates: 0, totalDamageShieldedOnTeammates: 0, timeCCingOthers: 10, ...extra,
});
const match = (overrides: Record<number, Record<string, number | boolean | string>> = {}, info: Record<string, unknown> = {}) => ({
  queueId: 420, gameDuration: 1800,
  participants: Array.from({ length: 10 }, (_, index) => player(index < 5 ? 100 : 200, index % 5, overrides[index])),
  ...info,
});

describe("BGMS 경기 기여도 점수(시험판)", () => {
  it("팀 기여 평균은 1인분이고 순위·MVP·ACE는 한 명씩이며 지표가 같으면 팀운은 보통이다", () => {
    const scores = scoreLolMatch(match());
    for (const team of [scores.slice(0, 5), scores.slice(5)])
      expect(team.reduce((total, score) => total + score!.inbun, 0) / 5).toBeCloseTo(1, 1);
    expect(new Set(scores.map((score) => score!.rank)).size).toBe(10);
    expect(scores.filter((score) => score?.award === "MVP")).toHaveLength(1);
    expect(scores.filter((score) => score?.award === "ACE")).toHaveLength(1);
    expect(scores.every((score) => score!.teamLuck === "보통")).toBe(true);
  });
  it("칼바람은 포지션 없이 같은 기준이라 똑같이 플레이하면 모두 5점이다", () => {
    expect(scoreLolMatch(match({}, { queueId: 450 })).every((score) => score?.score === 5 && score.inbun === 1)).toBe(true);
  });
  it("캐리한 미드는 1위·MVP가 되고, 시야·보호를 많이 한 서포터는 피해가 적어도 평균 이상이다", () => {
    const scores = scoreLolMatch(match({
      2: { kills: 12, deaths: 1, totalDamageDealtToChampions: 40000, goldEarned: 16000 },
      4: { totalDamageDealtToChampions: 5000, goldEarned: 7000, visionScore: 45, totalDamageShieldedOnTeammates: 6000, assists: 14 },
    }));
    expect(scores[2]).toMatchObject({ rank: 1, award: "MVP" });
    expect(scores[2]!.inbun).toBeGreaterThan(1.2);
    expect(scores[4]!.score).toBeGreaterThan(5);
  });
  it("팀원이 상대보다 골드·피해·KDA가 크게 앞서면 팀운이 좋다", () => {
    const strong = Object.fromEntries([1, 2, 3, 4].map((index) => [index, { goldEarned: 15000, totalDamageDealtToChampions: 25000, kills: 8, deaths: 1 }]));
    expect(scoreLolMatch(match(strong))[0]!.teamLuck).toBe("최고");
    expect(scoreLolMatch(match(strong))[5]!.teamLuck).toBe("최악");
  });
  it("다시하기·5분 미만·협곡과 칼바람 외 큐·인원 부족은 점수를 내지 않는다", () => {
    expect(scoreLolMatch(match({ 0: { gameEndedInEarlySurrender: true } })).every((score) => score === null)).toBe(true);
    expect(scoreLolMatch(match({}, { gameDuration: 200 })).every((score) => score === null)).toBe(true);
    expect(scoreLolMatch(match({}, { queueId: 1700 })).every((score) => score === null)).toBe(true);
    expect(scoreLolMatch({ queueId: 420, gameDuration: 1800, participants: [player(100, 0)] })).toEqual([null]);
  });
});
