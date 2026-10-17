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
