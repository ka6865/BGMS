export const LOL_CHALLENGE_KEYS = [
  "laningPhaseGoldExpAdvantage", "earlyLaningPhaseGoldExpAdvantage", "maxCsAdvantageOnLaneOpponent",
  "maxLevelLeadLaneOpponent", "visionScoreAdvantageLaneOpponent", "laneMinionsFirst10Minutes",
  "jungleCsBefore10Minutes", "turretPlatesTaken", "soloKills", "damageTakenOnTeamPercentage",
  "teamDamagePercentage", "killParticipation", "kda", "visionScorePerMinute", "wardTakedowns",
  "controlWardsPlaced", "stealthWardsPlaced", "epicMonsterSteals", "dragonTakedowns", "baronTakedowns",
  "riftHeraldTakedowns", "firstTurretKilled", "turretTakedowns", "killsUnderOwnTurret", "tookLargeDamageSurvived",
  "saveAllyFromDeath", "effectiveHealAndShielding", "skillshotsDodged", "skillshotsHit", "goldPerMinute", "damagePerMinute",
] as const;

export type LolChallenges = Partial<Record<typeof LOL_CHALLENGE_KEYS[number], number>>;

export function pickLolChallenges(value: unknown): LolChallenges {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(LOL_CHALLENGE_KEYS.flatMap(key => {
    const number = source[key];
    return typeof number === "number" && Number.isFinite(number) ? [[key, number]] : [];
  }));
}
