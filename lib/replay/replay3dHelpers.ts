import type { ZoneState } from "@/types/replay3d";

export type TerrainGrid = {
  grid: readonly (readonly number[])[];
  size: number;
};

const DEFAULT_REPLAY_DURATION_MS = 300_000;
const DEFAULT_MAP_CENTER = 4096;
const MAP_COORDINATE_MAX = 8192;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isMapCoordinate = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= MAP_COORDINATE_MAX;

const isMapRadius = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= MAP_COORDINATE_MAX;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Samples the height grid in the same orientation as the rotated PlaneGeometry.
 * The plane's local Y axis becomes world -Z after rotation.x = -PI / 2.
 */
export function sampleTerrainHeight(
  terrain: TerrainGrid,
  threeX: number,
  threeZ: number,
  mapSize = 100,
): number {
  const size = Math.min(terrain.size, terrain.grid.length);
  if (size <= 0 || !isFiniteNumber(threeX) || !isFiniteNumber(threeZ) || !isFiniteNumber(mapSize) || mapSize <= 0) {
    return 0;
  }

  const maxIndex = size - 1;
  const percentX = clamp01((threeX + mapSize / 2) / mapSize);
  // World +Z maps to the plane's local -Y after the -90 degree X rotation.
  const percentZ = clamp01((mapSize / 2 - threeZ) / mapSize);
  const ixFloat = percentX * maxIndex;
  const iyFloat = percentZ * maxIndex;

  const ix = Math.floor(ixFloat);
  const iy = Math.floor(iyFloat);
  const ix1 = Math.max(0, Math.min(maxIndex, ix));
  const ix2 = Math.max(0, Math.min(maxIndex, ix + 1));
  const iy1 = Math.max(0, Math.min(maxIndex, iy));
  const iy2 = Math.max(0, Math.min(maxIndex, iy + 1));
  const fx = ixFloat - ix;
  const fy = iyFloat - iy;

  const at = (row: number, column: number): number => {
    const value = terrain.grid[row]?.[column];
    return isFiniteNumber(value) ? value : 0;
  };
  const h11 = at(iy1, ix1);
  const h21 = at(iy1, ix2);
  const h12 = at(iy2, ix1);
  const h22 = at(iy2, ix2);
  const h1 = h11 * (1 - fx) + h21 * fx;
  const h2 = h12 * (1 - fx) + h22 * fx;
  return h1 * (1 - fy) + h2 * fy;
}

/** Returns the greatest non-negative finite replay timestamp, or the default when absent. */
export function getReplayMaxTime(
  events: readonly { relativeTimeMs?: unknown }[],
  fallback = DEFAULT_REPLAY_DURATION_MS,
): number {
  let maxTime = -Infinity;
  events.forEach((event) => {
    const timestamp = event?.relativeTimeMs;
    if (isFiniteNumber(timestamp) && timestamp >= 0) {
      maxTime = Math.max(maxTime, timestamp);
    }
  });
  return Number.isFinite(maxTime) ? maxTime : fallback;
}

const latestPastTime = (times: readonly number[] | undefined, currentTimeMs: number): number | null => {
  if (!isFiniteNumber(currentTimeMs)) return null;
  let latest: number | null = null;
  (times ?? []).forEach((time) => {
    if (isFiniteNumber(time) && time <= currentTimeMs && (latest === null || time > latest)) {
      latest = time;
    }
  });
  return latest;
};

/** Returns the death timestamp for the currently active life, if any. */
export function getActiveDeathTime(
  deathTimes: readonly number[] | undefined,
  redeployTimes: readonly number[] | undefined,
  currentTimeMs: number,
): number | null {
  const latestDeath = latestPastTime(deathTimes, currentTimeMs);
  if (latestDeath === null) return null;
  const latestRedeploy = latestPastTime(redeployTimes, currentTimeMs);
  return latestRedeploy === null || latestDeath > latestRedeploy ? latestDeath : null;
}

/**
 * Health samples can lag a blue-chip create event and still report the prior
 * life as zero. Only use a zero health sample as a death signal when the
 * current life has not been recovered after its latest recorded death.
 */
