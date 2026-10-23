import type { LolRecentMatch, LolQueueSummary, LolSearchResult } from "./types";

const MIN_SUMMARY_GAME_DURATION_SECONDS = 300;

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
    (queue === "aram" && (match.queueId === 450 || match.gameMode === "ARAM"))
  );
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
      const teammates = new Map<
        string,
        { riotId: string; playerKey?: string; ref?: string; games: number; wins: number; losses: number }
      >();
      for (const match of valid) {
        const team = match.details?.teams.find((entry) =>
          entry.participants.some((participant) => participant.riotId === ownRiotId),
        );
        const peers = match.teammates ?? team?.participants
          .filter((participant) => participant.riotId !== ownRiotId && participant.riotId !== "Riot ID 미제공") ?? [];
        const seen = new Set<string>();
        for (const participant of peers) {
          const key = participant.playerKey ?? participant.riotId;
          if (!key.trim() || seen.has(key)) continue;
          seen.add(key);
          const row = teammates.get(key) ?? {
            riotId: participant.riotId,
            ...(participant.playerKey ? { playerKey: participant.playerKey } : {}),
            ...(participant.ref ? { ref: participant.ref } : {}),
            games: 0,
            wins: 0,
            losses: 0,
          };
          row.games += 1;
          if (typeof participant.win === "boolean") {
            if (participant.win) row.wins += 1;
            else row.losses += 1;
          }
          teammates.set(key, row);
        }
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
          teammates: [...teammates.values()]
            .filter((teammate) => teammate.games >= 2)
            .map((teammate) => ({
              ...teammate,
              winRatePct:
                teammate.wins + teammate.losses
                  ? (teammate.wins / (teammate.wins + teammate.losses)) * 100
                  : null,
            }))
            .sort(
              (a, b) =>
                b.games - a.games ||
                (b.winRatePct ?? -1) - (a.winRatePct ?? -1) ||
                a.riotId.localeCompare(b.riotId, "ko"),
            )
            .slice(0, 5),
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

