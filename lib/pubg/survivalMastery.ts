import type { StatsSurvivalMastery } from "@/types/stats-page";

export const SURVIVAL_MASTERY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && Number.isInteger(number) ? number : null;
}

export function normalizeSurvivalMasteryPayload(payload: unknown): StatsSurvivalMastery | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  const attributes = isRecord(data.attributes) ? data.attributes : null;
  if (!attributes) return null;

  const level = finiteInteger(attributes.level);
  if (level == null) return null;

  const xp = finiteInteger(attributes.xp);
  const tier = finiteInteger(attributes.tier);
  const totalMatchesPlayed = finiteInteger(attributes.totalMatchesPlayed);

  return {
    ...(xp == null ? {} : { xp }),
    ...(tier == null ? {} : { tier }),
    level,
    ...(totalMatchesPlayed == null ? {} : { totalMatchesPlayed }),
  };
}

export function shouldRefreshSurvivalMastery(
  updatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!updatedAt) return true;
  const timestamp = Date.parse(updatedAt);
  return !Number.isFinite(timestamp) || now - timestamp >= SURVIVAL_MASTERY_CACHE_TTL_MS;
}
