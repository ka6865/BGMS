import { describe, expect, it } from "vitest";
import {
  createBuildingIndex,
  findWaypointSegment,
  getActiveDeathTime,
  getHeadingAt,
  interpolateSmooth,
  isGroggyAt,
  joinVehicleCluster,
  lowerBoundByTime,
  type VehicleCluster,
  getReplayMaxTime,
  matchCarePackageLandings,
  normalizeReplayZoneEvents,
  sampleTerrainHeight,
  shouldMarkPlayerDeadFromHealth,
} from "@/lib/replay/replay3dHelpers";

describe("3D replay helpers", () => {
  it("samples terrain rows in the rotated plane's world-Z orientation", () => {
    const terrain = {
      grid: [
        [10, 20],
        [30, 40],
      ],
      size: 2,
    } as const;

    // Grid row 0 is the plane's local +Y edge, which becomes world -Z after rotation.x = -PI / 2.
    expect(sampleTerrainHeight(terrain, -50, -50)).toBe(10);
    expect(sampleTerrainHeight(terrain, 50, -50)).toBe(20);
    expect(sampleTerrainHeight(terrain, -50, 50)).toBe(30);
    expect(sampleTerrainHeight(terrain, 50, 50)).toBe(40);
    expect(sampleTerrainHeight(terrain, 0, 0)).toBe(25);
  });

  it("uses the greatest timestamp even when replay events arrive out of order", () => {
    expect(getReplayMaxTime([{ relativeTimeMs: 120_000 }, { relativeTimeMs: 10_000 }])).toBe(120_000);
    expect(getReplayMaxTime([{ relativeTimeMs: -1 }, { relativeTimeMs: "bad" }])).toBe(300_000);
  });

  it("tracks the death belonging to the currently active life", () => {
    const deaths = [100_000, 300_000];
    const redeploys = [200_000];

    expect(getActiveDeathTime(deaths, redeploys, 150_000)).toBe(100_000);
    expect(getActiveDeathTime(deaths, redeploys, 250_000)).toBeNull();
    expect(getActiveDeathTime(deaths, redeploys, 350_000)).toBe(300_000);
  });

  it("ignores a lagging zero-health sample after a blue-chip redeploy", () => {
    expect(shouldMarkPlayerDeadFromHealth([100_000], [200_000], 250_000, 0, 199_000)).toBe(false);
    expect(shouldMarkPlayerDeadFromHealth([100_000], [200_000], 250_000, 0, 201_000)).toBe(true);
    expect(shouldMarkPlayerDeadFromHealth([], [200_000], 250_000, 0, 199_000)).toBe(false);
    expect(shouldMarkPlayerDeadFromHealth([], [200_000], 250_000, 0, 201_000)).toBe(true);
    expect(shouldMarkPlayerDeadFromHealth([100_000], [200_000], 250_000, 0)).toBe(false);
    expect(shouldMarkPlayerDeadFromHealth([100_000], [200_000], 250_000, 25, 201_000)).toBe(false);
    expect(shouldMarkPlayerDeadFromHealth([], [], 100_000, 0, 101_000)).toBe(false);
  });

  it("sorts zones and keeps missing coordinates inside the map", () => {
    const zones = normalizeReplayZoneEvents([
      { relativeTimeMs: 10_000, whiteX: 2_000, whiteY: 2_100, whiteRadius: 1_000, blueX: 2_000, blueY: 2_100, blueRadius: 1_100 },
      { relativeTimeMs: 0, whiteX: null, whiteY: null, whiteRadius: null, blueX: null, blueY: null, blueRadius: null },
      { relativeTimeMs: 20_000, whiteX: 3_000, whiteY: 3_100, whiteRadius: 800, blueX: 3_000, blueY: 3_100, blueRadius: 900 },
    ]);

    expect(zones.map((zone) => zone.t)).toEqual([0, 10_000, 20_000]);
    expect(zones[0]).toMatchObject({ whiteX: 2_000, whiteY: 2_100, blueX: 2_000, blueY: 2_100 });
    expect(zones.every((zone) => zone.whiteX >= 0 && zone.whiteX <= 8_192)).toBe(true);
    expect(zones.every((zone) => zone.blueX >= 0 && zone.blueX <= 8_192)).toBe(true);
  });

  it("turns the legacy out-of-map sentinel into a safe empty zone", () => {
    const [zone] = normalizeReplayZoneEvents([
      { relativeTimeMs: 0, whiteX: 408_000, whiteY: 408_000, whiteRadius: 408_000, blueX: 408_000, blueY: 408_000, blueRadius: 408_000 },
    ]);

    expect(zone).toEqual({
      t: 0,
      whiteX: 4_096,
      whiteY: 4_096,
      whiteRadius: 0,
      blueX: 4_096,
      blueY: 4_096,
      blueRadius: 0,
    });
  });
});

