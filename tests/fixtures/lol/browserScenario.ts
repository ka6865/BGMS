import { buildLolMatchInsights, summarizeLolRecentTrends } from "../../../lib/lol/insights";
import { buildLolChallengeProfile, parseLolChallengeCatalog } from "../../../lib/lol/challengeProfile";
import { challengeConfigFixture, challengePercentilesFixture, challengePlayerFixture } from "./challengeProfile";
import { challengeFixture } from "./challenges";
import type { LolPlayerMatchSummary } from "../../../lib/lol/types";

const insights = buildLolMatchInsights({ challenges: challengeFixture, position: "MIDDLE", queueId: 420,
  duration: 1500, visionScore: 25, opponentVisionScore: 18 });
const objectives = [
  "tower",
  "dragon",
  "baron",
  "riftHerald",
  "horde",
  "inhibitor",
];
const players = Array.from({ length: 10 }, (_, index) => {
  const blue = index < 5;
  const name = blue ? `blue${index}` : `red${index - 5}`;
  return {
    riotId: `${name}#KR1`,
    championId: blue ? 103 : 86,
    championName: blue ? "Ahri" : "Garen",
    championNameKo: blue ? "아리" : "가렌",
    championImageId: blue ? "Ahri" : "Garen",
    championLevel: 11 + index,
    win: !blue,
    spells: [
      { id: 4, name: "점멸", image: "SummonerFlash.png" },
      { id: 14, name: "점화", image: "SummonerDot.png" },
    ],
    runes: {
      keystone: {
        id: 8005,
        name: "집중 공격",
        image: "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png",
      },
      primaryStyle: {
        id: 8000,
        name: "정밀",
        image: "perk-images/Styles/7201_Precision.png",
      },
      subStyle: {
        id: 8100,
        name: "지배",
        image: "perk-images/Styles/7200_Domination.png",
      },
    },
    kills: index === 1 ? 7 : blue ? 4 : 2,
    deaths: index === 1 ? 1 : blue ? 3 : 2,
    assists: index === 1 ? 0 : 6,
    items: Array.from({ length: 7 }, (_, itemIndex) => ({
      id: itemIndex === 0 ? 1056 : 0,
      name: itemIndex === 0 ? "도란의 반지" : "",
    })),
    damageToChampions: 9000 + index * 1000,
    damageTaken: 12000 + index * 1000,
    cs: 180,
    visionScore: 22,
    goldEarned: 12000,
    wardsPlaced: 8,
    wardsKilled: 4,
    detectorWardsPlaced: 2,
    damageDealtToObjectives: 1000,
    damageDealtToTurrets: 500,
    killParticipationPct: 50,
  };
});

const details = {
  teams: [200, 100].map((teamId) => ({
    teamId,
    win: teamId === 200,
    totalKills: teamId === 100 ? 20 : 30,
    totalGold: teamId === 100 ? 50000 : 60000,
    objectives: Object.fromEntries(
      objectives.map((key) => [key, { kills: 1, first: key === "dragon" }]),
    ),
    participants: players.slice(
      teamId === 100 ? 0 : 5,
      teamId === 100 ? 5 : 10,
    ),
  })),
};

export const matches = Array.from({ length: 5 }, (_, index) => ({
  insights,
  dataDragonVersion: "16.21.1",
  matchId: `FIXTURE_${index + 1}`,
  queueId: [420, 440, 450, 420, 440][index],
  gameMode: index === 2 ? "ARAM" : "CLASSIC",
  gameEndTimestamp: Date.now() - (index + 1) * 60_000,
  gameDuration: 1500,
  win: index % 2 === 0,
  championName: index === 1 || index === 4 ? "Garen" : "Ahri",
  championId: index === 1 || index === 4 ? 86 : 103,
  championImageId: index === 1 || index === 4 ? "Garen" : "Ahri",
  championNameKo: index === 1 || index === 4 ? "가렌" : "아리",
  kills: 8,
  deaths: index === 0 ? 0 : 2,
  assists: 6,
  cs: 180,
  goldEarned: 12000,
  wardsPlaced: 8,
  wardsKilled: 4,
  detectorWardsPlaced: 2,
  damageDealtToObjectives: 1000,
  damageDealtToTurrets: 500,
  killParticipationPct: 40,
  csPerMinute: 7.2,
  goldPerMinute: 480,
  teamPosition: "MIDDLE",
  remake: false,
  // 경기별 LP 증감 표시 확인용: 첫 판 승리 +20, 둘째 판 패배 강등.
  ...(index === 0 ? { lpChange: { kind: "lp" as const, value: 20 } } : index === 1 ? { lpChange: { kind: "demotion" as const } } : {}),
  details,
}));

