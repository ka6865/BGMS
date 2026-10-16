// 하이트맵 이미지는 지도 타일과 같이 북쪽이 0행(상단)이다.
// Leaflet CRS.Simple 좌표는 lat 8192가 북쪽이므로 행 방향이 반대다.
const MAP_COORDINATE_MAX = 8192;

const clampIndex = (value: number, size: number): number =>
  Math.max(0, Math.min(size - 1, value));

/** Leaflet 좌표(lat 8192 = 북쪽)를 하이트맵 픽셀 위치로 변환한다. */
export function leafletToHeightmapPixel(
  lat: number,
  lng: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: clampIndex(Math.round((lng / MAP_COORDINATE_MAX) * width), width),
    y: clampIndex(Math.round(((MAP_COORDINATE_MAX - lat) / MAP_COORDINATE_MAX) * height), height),
  };
}

/** Three.js 월드 좌표(-Z = 북쪽)를 하이트맵 픽셀 위치로 변환한다. */
export function threeToHeightmapPixel(
  threeX: number,
  threeZ: number,
  mapSize: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: clampIndex(Math.round(((threeX + mapSize / 2) / mapSize) * width), width),
    y: clampIndex(Math.round(((threeZ + mapSize / 2) / mapSize) * height), height),
  };
}
