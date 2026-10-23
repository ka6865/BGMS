import { describe, expect, it } from "vitest";
import { summarizeRecentMatches } from "@/lib/lol/summary";
import type { LolRecentMatch } from "@/lib/lol/types";

function match(index: number, values: Partial<LolRecentMatch> = {}): LolRecentMatch {
  return {
    matchId: `KR_${index}`, queueId: 420, gameMode: "CLASSIC",
    gameEndTimestamp: index, gameDuration: 1500, win: true,
    championName: "Ahri", championId: 103, championImageId: "Ahri", championNameKo: "아리",
    kills: 8, deaths: 2, assists: 6, cs: 180, goldEarned: 12000,
    wardsPlaced: 8, wardsKilled: 4, detectorWardsPlaced: 2,
    damageDealtToObjectives: 1000, damageDealtToTurrets: 500,
    killParticipationPct: 40, csPerMinute: 7.2, goldPerMinute: 480,
    teamPosition: "MIDDLE", remake: false,
    ...values,
  };
}

describe("LoL 서버·클라이언트 공용 요약", () => {
  it("누적 표본과 큐별 통계를 재계산하고 합산 KDA를 사용한다", () => {
    const first = Array.from({ length: 5 }, (_, index) => match(index));
    const more = Array.from({ length: 5 }, (_, index) => match(index + 5, {
      queueId: 440, win: false, kills: 2, deaths: 4, assists: 2,
    }));
    const before = JSON.stringify([...first, ...more]);
    expect(summarizeRecentMatches(first, "Self#KR1").all.sampleSize).toBe(5);
    const summary = summarizeRecentMatches([...first, ...more], "Self#KR1");
    expect(summary.all).toMatchObject({
      sampleSize: 10, validSampleSize: 10, wins: 5, losses: 5,
      winRatePct: 50, averageKda: 3, averageKills: 5,
      averageDeaths: 3, averageAssists: 4, averageKillParticipationPct: 40,
    });
    expect(summary.solo.sampleSize).toBe(5);
    expect(summary.flex.sampleSize).toBe(5);
    expect(summary.aram.sampleSize).toBe(0);
    expect(JSON.stringify([...first, ...more])).toBe(before);
    expect(summarizeRecentMatches(JSON.parse(before), "Self#KR1")).toEqual(summary);
  });

  it("제외 경기와 KDA 결측을 유지하고 무사망은 Perfect로 집계한다", () => {
    const result = summarizeRecentMatches([
      match(1, { deaths: 0 }), match(2, { remake: true }),
      match(3, { gameDuration: 299 }), match(4, { kills: null }),
    ], "Self#KR1");
    expect(result.all).toMatchObject({
      sampleSize: 4, validSampleSize: 2, excludedCount: 2,
      killsSampleSize: 1, averageKda: null, perfect: true, perfectCount: 1,
    });
  });

  it("동료는 경기별 중복을 제거하고 승패 미제공은 승률에서 제외한다", () => {
    const teammates = [
      { riotId: "Peer#KR1", win: null },
      { riotId: "Peer#KR1", win: null },
      { riotId: "Known#KR1", win: false },
    ];
    const result = summarizeRecentMatches([
      match(1, { teammates }), match(2, { teammates }),
      match(3, { remake: true, teammates }),
    ], "Self#KR1");
    expect(result.solo.teammates).toEqual([
      { riotId: "Known#KR1", games: 2, wins: 0, losses: 2, winRatePct: 0 },
      { riotId: "Peer#KR1", games: 2, wins: 0, losses: 0, winRatePct: null },
    ]);
  });
});