export const fixtureResult = {
  challengeProfile: buildLolChallengeProfile(challengePlayerFixture, parseLolChallengeCatalog(challengeConfigFixture, challengePercentilesFixture)),
  recentTrends: summarizeLolRecentTrends(Array.from({ length: 9 }, () => ({ queue_id: 420, duration_seconds: 1500,
    win: true, remake: false, team_position: "MIDDLE", vision_score: 25, challenges: challengeFixture } as LolPlayerMatchSummary))),
  mastery: {
    status: "ready",
    champions: [
      { championId: 103, championName: "아리", championImageId: "Ahri", championLevel: 14, championPoints: 250000,
        lastPlayTime: 1790000000000, championPointsUntilNextLevel: 100, championSeasonMilestone: 2 },
      { championId: 86, championName: "가렌", championImageId: "Garen", championLevel: 11, championPoints: 150000,
        lastPlayTime: 1790000000000, championPointsUntilNextLevel: 200, championSeasonMilestone: 1 },
    ],
    recent: { status: "ready", sampleSize: 9, champions: [
      { championId: 103, championName: "아리", championImageId: "Ahri", games: 3, wins: 3, winRatePct: 100, kda: 6, perfect: false },
      { championId: 86, championName: "가렌", championImageId: "Garen", games: 3, wins: 0, winRatePct: 0, kda: 1, perfect: false },
      { championId: 99, championName: "럭스", championImageId: "Lux", games: 3, wins: 2, winRatePct: 200 / 3, kda: 4, perfect: false },
    ] },
  },
  dataDragonVersion: "16.21.1",
  account: { gameName: "blue0", tagLine: "KR1" },
  profile: { profileIconId: 123, summonerLevel: 42 },
  ranked: [
    {
      queueType: "RANKED_FLEX_SR",
      tier: "GOLD",
      rank: "II",
      leaguePoints: 50,
      wins: 10,
      losses: 8,
    },
    {
      queueType: "RANKED_SOLO_5x5",
      tier: "PLATINUM",
      rank: "IV",
      leaguePoints: 20,
      wins: 12,
      losses: 6,
    },
  ],
  rankedHistory: {
    RANKED_SOLO_5x5: {
      points: [
        { tier: "PLATINUM", rank: "IV", lp: 12, date: "2026-10-22", wins: 11, losses: 6, isBaseline: false, recordedAt: "2026-10-22T00:00:00Z" },
        { tier: "PLATINUM", rank: "IV", lp: 20, date: "2026-10-23", wins: 12, losses: 6, isBaseline: false, recordedAt: "2026-10-23T00:00:00Z" },
      ],
      highest: { tier: "PLATINUM", rank: "IV", lp: 20, recordedAt: "2026-10-23T00:00:00Z" },
      trackingSince: "2026-10-22T00:00:00Z",
    },
    RANKED_FLEX_SR: {
      points: [{ tier: "GOLD", rank: "II", lp: 50, date: "2026-10-23", wins: 12, losses: 6, isBaseline: false, recordedAt: "2026-10-23T00:00:00Z" }],
      highest: { tier: "GOLD", rank: "II", lp: 50, recordedAt: "2026-10-23T00:00:00Z" },
      trackingSince: "2026-10-23T00:00:00Z",
    },
  },
  matches,
  matchIds: Array.from({ length: 20 }, (_, index) => `FIXTURE_${index + 1}`),
  loadedCount: 5,
  hasMore: true,
  matchFailures: [],
  lastUpdatedAt: new Date().toISOString(),
  refreshRemainSeconds: 120,
  summaries: Object.fromEntries(
    (["all", "solo", "flex", "aram"] as const).map((queue) => {
      const selected = matches.filter((match) => queue === "all" ||
        (queue === "solo" && match.queueId === 420) ||
        (queue === "flex" && match.queueId === 440) ||
        (queue === "aram" && (match.queueId === 450 || match.gameMode === "ARAM")),
      );
      const wins = selected.filter((match) => match.win).length;
      const deaths = selected.reduce((sum, match) => sum + match.deaths, 0);
      const killsAndAssists = selected.reduce((sum, match) => sum + match.kills + match.assists, 0);
      const averageKda = deaths > 0 ? killsAndAssists / deaths : null;
      return [
        queue,
        {
          queue,
          sampleSize: selected.length,
          validSampleSize: selected.length,
          excludedCount: 0,
          wins,
          losses: selected.length - wins,
          averageKills: 8,
          averageDeaths: selected.reduce((sum, match) => sum + match.deaths, 0) / selected.length,
          averageAssists: 6,
          killsSampleSize: selected.length,
          deathsSampleSize: selected.length,
          assistsSampleSize: selected.length,
          averageKillParticipationPct: 40,
          killParticipationSampleSize: selected.length,
          winRatePct: (wins / selected.length) * 100,
          averageKda,
          perfect: selected.length > 0 && deaths === 0,
          perfectCount: selected.filter((match) => match.deaths === 0).length,
          positions: {
            TOP: 0,
            JUNGLE: 0,
            MIDDLE: selected.length,
            BOTTOM: 0,
            UTILITY: 0,
            미분류: 0,
          },
          teammates: selected.length < 2 ? [] : [{
            riotId: "blue1#KR1", games: selected.length, wins,
            losses: selected.length - wins, winRatePct: (wins / selected.length) * 100,
          }],
          champions: [...new Set(selected.map((match) => match.championId))].reverse().map((id) => {
            const games = selected.filter((match) => match.championId === id);
            const championWins = games.filter((match) => match.win).length;
            const championDeaths = games.reduce((sum, match) => sum + match.deaths, 0);
            const championKillsAndAssists = games.reduce((sum, match) => sum + match.kills + match.assists, 0);
            return {
              championId: id,
              championImageId: games[0].championImageId,
              championName: games[0].championNameKo,
              games: games.length,
              wins: championWins,
              winRatePct: (championWins / games.length) * 100,
              averageKda: championDeaths > 0 ? championKillsAndAssists / championDeaths : null,
              perfect: games.length > 0 && championDeaths === 0,
            };
          }),
        },
      ];
    }),
  ),
  matchStatus: "partial",
};

