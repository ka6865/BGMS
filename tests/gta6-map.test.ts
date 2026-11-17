import { describe, expect, it } from "vitest";
import raw from "@/public/gta6/landmarks.json";
import manifest from "@/public/gta6/manifest.json";
import { readdirSync, existsSync } from "node:fs";
import { filterLandmarks, MAP_BOUNDS, parseLandmarks, parseProgress, tileCropRight, TILE_BOUNDS, worldToMap } from "@/lib/gta6/map";

describe("GTA6 지도 데이터", () => {
  it("고정 원본의 좌표 있는 장소만 불러오고 한국어·영어·ID로 검색한다", () => {
    const places = parseLandmarks(raw);
    expect(places).toHaveLength(manifest.locatedCount);
    expect(filterLandmarks(places, "도미니언", "all").map(p => p.id)).toContain("L25");
    expect(filterLandmarks(places, "dominion", "all").map(p => p.id)).toContain("L25");
    expect(filterLandmarks(places, "L25", "hotel").map(p => p.id)).toContain("L25");
    expect(filterLandmarks(places, "바이스 비치", "all").length).toBeGreaterThan(0);
    expect(filterLandmarks(places, "dominion", "natural")).toEqual([]);
    expect(places.find(p => p.id === "L1")?.name).not.toContain("Ritz");
  });

  it("잘못된 JSON·좌표·태그를 거부하고 좌표가 없는 행은 제외한다", () => {
    for (const data of [null, [], { L1: [] }, { L1: ["이름", [NaN, 0], [], "", [], [], []] },
      { L1: ["이름", [0, 0], [], "", [], [], [42]] }]) {
      expect(() => parseLandmarks(data)).toThrow();
    }
    expect(parseLandmarks({ L1: ["이름", [], [], "", [], [], []] })).toEqual([]);
  });

  it("게임 원점과 북쪽 방향을 원본 타일 픽셀에 맞춘다", () => {
    expect(worldToMap([0, 0])).toEqual([-16384, 16384]);
    expect(worldToMap([256, 256])).toEqual([-16128, 16640]);
    const [lat, lng] = worldToMap([2008, 912]);
    expect([Math.floor(-lat / 256), Math.floor(lng / 256)]).toEqual([60, 71]);
    expect(existsSync("public/gta6/tiles/yanis-17/5/5,60,71.jpg")).toBe(true);
  });

  it("지도 경계는 실제 파일의 y행·x열 전체를 포함한다", () => {
    const coordinates = readdirSync("public/gta6/tiles/yanis-17/5").map(file => file.replace(".jpg", "").split(",").map(Number));
    const rows = coordinates.map(c => c[1]);
    const columns = coordinates.map(c => c[2]);
    expect(TILE_BOUNDS).toEqual([
      [-(Math.max(...rows) + 1) * 256, Math.min(...columns) * 256],
      [-Math.min(...rows) * 256, (Math.max(...columns) + 1) * 256],
    ]);
  });

  it("오른쪽 설명판을 모든 줌에서 잘라내되 장소 좌표는 모두 남긴다", () => {
    const east = worldToMap([3500, 0])[1];
    expect(MAP_BOUNDS[1][1]).toBe(east);
    expect(parseLandmarks(raw).every(place => worldToMap(place.coordinates)[1] < east)).toBe(true);
    for (let z = -5; z <= 0; z++) {
      const edge = east * 2 ** z;
      const column = Math.floor(edge / 256);
      expect(column * 256 + 256 - tileCropRight(column, z)).toBeCloseTo(edge);
      expect(tileCropRight(column - 1, z)).toBe(0);
      expect(tileCropRight(column + 1, z)).toBe(256);
    }
  });

  it("방향만 붙은 미확인 이름을 실제 장소 이름처럼 노출하지 않는다", () => {
    expect(parseLandmarks({ L1: ["? (E), Vice City", [0, 0], [], "Real Hotel", [], [], ["hotel"]] })[0].name)
      .toBe("이름 미확인 · 호텔");
  });

  it("로컬 진행도는 버전을 검사하고 손상된 ID와 중복을 제거한다", () => {
    expect(parseProgress(null)).toEqual({ version: 1, favorites: [], visited: [] });
    expect(parseProgress('{"version":99}')).toEqual({ version: 1, favorites: [], visited: [] });
    expect(parseProgress("잘못된 JSON")).toEqual({ version: 1, favorites: [], visited: [] });
    expect(parseProgress(JSON.stringify({ version: 1, favorites: ["L25", "L25", "../x", 25], visited: ["L1"] })))
      .toEqual({ version: 1, favorites: ["L25"], visited: ["L1"] });
  });
});
