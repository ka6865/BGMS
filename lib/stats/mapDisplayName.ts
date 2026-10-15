import { MAP_NAMES } from "@/lib/pubg-analysis/constants";

// 전적 화면 표시용 데스매치 맵 이름. 분석 계층의 MAP_NAMES는 배틀로얄 맵만 다루므로 여기서만 덧붙인다.
const TDM_MAP_DISPLAY_NAMES: Record<string, string> = {
  PillarCompound_Main: "필라 기지 (TDM)",
  Italy_TDM_Main: "리틀 이탈리아 (TDM)",
};

export function isBattleRoyaleMapName(mapName: string | null | undefined): mapName is string {
  return typeof mapName === "string" && Object.prototype.hasOwnProperty.call(MAP_NAMES, mapName);
}

export function getMapDisplayName(mapName: string | null | undefined): string | null {
  if (!mapName) return null;
  return MAP_NAMES[mapName] ?? TDM_MAP_DISPLAY_NAMES[mapName] ?? mapName;
}
