export const SUPPORTED_3D_MAP_IDS = [
  "Erangel",
  "Miramar",
  "Vikendi",
  "Taego",
  "Deston",
  "Rondo",
] as const;

export type Supported3DMapId = (typeof SUPPORTED_3D_MAP_IDS)[number];

export type Replay3DMapCapability = {
  id: Supported3DMapId;
  displayName: string;
};

const capabilities: Record<Supported3DMapId, Replay3DMapCapability> = {
  Erangel: { id: "Erangel", displayName: "에란겔" },
  Miramar: { id: "Miramar", displayName: "미라마" },
  Vikendi: { id: "Vikendi", displayName: "비켄디" },
  Taego: { id: "Taego", displayName: "태이고" },
  Deston: { id: "Deston", displayName: "데스턴" },
  Rondo: { id: "Rondo", displayName: "론도" },
};

const aliases: Record<string, Supported3DMapId> = {
  "에란겔": "Erangel",
  "미라마": "Miramar",
  "비켄디": "Vikendi",
  "태이고": "Taego",
  "데스턴": "Deston",
  "론도": "Rondo",
  Baltic_Main: "Erangel",
  Erangel_Main: "Erangel",
  Desert_Main: "Miramar",
  DihorOtok_Main: "Vikendi",
  Chimera_Main: "Vikendi",
  Tiger_Main: "Taego",
  Kiki_Main: "Deston",
  Neon_Main: "Rondo",
  Erangel: "Erangel",
  Miramar: "Miramar",
  Vikendi: "Vikendi",
  Taego: "Taego",
  Deston: "Deston",
  Rondo: "Rondo",
};

export function resolve3DMapCapability(mapName: string): Replay3DMapCapability | null {
  const mapId = aliases[mapName.trim()];
  return mapId ? capabilities[mapId] : null;
}

export function get3DReplayUnsupportedMessage(mapName: string): string {
  const displayName = mapName.trim() || "이";
  return `${displayName} 맵은 현재 3D 리플레이를 지원하지 않습니다. 2D 리플레이를 이용해 주세요.`;
}
