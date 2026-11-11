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
 * Grid row 0 is the plane's local +Y edge, which becomes world -Z (north)
 * after rotation.x = -PI / 2.
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
  // World -Z (north) is grid row 0; world +Z is the last row.
  const percentZ = clamp01((threeZ + mapSize / 2) / mapSize);
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

export type CarePackagePoint = {
  relativeTimeMs: number;
  x: number;
  y: number;
};

/** 보급 상자 생성 뒤 이 시간 안의 착륙만 같은 상자로 본다. */
export const CARE_PACKAGE_LANDING_WINDOW_MS = 120_000;

/**
 * 보급 상자 생성마다 착륙 이벤트를 하나씩 연결한다. 텔레메트리에 상자 식별자가 없으므로
 * 생성 이후(이전 착륙은 제외) 120초 안의 아직 쓰지 않은 착륙 중 평면 거리가 가장 가까운 것을 고른다.
 * 결과는 spawns와 같은 순서이며, 맞는 착륙이 없으면 null이다.
 */
export function matchCarePackageLandings<S extends CarePackagePoint, L extends CarePackagePoint>(
  spawns: readonly S[],
  lands: readonly L[],
): (L | null)[] {
  const matched: (L | null)[] = spawns.map(() => null);
  const used = new Set<number>();
  const spawnOrder = spawns.map((_, index) => index).sort((a, b) => spawns[a].relativeTimeMs - spawns[b].relativeTimeMs);
  for (const spawnIndex of spawnOrder) {
    const spawn = spawns[spawnIndex];
    let bestIndex = -1;
    let bestDistance = Infinity;
    lands.forEach((land, landIndex) => {
      if (used.has(landIndex)) return;
      const delay = land.relativeTimeMs - spawn.relativeTimeMs;
      if (delay < 0 || delay >= CARE_PACKAGE_LANDING_WINDOW_MS) return;
      const distance = Math.hypot(land.x - spawn.x, land.y - spawn.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = landIndex;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matched[spawnIndex] = lands[bestIndex];
    }
  }
  return matched;
}

/**
 * 시간순 정렬된 위치 표본에서 time이 속한 구간의 시작 인덱스를 이분 탐색으로 찾는다.
 * 첫 표본 이전이면 0, 마지막 표본 이후면 마지막 인덱스를 돌려준다. 표본이 없으면 -1이다.
 */
export function findWaypointSegment(points: readonly { t: number }[], time: number): number {
  if (points.length === 0) return -1;
  if (time <= points[0].t) return 0;
  const last = points.length - 1;
  if (time >= points[last].t) return last;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (points[mid].t <= time) low = mid;
    else high = mid;
  }
  return low;
}

/** 마지막 기절 이후 현재까지 부활·사망·블루칩 재배치가 없으면 기절 상태로 본다. */
export function isGroggyAt(
  groggyTimes: readonly number[],
  endTimes: readonly number[],
  currentTimeMs: number,
): boolean {
  const lastGroggy = latestPastTime(groggyTimes, currentTimeMs);
  if (lastGroggy === null) return false;
  return !endTimes.some((time) => time >= lastGroggy && time <= currentTimeMs);
}

/**
 * time이 속한 위치 구간의 이동 방향을 Three.js Y축 회전각으로 돌려준다(+Z가 0).
 * 마지막 표본 이후에는 직전 구간을 쓰고, 움직임이 없으면 null이다.
 */
export function getHeadingAt(points: readonly { t: number; x: number; y: number }[], time: number): number | null {
  if (points.length < 2) return null;
  const index = Math.min(findWaypointSegment(points, time), points.length - 2);
  const dx = points[index + 1].x - points[index].x;
  const dy = points[index + 1].y - points[index].y;
  return dx === 0 && dy === 0 ? null : Math.atan2(dx, dy);
}

export type VehicleCluster = { anchor: string; vehicleId: string; uniqueId: string | null; x: number; z: number; riders: number };

/** 직전 프레임에 같은 차량이던 탑승자는 이 거리(Three 단위, 약 130m) 안이면 계속 같은 차량으로 둔다. */
export const VEHICLE_KEEP_DISTANCE = 1.6;
/** 새로 묶을 때는 이 거리(약 65m) 안의 같은 차종만 같은 차량으로 본다. */
export const VEHICLE_JOIN_DISTANCE = 0.8;

/**
 * 차량 고유 ID가 있으면 그것으로 묶는다. 없으면(이전 텔레메트리) 탑승자마다 기록 시각이 어긋나 보간 위치가
 * 수십 m 벌어지므로, 같은 차종 안에서 거리와 직전 묶음(이력)으로 고른다. 고정 격자로 묶으면 경계에서 한 대·두 대가 번갈아 바뀐다.
 * 고유 ID가 서로 다르면 가까워도 다른 차량이다.
 * 처음 타는 사람이 차량 기준(anchor)이 되고, 돌려준 riders 순번이 0이면 기준 탑승자다.
 */
export function joinVehicleCluster(
  clusters: VehicleCluster[],
  rider: { name: string; vehicleId: string; uniqueId?: string | null; x: number; z: number; previousAnchor?: string },
): { cluster: VehicleCluster; seat: number } {
  const distance = (cluster: VehicleCluster) => Math.hypot(cluster.x - rider.x, cluster.z - rider.z);
  const uniqueId = rider.uniqueId || null;
  const sameType = (cluster: VehicleCluster) => cluster.vehicleId === rider.vehicleId
    && !(cluster.uniqueId && uniqueId && cluster.uniqueId !== uniqueId);
  let cluster = (uniqueId ? clusters.find((c) => c.uniqueId === uniqueId) : undefined)
    ?? clusters.find((c) => c.anchor === rider.previousAnchor && sameType(c) && distance(c) <= VEHICLE_KEEP_DISTANCE)
    ?? clusters.find((c) => sameType(c) && distance(c) <= VEHICLE_JOIN_DISTANCE);
  if (!cluster) {
    cluster = { anchor: rider.name, vehicleId: rider.vehicleId, uniqueId, x: rider.x, z: rider.z, riders: 0 };
    clusters.push(cluster);
  }
  // ID 없는 탑승자가 만든 묶음은 처음 들어온 고유 ID로 정해, 다른 ID의 차량이 섞이지 않게 한다.
  if (!cluster.uniqueId && uniqueId) cluster.uniqueId = uniqueId;
  return { cluster, seat: cluster.riders++ };
}

/** 시간순 정렬 목록에서 시각이 time 이상인 첫 인덱스. 없으면 길이를 돌려준다. */
export function lowerBoundByTime<T>(items: readonly T[], time: number, getTime: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (getTime(items[mid]) < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

type TimedPoint = { t: number; x: number; y: number; z: number };
type Axis = "x" | "y" | "z";

/**
 * 위치 구간 [index, index + 1]을 단조 3차 Hermite로 보간한다.
 * 접선은 앞뒤 구간 기울기의 조화평균이고, 방향이 바뀌는 표본에서는 0이라 표본 밖으로 튀지 않는다.
 * 시간 공백이 maxGapMs를 넘거나 maxUnitsPerMs보다 빠른(순간이동·탑승) 이웃 구간은 접선 계산에서 뺀다.
 * 관측 사이를 매끄럽게 보여 주는 용도이며 실제 경로를 복원하지 않는다.
 */
export function interpolateSmooth(
  points: readonly TimedPoint[],
  index: number,
  time: number,
  maxGapMs: number,
  maxUnitsPerMs: number,
): { x: number; y: number; z: number } {
  const p1 = points[index];
  const p2 = points[index + 1];
  const h = p2.t - p1.t;
  const s = h > 0 ? Math.max(0, Math.min(1, (time - p1.t) / h)) : 0;
  const isLinked = (a: number, b: number) => {
    if (a < 0 || b >= points.length) return false;
    const dt = points[b].t - points[a].t;
    if (dt <= 0 || dt > maxGapMs) return false;
    return Math.hypot(points[b].x - points[a].x, points[b].y - points[a].y) / dt <= maxUnitsPerMs;
  };
  const slope = (a: number, b: number, axis: Axis) =>
    (points[b][axis] - points[a][axis]) / (points[b].t - points[a].t);
  const tangent = (k: number, axis: Axis) => {
    const left = isLinked(k - 1, k) ? slope(k - 1, k, axis) : null;
    const right = isLinked(k, k + 1) ? slope(k, k + 1, axis) : null;
    if (left === null) return right ?? 0;
    if (right === null) return left;
    return left * right <= 0 ? 0 : (2 * left * right) / (left + right);
  };
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  const value = (axis: Axis) =>
    h00 * p1[axis] + h10 * h * tangent(index, axis) + h01 * p2[axis] + h11 * h * tangent(index + 1, axis);
  return { x: value("x"), y: value("y"), z: value("z") };
}

/** 건물 사각형 [중심 x, 중심 y, 폭, 길이, 회전각(도), 높이 m] (맵 8192 좌표, 이미지처럼 y가 아래). */
export type BuildingRect = readonly number[];
const BUILDING_INDEX_CELL = 256;

/**
 * 맵 좌표가 건물 사각형 안인지 빠르게 묻는 함수를 만든다. 칸(256 단위)별로 건물을 나눠 둔다.
 * 회전각은 폭 방향 축이 (cos, sin)을 향하는 이미지 좌표 기준이다.
 */
export function createBuildingIndex(buildings: readonly BuildingRect[]): (x: number, y: number) => boolean {
  const cells = new Map<number, BuildingRect[]>();
  const key = (column: number, row: number) => column * 4096 + row;
  buildings.forEach((building) => {
    const [x, y, width, length] = building;
    const reach = Math.hypot(width, length) / 2;
    for (let column = Math.floor((x - reach) / BUILDING_INDEX_CELL); column <= Math.floor((x + reach) / BUILDING_INDEX_CELL); column++) {
      for (let row = Math.floor((y - reach) / BUILDING_INDEX_CELL); row <= Math.floor((y + reach) / BUILDING_INDEX_CELL); row++) {
        const list = cells.get(key(column, row));
        if (list) list.push(building);
        else cells.set(key(column, row), [building]);
      }
    }
  });
  return (px, py) => {
    const list = cells.get(key(Math.floor(px / BUILDING_INDEX_CELL), Math.floor(py / BUILDING_INDEX_CELL)));
    if (!list) return false;
    return list.some(([x, y, width, length, angleDeg]) => {
      const angle = (angleDeg * Math.PI) / 180;
      const dx = px - x;
      const dy = py - y;
      const along = dx * Math.cos(angle) + dy * Math.sin(angle);
      const across = -dx * Math.sin(angle) + dy * Math.cos(angle);
      return Math.abs(along) <= width / 2 && Math.abs(across) <= length / 2;
    });
  };
}