export function shouldMarkPlayerDeadFromHealth(
  deathTimes: readonly number[] | undefined,
  redeployTimes: readonly number[] | undefined,
  currentTimeMs: number,
  health: unknown,
  healthSampleTimeMs?: number | null,
): boolean {
  if (!isFiniteNumber(health) || health > 0 || !isFiniteNumber(currentTimeMs)) return false;

  const latestDeath = latestPastTime(deathTimes, currentTimeMs);
  const latestRedeploy = latestPastTime(redeployTimes, currentTimeMs);
  if (!isFiniteNumber(healthSampleTimeMs)) {
    return latestDeath === null || latestRedeploy === null || latestDeath > latestRedeploy;
  }
  if (healthSampleTimeMs > currentTimeMs) return false;

  // A position sample from before the latest create/redeploy belongs to the
  // previous life. Ignore its zero health, but treat any observation after
  // the redeploy as a real death signal even when the kill event is missing.
  if (
    latestRedeploy !== null &&
    healthSampleTimeMs <= latestRedeploy
  ) {
    return false;
  }

  // A zero sample from the current life is decisive, even if the kill event
  // is absent from the telemetry stream.
  return true;
}

export type ReplayZoneEvent = {
  relativeTimeMs?: unknown;
  whiteX?: unknown;
  whiteY?: unknown;
  whiteRadius?: unknown;
  blueX?: unknown;
  blueY?: unknown;
  blueRadius?: unknown;
};

type MutableZone = {
  t: number;
  whiteX: number | null;
  whiteY: number | null;
  whiteRadius: number | null;
  blueX: number | null;
  blueY: number | null;
  blueRadius: number | null;
};

const ZONE_FIELDS = [
  "whiteX",
  "whiteY",
  "whiteRadius",
  "blueX",
  "blueY",
  "blueRadius",
] as const;

/**
 * Sorts zone samples and fills sparse fields from adjacent valid samples.
 * Missing coordinates never become the old 408000 sentinel (which is outside
 * the 0..8192 map coordinate space).
 */
export function normalizeReplayZoneEvents(events: readonly ReplayZoneEvent[]): ZoneState[] {
  const sorted: MutableZone[] = events
    .map((event, index) => ({
      index,
      t: event && isFiniteNumber(event.relativeTimeMs) ? event.relativeTimeMs : null,
      whiteX: isMapCoordinate(event?.whiteX) ? event.whiteX : null,
      whiteY: isMapCoordinate(event?.whiteY) ? event.whiteY : null,
      whiteRadius: isMapRadius(event?.whiteRadius) ? event.whiteRadius : null,
      blueX: isMapCoordinate(event?.blueX) ? event.blueX : null,
      blueY: isMapCoordinate(event?.blueY) ? event.blueY : null,
      blueRadius: isMapRadius(event?.blueRadius) ? event.blueRadius : null,
    }))
    .filter((event): event is MutableZone & { index: number; t: number } => event.t !== null)
    .sort((a, b) => a.t - b.t || a.index - b.index);

  ZONE_FIELDS.forEach((field) => {
    let previous: number | null = null;
    sorted.forEach((event) => {
      if (event[field] !== null) previous = event[field];
      else if (previous !== null) event[field] = previous;
    });

    let next: number | null = null;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const event = sorted[index];
      if (event[field] !== null) next = event[field];
      else if (next !== null) event[field] = next;
    }
  });

  return sorted.map((event) => {
    const hasWhitePosition = event.whiteX !== null && event.whiteY !== null;
    const hasBluePosition = event.blueX !== null && event.blueY !== null;
    return {
      t: event.t,
      whiteX: event.whiteX ?? DEFAULT_MAP_CENTER,
      whiteY: event.whiteY ?? DEFAULT_MAP_CENTER,
      whiteRadius: hasWhitePosition ? (event.whiteRadius ?? 0) : 0,
      blueX: event.blueX ?? DEFAULT_MAP_CENTER,
      blueY: event.blueY ?? DEFAULT_MAP_CENTER,
      blueRadius: hasBluePosition ? (event.blueRadius ?? 0) : 0,
    };
  });
}
