// 내가 기절하거나 사망한 순간에 가장 가까운 생존 팀원이 얼마나 떨어져 있었는지 재는 순수 함수.
// 경기 평균 간격(고립 지수)과 달리 사건 시점 값이다. 팀원 위치는 선수별 약 10초 간격 샘플이라 샘플이 오래되면 거리를 만들지 않는다.
import { calcDist3D } from "./utils";
import type { DeathContextSample, Location } from "./types";

// 위치 샘플 간격(약 10초)에 여유를 둔 상한. 이보다 오래된 팀원 위치는 사건 시점 위치로 보지 않는다.
export const DEATH_CONTEXT_MAX_LOCATION_AGE_MS = 15_000;
// 이 거리(m) 이상 떨어져 있으면 멀리 떨어진 것으로 센다. 원인 장면의 거리 기준과 같은 값을 쓴다.
export const TEAMMATE_FAR_DISTANCE_M = 80;

export interface ProximityTeammate {
  /** 기절·사망하지 않고 서 있는 팀원. */
  alive: boolean;
  location: Location | null;
  /** 위치 샘플의 텔레메트리 시각(ms). 모르면 null. */
  locationTs: number | null;
}

/**
 * 생존 팀원이 없으면 가까운 팀원은 null이고 aliveTeammateCount는 0이다(마지막 생존자이지 떨어져 있던 것이 아니다).
 * 생존 팀원이 있어도 쓸 수 있는 위치 샘플이 없으면 거리는 null이다.
 */
export function measureTeammateProximity(input: {
  me: Location | null;
  ts: number;
  teammates: ReadonlyArray<ProximityTeammate>;
}): Omit<DeathContextSample, "atMs"> {
  const alive = input.teammates.filter(teammate => teammate.alive);
  if (!input.me || alive.length === 0) {
    return { nearestAliveTeammateM: null, aliveTeammateCount: alive.length, locationAgeMs: null };
  }
  let nearest: { distanceM: number; ageMs: number } | null = null;
  for (const teammate of alive) {
    if (!teammate.location || teammate.locationTs === null) continue;
    const ageMs = input.ts - teammate.locationTs;
    if (ageMs < 0 || ageMs > DEATH_CONTEXT_MAX_LOCATION_AGE_MS) continue;
    const distanceM = calcDist3D(input.me, teammate.location) / 100;
    if (!Number.isFinite(distanceM)) continue;
    if (!nearest || distanceM < nearest.distanceM) nearest = { distanceM, ageMs };
  }
  return {
    nearestAliveTeammateM: nearest ? Math.round(nearest.distanceM * 10) / 10 : null,
    aliveTeammateCount: alive.length,
    locationAgeMs: nearest ? nearest.ageMs : null,
  };
}