describe("matchCarePackageLandings", () => {
  it("생성보다 앞선 착륙은 고르지 않는다", () => {
    const spawns = [{ relativeTimeMs: 300_000, x: 100, y: 100 }];
    const lands = [
      { relativeTimeMs: 250_000, x: 100, y: 100 },
      { relativeTimeMs: 340_000, x: 105, y: 102 },
    ];

    expect(matchCarePackageLandings(spawns, lands)).toEqual([lands[1]]);
  });

  it("같은 시간대 여러 상자는 같은 착륙을 나눠 쓰지 않고 가까운 착륙과 연결한다", () => {
    const spawns = [
      { relativeTimeMs: 100_000, x: 1000, y: 1000 },
      { relativeTimeMs: 100_500, x: 3000, y: 3000 },
    ];
    const lands = [
      { relativeTimeMs: 140_000, x: 3010, y: 2995 },
      { relativeTimeMs: 141_000, x: 1002, y: 998 },
    ];

    expect(matchCarePackageLandings(spawns, lands)).toEqual([lands[1], lands[0]]);
  });

  it("120초 안에 남은 착륙이 없으면 null이다", () => {
    const spawns = [
      { relativeTimeMs: 0, x: 0, y: 0 },
      { relativeTimeMs: 1_000, x: 0, y: 0 },
    ];
    const lands = [{ relativeTimeMs: 30_000, x: 0, y: 0 }];

    expect(matchCarePackageLandings(spawns, lands)).toEqual([lands[0], null]);
  });
});

