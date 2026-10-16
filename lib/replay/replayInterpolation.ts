// 2D·3D 리플레이가 함께 쓰는 위치·체력 조회 규칙.
// 위치는 두 관측 사이를 선형 보간하되 긴 공백(재배치 등)은 잇지 않고, 체력은 보간하지 않고 마지막 관측값을 쓴다.
import { MAX_POSITION_INTERPOLATION_GAP_MS } from "@/lib/pubg-analysis/telemetryContract";

export type PositionSample = { t: number; x: number; y: number; z?: number; health?: number };

type PositionEvent = { type?: unknown; name?: unknown; relativeTimeMs?: unknown; x?: unknown; y?: unknown; z?: unknown; health?: unknown };

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function toSample(event: PositionEvent): PositionSample | null {
  if (!isFiniteNumber(event.relativeTimeMs) || !isFiniteNumber(event.x) || !isFiniteNumber(event.y)) return null;
  const sample: PositionSample = { t: event.relativeTimeMs, x: event.x, y: event.y };
  if (isFiniteNumber(event.z)) sample.z = event.z;
  if (isFiniteNumber(event.health)) sample.health = event.health;
  return sample;
}

/** 한 선수의 위치 이벤트 배열을 시간순 표본으로 바꾼다. */
export function toPositionTrack(events: readonly PositionEvent[]): PositionSample[] {
  return events
    .map(toSample)
    .filter((sample): sample is PositionSample => sample !== null)
    .sort((a, b) => a.t - b.t);
}

/** 위치 이벤트를 선수 이름(소문자)별 시간순 표본으로 묶는다. */
export function buildPositionTracks(events: readonly unknown[]): Map<string, PositionSample[]> {
  const tracks = new Map<string, PositionSample[]>();
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as PositionEvent;
    if (event.type !== "position" || typeof event.name !== "string") continue;
    const sample = toSample(event);
    if (!sample) continue;
    const key = event.name.trim().toLowerCase();
    const track = tracks.get(key);
    if (track) track.push(sample);
    else tracks.set(key, [sample]);
  }
  tracks.forEach((track) => track.sort((a, b) => a.t - b.t));
  return tracks;
}

/** timeMs 이하인 마지막 표본의 위치. 없으면 -1. */
function lastIndexAtOrBefore(track: readonly PositionSample[], timeMs: number): number {
  let low = 0;
  let high = track.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (track[mid].t <= timeMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * timeMs의 위치. 첫 표본 이전은 첫 위치, 마지막 이후는 마지막 위치를 쓴다.
 * 두 표본 간격이 gapLimitMs를 넘으면 순간이동으로 보고 이전 위치에 머문다.
 */
export function samplePosition(
  track: readonly PositionSample[] | undefined,
  timeMs: number,
  gapLimitMs = MAX_POSITION_INTERPOLATION_GAP_MS,
): { x: number; y: number; z?: number } | null {
  if (!track || track.length === 0) return null;
  const index = lastIndexAtOrBefore(track, timeMs);
  if (index < 0) return { x: track[0].x, y: track[0].y, z: track[0].z };
  const previous = track[index];
  const next = track[index + 1];
  if (!next || next.t === previous.t || next.t - previous.t > gapLimitMs) {
    return { x: previous.x, y: previous.y, z: previous.z };
  }
  const ratio = (timeMs - previous.t) / (next.t - previous.t);
  const z = isFiniteNumber(previous.z) && isFiniteNumber(next.z) ? previous.z + (next.z - previous.z) * ratio : previous.z;
  return {
    x: previous.x + (next.x - previous.x) * ratio,
    y: previous.y + (next.y - previous.y) * ratio,
    z,
  };
}

/** timeMs 시점까지 마지막으로 관측된 체력. 체력 값이 없으면 null. */
export function sampleHealth(track: readonly PositionSample[] | undefined, timeMs: number): number | null {
  if (!track || track.length === 0) return null;
  const index = Math.max(0, lastIndexAtOrBefore(track, timeMs));
  for (let i = index; i >= 0; i--) {
    if (isFiniteNumber(track[i].health)) return track[i].health as number;
  }
  return null;
}

/**
 * 경기 시작 뒤 위치 기록이 있는 실제 참가자 이름(소문자). 대기실에서 나간 선수나
 * 분석기가 만든 가상 이름("Unknown", "환경/자연사" 등)은 위치가 없어 빠진다.
 */
export function collectMatchPlayerNames(events: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  buildPositionTracks(events).forEach((track, name) => {
    if (track.some((sample) => sample.t >= 0)) names.add(name);
  });
  return names;
}
