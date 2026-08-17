import { describe, expect, it } from "vitest";
import {
  getCurrentSeasonSummary,
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
        timeSurvived: 12000,
        headshotKills: 6,
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

  it("does not substitute normal stats when every ranked bucket has no played rounds", () => {
    const rankedEmptyNormalReady: PlayerStatsResponse = {
      ...readyPlayer,
      stats: {
        ranked: { squad: { ...readyPlayer.stats.ranked!.squad!, roundsPlayed: 0 } },
        normal: readyPlayer.stats.normal,
      },
    };

    expect(getStatsOverviewMetrics(rankedEmptyNormalReady)).toEqual({ kind: "empty", label: "기록 없음" });
  });

  it("derives the current ranked representative summary without another API request", () => {
    expect(getCurrentSeasonSummary(readyPlayer)).toMatchObject({
      kind: "ready",
      seasonName: "Season 8",
      partySize: "squad",
      roundsPlayed: 12,
      wins: 2,
      winRate: "16.7%",
      top10Rate: "50.0%",
      kda: "3.20",
      averageDamage: "300",
      averageSurvival: "16:40",
      headshotRate: "25.0%",
    });
  });

  it("uses top10s when a ranked bucket has no top10Ratio and shows an empty zero-round state", () => {
    const withoutRatio: PlayerStatsResponse = {
      ...readyPlayer,
      stats: {
        ...readyPlayer.stats,
        ranked: {
          ...readyPlayer.stats.ranked,
          squad: { ...readyPlayer.stats.ranked!.squad!, top10Ratio: undefined, top10s: 4 },
        },
      },
    };
    expect(getCurrentSeasonSummary(withoutRatio)).toMatchObject({
      kind: "ready",
      top10Rate: "33.3%",
    });

    const empty: PlayerStatsResponse = {
      ...readyPlayer,
      stats: {
        ranked: {
          squad: { ...readyPlayer.stats.ranked!.squad!, roundsPlayed: 0 },
          duo: null,
          solo: null,
        },
        normal: null,
      },
    };
    expect(getCurrentSeasonSummary(empty)).toEqual({
      kind: "empty",
      seasonId: "season-8",
      seasonName: "Season 8",
      label: "기록 없음",
    });
  });

  it("does not divide by zero when the player has no kills", () => {
    const noKills: PlayerStatsResponse = {
      ...readyPlayer,
      stats: {
        ...readyPlayer.stats,
        ranked: {
          ...readyPlayer.stats.ranked,
          squad: { ...readyPlayer.stats.ranked!.squad!, kills: 0, headshotKills: 0 },
        },
      },
    };
    expect(getCurrentSeasonSummary(noKills)).toMatchObject({
      kind: "ready",
      headshotRate: "—",
    });
  });
});
