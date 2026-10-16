import { describe, expect, it } from "vitest";
import { leafletToHeightmapPixel, threeToHeightmapPixel } from "@/lib/heightmapCoords";

describe("heightmap coordinates", () => {
  it("maps Leaflet north (lat 8192) to the top image row", () => {
    expect(leafletToHeightmapPixel(8192, 0, 8192, 8192)).toEqual({ x: 0, y: 0 });
    expect(leafletToHeightmapPixel(0, 8192, 8192, 8192)).toEqual({ x: 8191, y: 8191 });
    expect(leafletToHeightmapPixel(6144, 2048, 4096, 4096)).toEqual({ x: 1024, y: 1024 });
  });

  it("maps Three.js world -Z (north) to the top image row", () => {
    expect(threeToHeightmapPixel(-50, -50, 100, 8192, 8192)).toEqual({ x: 0, y: 0 });
    expect(threeToHeightmapPixel(50, 50, 100, 8192, 8192)).toEqual({ x: 8191, y: 8191 });
    expect(threeToHeightmapPixel(-25, -25, 100, 4096, 4096)).toEqual({ x: 1024, y: 1024 });
  });

  it("reads the same pixel for the same map point in 2D and 3D", () => {
    // 3D 변환식(convertTo3D)은 게임 y=0(북쪽)을 threeZ=-50으로 둔다.
    const gameX = 1500;
    const gameY = 2000;
    const lat = 8192 - gameY;
    const threeX = (gameX / 8192) * 100 - 50;
    const threeZ = (gameY / 8192) * 100 - 50;

    expect(threeToHeightmapPixel(threeX, threeZ, 100, 8192, 8192)).toEqual(
      leafletToHeightmapPixel(lat, gameX, 8192, 8192),
    );
  });

  it("clamps points outside the map to the image edge", () => {
    expect(leafletToHeightmapPixel(9000, -10, 100, 100)).toEqual({ x: 0, y: 0 });
    expect(threeToHeightmapPixel(80, 80, 100, 100, 100)).toEqual({ x: 99, y: 99 });
  });
});
