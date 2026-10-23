export interface Waypoint {
  t: number;
  x: number;
  y: number;
  z: number;
  vehicleId?: string | null;
  // 같은 차종 여러 대를 구분하는 차량 인스턴스 ID.
  vehicleUniqueId?: string | null;
  health?: number;
}

export interface PlayerTrajectory {
  name: string;
  color: string;
  waypoints: Waypoint[];
  isTeam?: boolean;
  teamId?: number;
  deathTimeMs?: number | null;
  deathTimes?: number[];
  redeployTimes?: number[];
}

export interface ZoneState {
  t: number;
  whiteX: number;
  whiteY: number;
  whiteRadius: number;
  blueX: number;
  blueY: number;
  blueRadius: number;
}

export interface TimelineMarker {
  type: string;
  relativeTimeMs: number;
  attackerName?: string;
  attacker?: string;
  victim?: string;
}
