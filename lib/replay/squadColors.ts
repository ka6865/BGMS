// 리플레이에서 아군 선수를 구분하는 색. 지도 점·선수 칩·타임라인·킬피드가 같은 순서를 쓴다.
export const SQUAD_COLORS = ["#F2A900", "#34A853", "#3b82f6", "#ef4444"] as const;

/** teamNames 순서에 따른 아군 색. 목록에 없으면 첫 색을 쓴다. */
export function squadColor(teamNames: readonly string[], name: string): string {
  const target = name.trim().toLowerCase();
  const index = teamNames.findIndex((teamName) => teamName.trim().toLowerCase() === target);
  return SQUAD_COLORS[Math.max(0, index) % SQUAD_COLORS.length];
}

// 적 팀 색. 팀 번호로 정해서 2D·3D·화면 순서와 관계없이 같은 팀이 같은 색을 쓴다.
export const ENEMY_TEAM_COLORS = [
  "#ff4a4a", "#00f0ff", "#ff2a85", "#39ff14", "#ffff33", "#bf00ff", "#ff8c00",
  "#00ff87", "#ff5e00", "#9d4edd", "#0077b6", "#e0aaff",
] as const;

export function enemyTeamColor(teamId: number | null | undefined): string {
  const index = typeof teamId === "number" && Number.isFinite(teamId) ? Math.abs(Math.trunc(teamId)) : 0;
  return ENEMY_TEAM_COLORS[index % ENEMY_TEAM_COLORS.length];
}
