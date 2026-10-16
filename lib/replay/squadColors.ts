// 리플레이에서 아군 선수를 구분하는 색. 지도 점·선수 칩·타임라인·킬피드가 같은 순서를 쓴다.
export const SQUAD_COLORS = ["#F2A900", "#34A853", "#3b82f6", "#ef4444"] as const;

/** teamNames 순서에 따른 아군 색. 목록에 없으면 첫 색을 쓴다. */
export function squadColor(teamNames: readonly string[], name: string): string {
  const target = name.trim().toLowerCase();
  const index = teamNames.findIndex((teamName) => teamName.trim().toLowerCase() === target);
  return SQUAD_COLORS[Math.max(0, index) % SQUAD_COLORS.length];
}
