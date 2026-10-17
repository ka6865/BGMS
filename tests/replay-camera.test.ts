import { describe, expect, it } from "vitest";
import {
  VISION_RANGE_M,
  autoZoomFor,
  isKnownEnemy,
  isZoomKey,
  metersPerUnit,
  nextAutoZoom,
  speedMetersPerSecond,
  viewSpanForSpeed,
} from "@/lib/replay/replayCamera";

describe("리플레이 좌표 단위", () => {
  it("맵 크기에 따라 좌표 1단위의 거리(m)를 구한다", () => {
    expect(metersPerUnit("Erangel")).toBe(1);
    expect(metersPerUnit("Baltic_Main")).toBe(1);
    expect(metersPerUnit("Sanhok")).toBe(0.5);
    expect(metersPerUnit("Karakin")).toBe(0.25);
    expect(metersPerUnit(undefined)).toBe(1);
  });
});

describe("인지 범위", () => {
  const base = { followed: { x: 0, y: 0 }, recentContacts: new Set<string>(), unitMeters: 1 };
  it("150m 안의 적은 안다고 보고, 밖의 적은 모른다고 본다", () => {
    expect(isKnownEnemy({ ...base, enemy: { x: VISION_RANGE_M, y: 0 }, enemyName: "A" })).toBe(true);
    expect(isKnownEnemy({ ...base, enemy: { x: 151, y: 0 }, enemyName: "A" })).toBe(false);
  });
  it("멀어도 최근 아군과 교전한 적은 안다고 본다", () => {
    expect(isKnownEnemy({ ...base, enemy: { x: 900, y: 0 }, enemyName: " Sniper ", recentContacts: new Set(["sniper"]) })).toBe(true);
  });
  it("맵이 작으면 같은 좌표 거리도 더 가깝다", () => {
    expect(isKnownEnemy({ ...base, unitMeters: 0.5, enemy: { x: 250, y: 0 }, enemyName: "A" })).toBe(true);
  });
  it("위치를 모르면 흐리게 만들지 않는다", () => {
    expect(isKnownEnemy({ ...base, followed: null, enemy: { x: 900, y: 0 }, enemyName: "A" })).toBe(true);
  });
});

describe("자동 줌", () => {
  it("이동 속도를 m/s로 잰다", () => {
    expect(speedMetersPerSecond({ x: 40, y: 0 }, { x: 0, y: 0 }, 4_000, 1)).toBe(10);
    expect(speedMetersPerSecond(null, { x: 0, y: 0 }, 4_000, 1)).toBe(0);
  });
  it("멈추면 가깝게, 빠를수록 멀리 본다", () => {
    expect(viewSpanForSpeed(0)).toBe(300);
    expect(viewSpanForSpeed(5)).toBeGreaterThan(300);
    expect(viewSpanForSpeed(20)).toBeGreaterThan(viewSpanForSpeed(8));
    expect(viewSpanForSpeed(100)).toBe(2000);
  });
  it("화면 폭에 거리를 담는 줌을 계산하고 범위 안으로 자른다", () => {
    expect(autoZoomFor(0, 1200, 1)).toBeCloseTo(2);
    expect(autoZoomFor(30, 1000, 1)).toBeCloseTo(Math.log2(1000 / 2000));
    expect(autoZoomFor(30, 100, 1)).toBe(-3);
  });
  it("차이가 작으면 줌을 바꾸지 않는다", () => {
    expect(nextAutoZoom(0, 0.5)).toBeNull();
    expect(nextAutoZoom(0, -1.2)).toBe(-1);
    expect(nextAutoZoom(-1, 1.6)).toBe(2);
  });
});

describe("직접 줌 키", () => {
  it("Leaflet 키보드 줌 키만 직접 줌으로 본다", () => {
    for (const key of ["+", "-", "=", "_", "Add", "Subtract"]) expect(isZoomKey(key)).toBe(true);
    for (const key of ["a", " ", "ArrowLeft", "Enter"]) expect(isZoomKey(key)).toBe(false);
  });
});
