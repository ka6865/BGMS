import { describe, expect, it } from "vitest";
import {
  getActiveDeathTime,
  getReplayMaxTime,
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

    // Plane local -Y becomes world +Z after rotation.x = -PI / 2.
    expect(sampleTerrainHeight(terrain, -50, 50)).toBe(10);
    expect(sampleTerrainHeight(terrain, 50, 50)).toBe(20);
    expect(sampleTerrainHeight(terrain, -50, -50)).toBe(30);
    expect(sampleTerrainHeight(terrain, 50, -50)).toBe(40);
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