describe("3D replay playback helpers", () => {
  it("finds the waypoint segment by binary search and clamps the edges", () => {
    const points = [{ t: 0 }, { t: 10 }, { t: 20 }, { t: 30 }];
    expect(findWaypointSegment([], 5)).toBe(-1);
    expect(findWaypointSegment(points, -5)).toBe(0);
    expect(findWaypointSegment(points, 10)).toBe(1);
    expect(findWaypointSegment(points, 19.9)).toBe(1);
    expect(findWaypointSegment(points, 99)).toBe(3);
  });

  it("keeps a player knocked only until revive, death or redeploy", () => {
    expect(isGroggyAt([], [], 100)).toBe(false);
    expect(isGroggyAt([100], [], 99)).toBe(false);
    expect(isGroggyAt([100], [], 150)).toBe(true);
    expect(isGroggyAt([100], [140], 150)).toBe(false);
    // 이전 기절의 부활 기록은 새 기절을 풀지 않는다.
    expect(isGroggyAt([100, 200], [140], 250)).toBe(true);
  });

  it("turns movement into a +Z based Y rotation and ignores standing still", () => {
    const points = [{ t: 0, x: 0, y: 0 }, { t: 10, x: 0, y: 5 }, { t: 20, x: 5, y: 5 }, { t: 30, x: 5, y: 5 }];
    expect(getHeadingAt([{ t: 0, x: 0, y: 0 }], 0)).toBeNull();
    expect(getHeadingAt(points, 5)).toBeCloseTo(0);
    expect(getHeadingAt(points, 15)).toBeCloseTo(Math.PI / 2);
    expect(getHeadingAt(points, 99)).toBeNull();
  });

  it("keeps riders in one vehicle across drift but splits distant or different vehicles", () => {
    const clusters: VehicleCluster[] = [];
    const driver = joinVehicleCluster(clusters, { name: "A", vehicleId: "Dacia", x: 10, z: 10 });
    expect(driver.seat).toBe(0);
    // 이력이 있으면 약 100m 벌어져도 같은 차량이다.
    expect(joinVehicleCluster(clusters, { name: "B", vehicleId: "Dacia", x: 11.2, z: 10, previousAnchor: "A" }).seat).toBe(1);
    // 이력이 없으면 같은 거리는 다른 차량이다.
    expect(joinVehicleCluster(clusters, { name: "C", vehicleId: "Dacia", x: 11.2, z: 10 }).cluster.anchor).toBe("C");
    // 가까워도 차종이 다르면 다른 차량이다.
    expect(joinVehicleCluster(clusters, { name: "D", vehicleId: "UAZ", x: 10, z: 10 }).cluster.anchor).toBe("D");
    expect(joinVehicleCluster(clusters, { name: "E", vehicleId: "Dacia", x: 10.3, z: 10 }).cluster.anchor).toBe("A");
  });

  it("finds the first item at or after a time", () => {
    const items = [{ t: 0 }, { t: 10 }, { t: 10 }, { t: 30 }];
    expect(lowerBoundByTime(items, 10, (item) => item.t)).toBe(1);
    expect(lowerBoundByTime(items, 11, (item) => item.t)).toBe(3);
    expect(lowerBoundByTime(items, 99, (item) => item.t)).toBe(4);
  });

  it("smooths movement through samples without overshooting turns or teleports", () => {
    const at = (t: number, x: number, y = 0) => ({ t, x, y, z: 0 });
    // 끝점은 표본 위치와 같다.
    const straight = [at(0, 0), at(10, 10), at(20, 20), at(30, 30)];
    expect(interpolateSmooth(straight, 1, 10, 100, 10).x).toBeCloseTo(10);
    expect(interpolateSmooth(straight, 1, 15, 100, 10).x).toBeCloseTo(15);
    // 되돌아가는 표본에서는 접선이 0이라 구간 밖(10 초과)으로 튀지 않는다.
    const turn = [at(0, 0), at(10, 10), at(20, 0)];
    const mid = interpolateSmooth(turn, 0, 9, 100, 10).x;
    expect(mid).toBeLessThanOrEqual(10);
    expect(mid).toBeGreaterThan(9);
    // 너무 빠른 이웃 구간(순간이동)은 접선에서 빠져 직선 보간과 같다.
    const teleport = [at(0, -5000), at(10, 0), at(20, 10), at(30, 20)];
    expect(interpolateSmooth(teleport, 1, 15, 100, 10).x).toBeCloseTo(5);
  });

  it("finds whether a map point is inside a rotated building rectangle", () => {
    const isInside = createBuildingIndex([
      [100, 100, 40, 10, 0, 6],
      // 45도 회전한 정사각형은 꼭짓점 방향으로 더 멀리 닿는다.
      [600, 600, 20, 20, 45, 9],
    ]);
    expect(isInside(115, 100)).toBe(true);
    expect(isInside(100, 110)).toBe(false);
    expect(isInside(600, 613)).toBe(true);
    expect(isInside(613, 613)).toBe(false);
    expect(isInside(4000, 4000)).toBe(false);
  });

  it("groups riders by vehicle instance ID before distance", () => {
    const clusters: VehicleCluster[] = [];
    joinVehicleCluster(clusters, { name: "A", vehicleId: "Dacia", uniqueId: "v1", x: 10, z: 10 });
    // 같은 차종이 가까이 있어도 고유 ID가 다르면 다른 차량이다.
    expect(joinVehicleCluster(clusters, { name: "B", vehicleId: "Dacia", uniqueId: "v2", x: 10.3, z: 10 }).cluster.anchor).toBe("B");
    // 같은 고유 ID면 보간 위치가 멀어도 같은 차량이다.
    expect(joinVehicleCluster(clusters, { name: "C", vehicleId: "Dacia", uniqueId: "v1", x: 13, z: 10 }).cluster.anchor).toBe("A");
  });

  it("does not merge different instance IDs through a cluster started without an ID", () => {
    const clusters: VehicleCluster[] = [];
    joinVehicleCluster(clusters, { name: "A", vehicleId: "Dacia", x: 10, z: 10 });
    expect(joinVehicleCluster(clusters, { name: "B", vehicleId: "Dacia", uniqueId: "v1", x: 10.1, z: 10 }).cluster.anchor).toBe("A");
    expect(joinVehicleCluster(clusters, { name: "C", vehicleId: "Dacia", uniqueId: "v2", x: 10.2, z: 10 }).cluster.anchor).toBe("C");
  });
});
