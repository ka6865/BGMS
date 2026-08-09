import { describe, expect, it } from "vitest";
import {
  getStatsOverviewMetrics,
  normalizeStoredNames,
  parseStatsPlatform,
  parseStatsSectionTab,
} from "@/lib/stats/statsPageModel";
import type { PlayerStatsResponse } from "@/types/stats-page";

const readyPlayer: PlayerStatsResponse = {
  nickname: "FixturePlayer",
  platform: "steam",
  seasonId: "season-8",
  seasons: [{ id: "season-8", name: "Season 8" }],
  stats: {
    ranked: {
      solo: null,
      duo: null,
      squad: {
        roundsPlayed: 12,
        kills: 24,
        assists: 8,
        deaths: 10,
        wins: 2,
        top10Ratio: 0.5,
        damageDealt: 3600,
        dBNOs: 20,
      },
    },
    normal: {
      squad: {
        roundsPlayed: 8,
        kills: 12,
        assists: 5,
        deaths: 7,
        wins: 1,
        top10s: 4,
        damageDealt: 1800,
        dBNOs: 9,
      },
    },
  },
  recentMatches: ["match-1"],
};

describe("stats page primitives", () => {
  it("parses only supported platform and section URL values", () => {
    expect(parseStatsSectionTab("squad")).toBe("squad");
    expect(parseStatsSectionTab("bad")).toBe("overview");
    expect(parseStatsPlatform("kakao")).toBe("kakao");
    expect(parseStatsPlatform("xbox")).toBeNull();
  });

  it("keeps only unique non-empty stored player names in first-seen order", () => {
    expect(normalizeStoredNames(["A", 3, "A", "B", "", "  ", "C"])).toEqual(["A", "B", "C"]);
  });

  it("derives overview values from the first ranked party with played rounds", () => {
    expect(getStatsOverviewMetrics(readyPlayer)).toEqual({
      kind: "ready",
      roundsPlayed: 12,
      kda: "3.20",
      averageDamage: "300",
      top10Rate: "50.0%",
      preferredMode: "squad",
    });
  });

  it("returns an explicit empty state when no stats bucket has played rounds", () => {
    const playerWithoutRounds: PlayerStatsResponse = {
      ...readyPlayer,
      stats: {
        ranked: { squad: { ...readyPlayer.stats.ranked!.squad!, roundsPlayed: 0 } },
        normal: { squad: { ...readyPlayer.stats.normal!.squad!, roundsPlayed: 0 } },
      },
    };

    expect(getStatsOverviewMetrics(playerWithoutRounds)).toEqual({ kind: "empty", label: "기록 없음" });
  });
});
