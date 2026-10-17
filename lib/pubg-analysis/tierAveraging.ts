import { estimateUserTier, TIER_THRESHOLDS } from "./benchmarkScore";

// score가 없는 기록은 해당 티어 점수 구간의 중간값으로 대체한다(최상위 구간은 100점까지).
export const TIER_FALLBACK_SCORES: Record<string, number> = Object.fromEntries(
  TIER_THRESHOLDS.map(({ tier, min }, index) => {
    const upper = index === 0 ? 100 : TIER_THRESHOLDS[index - 1].min;
    return [tier, (min + upper) / 2];
  }),
);

export function estimateAverageTierFromRows(rows: any[]): string {
  if (!rows.length) return "D-";

  const scores = rows
    .map(row => Number(row.score))
    .filter(score => Number.isFinite(score) && score > 0);

  if (scores.length > 0) {
    const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return estimateUserTier(avgScore);
  }

  const avgFallbackScore = rows.reduce((sum, row) => {
    return sum + (TIER_FALLBACK_SCORES[row.tier as string] ?? 0);
  }, 0) / rows.length;

  return estimateUserTier(avgFallbackScore);
}

export type TierScope = "solo" | "team";

// 점수 산식은 gameMode에 solo가 들어가면 솔로 배점을 쓴다(AnalysisEngine). 티어 범위도 같은 기준으로 나눈다.
export function tierScopeOfMode(mode: unknown): TierScope {
  return String(mode ?? "").toLowerCase().includes("solo") ? "solo" : "team";
}

// 솔로와 팀은 배점이 달라 평균을 섞지 않는다. 경기 수가 더 많은 범위를 쓰고, 같으면 팀을 쓴다.
export function dominantTierScope(modes: readonly unknown[]): TierScope | null {
  if (modes.length === 0) return null;
  const soloCount = modes.filter((mode) => tierScopeOfMode(mode) === "solo").length;
  return soloCount > modes.length - soloCount ? "solo" : "team";
}

export function estimateScopedTierFromRows(rows: any[]): { tier: string | null; scope: TierScope | null; matchCount: number } {
  const scope = dominantTierScope(rows.map((row) => row?.game_mode));
  if (!scope) return { tier: null, scope: null, matchCount: 0 };
  const scopedRows = rows.filter((row) => tierScopeOfMode(row?.game_mode) === scope);
  return { tier: estimateAverageTierFromRows(scopedRows), scope, matchCount: scopedRows.length };
}
