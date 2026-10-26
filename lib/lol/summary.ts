import type { LolRecentMatch, LolQueueSummary, LolSearchResult } from "./types";

const MIN_SUMMARY_GAME_DURATION_SECONDS = 300;
// 일반 칼바람 큐만 센다. 아수라장(2400) 등 gameMode가 같은 변형 모드는 통계에 섞지 않는다.
export const LOL_ARAM_QUEUE_IDS: ReadonlySet<number> = new Set([100, 450]);

function summarizeKda(matches: LolRecentMatch[]) {
  const complete = matches.filter(
    (match) => match.kills !== null && match.deaths !== null && match.assists !== null,
  );
  const kills = complete.reduce((sum, match) => sum + match.kills!, 0);
  const deaths = complete.reduce((sum, match) => sum + match.deaths!, 0);
  const assists = complete.reduce((sum, match) => sum + match.assists!, 0);
  const sampleSize = complete.length;
  return {
    sampleSize,
    averageKills: sampleSize ? kills / sampleSize : null,
    averageDeaths: sampleSize ? deaths / sampleSize : null,
    averageAssists: sampleSize ? assists / sampleSize : null,
    averageKda: deaths > 0 ? (kills + assists) / deaths : null,
    perfect: sampleSize > 0 && deaths === 0,
    perfectCount: complete.filter((match) => match.deaths === 0).length,
  };
}

function matchesQueue(
  match: LolRecentMatch,
  queue: LolQueueSummary["queue"],
): boolean {
  return (
    queue === "all" ||
    (queue === "solo" && match.queueId === 420) ||
    (queue === "flex" && match.queueId === 440) ||
    (queue === "aram" && LOL_ARAM_QUEUE_IDS.has(match.queueId))
  );
}

type PeerRow = LolQueueSummary["teammates"][number];
type PeerInput = { riotId: string; playerKey?: string; ref?: string; win: boolean | null; profileIconId?: number };

function addPeers(rows: Map<string, PeerRow>, peers: PeerInput[], match: LolRecentMatch) {
  const seen = new Set<string>();
  for (const participant of peers) {
    const key = participant.playerKey ?? participant.riotId;
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    const row = rows.get(key) ?? {
      riotId: participant.riotId,
      ...(participant.playerKey ? { playerKey: participant.playerKey } : {}),
      ...(participant.ref ? { ref: participant.ref } : {}),
      games: 0,
      wins: 0,
      losses: 0,
      winRatePct: null,
    };
    // 소환사 아이콘은 가장 최근 경기의 상세 참가자 값을 쓴다.
    const profileIconId = participant.profileIconId ?? match.details?.teams
      .flatMap((team) => team.participants).find((player) => player.riotId === participant.riotId)?.profileIconId;
    if (row.profileIconId === undefined && profileIconId !== undefined) row.profileIconId = profileIconId;
    row.games += 1;
    if (typeof participant.win === "boolean") {
      if (participant.win) row.wins += 1;
      else row.losses += 1;
    }
    rows.set(key, row);
  }
}

// 2경기 이상 함께한 소환사만 경기 수 순으로 최대 10명 보여 준다.
function rankPeers(rows: Map<string, PeerRow>): PeerRow[] {
  return [...rows.values()]
    .filter((row) => row.games >= 2)
    .map((row) => ({
      ...row,
      winRatePct: row.wins + row.losses ? (row.wins / (row.wins + row.losses)) * 100 : null,
    }))
    .sort((a, b) =>
      b.games - a.games ||
      (b.winRatePct ?? -1) - (a.winRatePct ?? -1) ||
      a.riotId.localeCompare(b.riotId, "ko"))
    .slice(0, 10);
}

export function summarizeRecentMatches(
  matches: LolRecentMatch[],
  ownRiotId: string,
): LolSearchResult["summaries"] {
  return Object.fromEntries(
    (["all", "solo", "flex", "aram"] as const).map((queue) => {
      const selected = matches.filter((match) => matchesQueue(match, queue));
      const valid = selected.filter(
        (match) =>
          !match.remake &&
          match.gameDuration !== null &&
          match.gameDuration >= MIN_SUMMARY_GAME_DURATION_SECONDS &&
          match.win !== null,
      );
      const kda = summarizeKda(valid);
      const participation = valid.map((match) => match.killParticipationPct)
        .filter((value): value is number => value !== null);
      const wins = valid.filter((match) => match.win).length;
      const champions = new Map<number, LolRecentMatch[]>();
      for (const match of valid)
        champions.set(match.championId, [
          ...(champions.get(match.championId) ?? []),
          match,
        ]);
      const positions = Object.fromEntries(
        (
          ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", "미분류"] as const
        ).map((position) => [
          position,
          valid.filter((match) => match.teamPosition === position).length,
        ]),
      ) as LolQueueSummary["positions"];
      const teammates = new Map<string, PeerRow>();
      const opponents = new Map<string, PeerRow>();
      for (const match of valid) {
        const team = match.details?.teams.find((entry) =>
          entry.participants.some((participant) => participant.riotId === ownRiotId),
        );
        const peers = match.teammates ?? team?.participants
          .filter((participant) => participant.riotId !== ownRiotId && participant.riotId !== "Riot ID 미제공") ?? [];
        addPeers(teammates, peers.map((participant) => ({ ...participant, win: participant.win })), match);
        // 상대 팀은 상세 참가자에서만 알 수 있고, 승패는 본인 기준으로 센다.
        if (team) addPeers(opponents, match.details!.teams.filter((entry) => entry !== team)
          .flatMap((entry) => entry.participants)
          .filter((participant) => participant.riotId !== "Riot ID 미제공")
          .map((participant) => ({ ...participant, win: match.win })), match);
      }
      return [
        queue,
        {
          queue,
          sampleSize: selected.length,
          validSampleSize: valid.length,
          excludedCount: selected.length - valid.length,
          wins,
          losses: valid.length - wins,
          averageKills: kda.averageKills,
          averageDeaths: kda.averageDeaths,
          averageAssists: kda.averageAssists,
          killsSampleSize: kda.sampleSize,
          deathsSampleSize: kda.sampleSize,
          assistsSampleSize: kda.sampleSize,
          averageKillParticipationPct: participation.length
            ? participation.reduce((sum, value) => sum + value, 0) / participation.length
            : null,
          killParticipationSampleSize: participation.length,
          winRatePct: valid.length
            ? (wins / valid.length) * 100
            : null,
          averageKda: kda.averageKda,
          perfect: kda.perfect,
          perfectCount: kda.perfectCount,
          positions,
          teammates: rankPeers(teammates),
          opponents: rankPeers(opponents),
          champions: [...champions.entries()].map(([championId, games]) => {
            const championKda = summarizeKda(games);
            const wins = games.filter((match) => match.win).length;
            return {
              championId,
              championImageId: games[0].championImageId,
              championName: games[0].championNameKo,
              games: games.length,
              wins,
              winRatePct: (wins / games.length) * 100,
              averageKda: championKda.averageKda,
              perfect: championKda.perfect,
            };
          }),
        },
      ];
    }),
  ) as LolSearchResult["summaries"];
}

