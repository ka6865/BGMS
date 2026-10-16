// 2D 리플레이의 인지 범위 표시와 따라가기 자동 줌 규칙.
// 텔레메트리에는 시야·차폐 정보가 없으므로 인지 범위는 거리와 최근 교전으로 추정한다.
import { MAP_SIZES } from "@/lib/pubg-analysis/constants";

/** 리플레이 좌표는 맵 한 변을 8192로 나눈 단위다(MapReplayHandler.scaleX). */
const REPLAY_UNITS = 8192;
/** 따라가는 선수가 이 거리 안의 적은 알 수 있었다고 본다. */
export const VISION_RANGE_M = 150;
/** 이동 속도는 이 시간 동안의 위치 변화로 잰다. */
export const SPEED_WINDOW_MS = 4_000;
/** 자동 줌을 바꾼 뒤 이 시간 동안은 다시 바꾸지 않아 줌이 출렁이지 않게 한다. */
export const AUTO_ZOOM_HOLD_MS = 1_500;
const MIN_AUTO_ZOOM = -3;
const MAX_AUTO_ZOOM = 2;
/** 연속 줌 값이 현재 정수 줌과 이만큼 벌어져야 바꾼다. */
const ZOOM_HYSTERESIS = 0.75;

/** 화면 표시 맵 이름(Erangel, Taego 등)이나 원본 이름(Baltic_Main)으로 좌표 1단위가 몇 m인지 구한다. */
export function metersPerUnit(mapName: string | null | undefined): number {
  const key = String(mapName || "").toLowerCase().split("_")[0];
  const sizeCm = MAP_SIZES[key] ?? MAP_SIZES.erangel;
  return sizeCm / 100 / REPLAY_UNITS;
}

type Point = { x: number; y: number };

export function distanceMeters(a: Point, b: Point, unitMeters: number): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * unitMeters;
}

/** 따라가는 선수가 이 적을 알 수 있었는지. 범위 안이거나 최근 아군과 교전했으면 안다고 본다. */
export function isKnownEnemy(input: {
  followed: Point | null;
  enemy: Point | null;
  enemyName: string;
  recentContacts: ReadonlySet<string>;
  unitMeters: number;
}): boolean {
  if (input.recentContacts.has(input.enemyName.trim().toLowerCase())) return true;
  if (!input.followed || !input.enemy) return true;
  return distanceMeters(input.followed, input.enemy, input.unitMeters) <= VISION_RANGE_M;
}

export function speedMetersPerSecond(now: Point | null, before: Point | null, windowMs: number, unitMeters: number): number {
  if (!now || !before || windowMs <= 0) return 0;
  return distanceMeters(now, before, unitMeters) / (windowMs / 1000);
}

/** 이동 속도에 맞춰 화면 폭에 담을 거리(m). 멈추면 가깝게, 차량으로 달리면 멀리 본다. */
export function viewSpanForSpeed(mps: number): number {
  if (mps < 1.5) return 300;
  if (mps < 8) return 300 + ((mps - 1.5) / 6.5) * 250;
  return Math.min(2000, 550 + ((mps - 8) / 22) * 1450);
}

/** 화면 폭(px)에 viewSpan을 담는 연속 줌 값. CRS.Simple에서 줌 0은 좌표 1단위가 1px이다. */
export function autoZoomFor(mps: number, containerWidthPx: number, unitMeters: number): number {
  const spanUnits = viewSpanForSpeed(mps) / unitMeters;
  const zoom = Math.log2(Math.max(1, containerWidthPx) / spanUnits);
  return Math.min(MAX_AUTO_ZOOM, Math.max(MIN_AUTO_ZOOM, zoom));
}

/** 정수 줌으로 바꿀 값. 차이가 작으면 null로 두어 현재 줌을 유지한다. */
export function nextAutoZoom(currentZoom: number, targetZoom: number): number | null {
  if (Math.abs(targetZoom - currentZoom) < ZOOM_HYSTERESIS) return null;
  const next = Math.round(targetZoom);
  return next === currentZoom ? null : next;
}
