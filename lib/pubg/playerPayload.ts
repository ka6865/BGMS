import type { StatsBucket, StatsPartySize } from "@/types/stats-page";

export type PlayerModeBuckets = Partial<Record<StatsPartySize, StatsBucket | null>>;
type ModeStats = Record<string, StatsBucket | null>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface PubgPlayerPayload {
  data: {
    id: string;
    attributes: { name: string; banType?: string; clanId?: string | null };
    relationships: { matches: { data: { id: string }[] } };
  }[];
}

export function isPlayerPayload(value: unknown): value is PubgPlayerPayload {
  if (!isRecord(value) || !Array.isArray(value.data)) return false;
  return value.data.every((player) => {
    if (!isRecord(player) || !nonEmptyString(player.id) || !isRecord(player.attributes)
      || !nonEmptyString(player.attributes.name) || !isRecord(player.relationships)
      || !isRecord(player.relationships.matches)) return false;
    const matches = player.relationships.matches.data;
    return Array.isArray(matches) && matches.every((match) => isRecord(match) && nonEmptyString(match.id));
  });
}

export interface PubgSeason {
  id: string;
  name?: string;
  attributes?: { isCurrentSeason?: boolean };
  isCurrentSeason?: boolean;
}

export function isSeasonList(value: unknown): value is PubgSeason[] {
  return Array.isArray(value) && value.every((season) => isRecord(season)
    && nonEmptyString(season.id)
    && (season.attributes === undefined || isRecord(season.attributes)));
}

export function isSeasonsPayload(value: unknown): value is { data: PubgSeason[] } {
  return isRecord(value) && isSeasonList(value.data) && value.data.length > 0;
}

function isStatsBucket(value: unknown): value is StatsBucket {
  if (!isRecord(value)) return false;
  // These values drive the overview. Missing measurements must not become zero.
  return ["roundsPlayed", "kills", "assists", "wins", "damageDealt", "dBNOs"].every((key) => (
    typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0
  ));
}

function isModeStats(value: unknown): value is ModeStats {
  return isRecord(value) && Object.entries(value).every(([mode, stats]) => (
    /^(solo|duo|squad)(-fpp)?$/.test(mode) && (stats === null || isStatsBucket(stats))
  ));
}

export interface PubgNormalPayload {
  data: { attributes: { gameModeStats: ModeStats } };
}

export interface PubgRankedPayload {
  data: { attributes: { rankedGameModeStats: ModeStats } };
}

export function isNormalPayload(value: unknown): value is PubgNormalPayload {
  return isRecord(value) && isRecord(value.data) && isRecord(value.data.attributes)
    && isModeStats(value.data.attributes.gameModeStats);
}

export function isRankedPayload(value: unknown): value is PubgRankedPayload {
  return isRecord(value) && isRecord(value.data) && isRecord(value.data.attributes)
    && isModeStats(value.data.attributes.rankedGameModeStats);
}

export function selectPlayerModeBuckets(stats: ModeStats): PlayerModeBuckets {
  return Object.fromEntries((["solo", "duo", "squad"] as const).map((mode) => {
    const fpp = stats[`${mode}-fpp`];
    const tpp = stats[mode];
    const selected = !fpp ? tpp : !tpp ? fpp : fpp.roundsPlayed >= tpp.roundsPlayed ? fpp : tpp;
    return [mode, selected ?? null];
  }));
}

export function validatedCachedBuckets(value: unknown): PlayerModeBuckets | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  if (!Object.entries(value).every(([mode, bucket]) => (
    ["solo", "duo", "squad"].includes(mode) && (bucket === null || isStatsBucket(bucket))
  ))) return null;
  // Legacy failed lookups also stored all-null buckets. Their provenance is
  // unknown, so do not present them as verified previous play records.
  return Object.values(value).some(isStatsBucket) ? value as PlayerModeBuckets : null;
}
