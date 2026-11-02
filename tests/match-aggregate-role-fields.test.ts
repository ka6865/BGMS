import { describe, expect, it } from "vitest";
import { aggregateMatches, teamSizeOfMode } from "@/lib/pubg-analysis/matchAggregate";
import { classifyRole, isComboBlocked } from "@/lib/pubg-analysis/roleClassifier";

const match = (overrides: Record<string, unknown>) => ({
  gameMode: "squad",
  calculationVersion: 5,
  stats: { winPlace: 10, kills: 0, processedDamageDealt: 0 },
  tradeStats: { enemyTeamWipes: 0 },
  teamImpact: { teamDamageShare: 25 },
  ...overrides,
});

describe("role aggregate fields", () => {
  it("maps team size from the mode and leaves solo and unknown modes out", () => {
    expect(teamSizeOfMode("duo-fpp")).toBe(2);
    expect(teamSizeOfMode("squad")).toBe(4);
    expect(teamSizeOfMode("solo")).toBeNull();
    expect(teamSizeOfMode("arcade")).toBeNull();
  });

  it("scales team damage share by the fair share so 1.0 means an even split", () => {
    // 듀오 50%와 스쿼드 25%는 둘 다 공정 분담(1.0)이다.
    const duo = aggregateMatches([match({ gameMode: "duo", teamImpact: { teamDamageShare: 50 } })]);
    const squad = aggregateMatches([match({ teamImpact: { teamDamageShare: 25 } })]);
    expect(duo.avgTeamDamageShareFair).toBe(1);
    expect(squad.avgTeamDamageShareFair).toBe(1);
    // 솔로는 공정 분담 계산에서 빠진다.
    const solo = aggregateMatches([match({ gameMode: "solo", teamImpact: { teamDamageShare: 100 } })]);
    expect(solo.avgTeamDamageShareFair).toBeNull();
  });

  it("counts wins over the given matches and team wipes only for calculation 5", () => {
    const result = aggregateMatches([
      match({ stats: { winPlace: 1 }, tradeStats: { enemyTeamWipes: 2 } }),
      match({ stats: { winPlace: 1 }, calculationVersion: 4, tradeStats: { enemyTeamWipes: 5 } }),
      match({ stats: { winPlace: 3 }, tradeStats: { enemyTeamWipes: 1 } }),
    ]);
    expect(result.totalWins).toBe(2);
    expect(result.totalTeamWipesCalc5).toBe(3);
  });
});

describe("role badges and combos from aggregate fields", () => {
  const base = { mLen: 1, modeDistribution: { main: "squad" } };

  it("adds a win badge from one win and a team-wipe badge from two calculation 5 wipes", () => {
    const won = classifyRole({ ...base, totalWins: 1, totalTeamWipesCalc5: 1 }, {}, "B");
    expect(won.badges).toContain("우승 1회");
    expect(won.badges.some((badge) => badge.startsWith("전멸 기여"))).toBe(false);
    const wiped = classifyRole({ ...base, totalWins: 0, totalTeamWipesCalc5: 2 }, {}, "B");
    expect(wiped.badges).toContain("전멸 기여 2회");
    expect(wiped.badges.some((badge) => badge.startsWith("우승"))).toBe(false);
  });

  it("blocks combo pairs regardless of order and keeps unrelated pairs open", () => {
    expect(isComboBlocked("dropPredator", "brawler")).toBe(true);
    expect(isComboBlocked("brawler", "dropPredator")).toBe(true);
    expect(isComboBlocked("shield", "avenger")).toBe(true);
    expect(isComboBlocked("executor", "phantomOverwatch")).toBe(false);
  });
});
