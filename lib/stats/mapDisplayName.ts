import { MAP_NAMES } from "@/lib/pubg-analysis/constants";

// 전적 화면 표시용 데스매치 맵 이름. 분석 계층의 MAP_NAMES는 배틀로얄 맵만 다루므로 여기서만 덧붙인다.
const TDM_MAP_DISPLAY_NAMES: Record<string, string> = {
  PillarCompound_Main: "필라 기지 (TDM)",
  Italy_TDM_Main: "리틀 이탈리아 (TDM)",
};

// 분석 결과(fullResult.mapName)는 저장 시점에 한글 표시명으로 바뀐다(AnalysisEngine). 같은 맵을 맵 ID와
// 표시명 어느 쪽으로 받아도 맵 ID로 되돌린다. 같은 표시명을 쓰는 ID가 여럿이면(Baltic_Main·Erangel_Main)
// 첫 ID를 쓴다. 배틀로얄 맵이 아니면 null이다.
export function toBattleRoyaleMapId(mapName: string | null | undefined): string | null {
  if (typeof mapName !== "string" || !mapName) return null;
  if (Object.prototype.hasOwnProperty.call(MAP_NAMES, mapName)) return mapName;
  return Object.keys(MAP_NAMES).find((mapId) => MAP_NAMES[mapId] === mapName) ?? null;
}

export function isBattleRoyaleMapName(mapName: string | null | undefined): mapName is string {
  return toBattleRoyaleMapId(mapName) !== null;
}

export function getMapDisplayName(mapName: string | null | undefined): string | null {
  if (!mapName) return null;
  return MAP_NAMES[mapName] ?? TDM_MAP_DISPLAY_NAMES[mapName] ?? mapName;
}
