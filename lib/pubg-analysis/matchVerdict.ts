// 경기 상세 상단 "이 판 결론"에 쓰는 좋았던·아쉬웠던 점수 범주 선정. 서버가 계산한 benchmark.breakdown만 쓴다.

export type MatchScoreCategory = "combat" | "tactical" | "survival";

export const MATCH_SCORE_CATEGORY_LABELS: Record<MatchScoreCategory, string> = {
  combat: "전투",
  tactical: "전술",
  survival: "생존",
};

const CATEGORIES: readonly MatchScoreCategory[] = ["combat", "tactical", "survival"];

/** 모드별 범주 만점. 솔로는 전술 비중이 작다. 티어 근거 패널의 점수 막대와 같은 값을 쓴다. */
export function getMatchScoreMax(gameMode: string | null | undefined, isTdm: boolean): Record<MatchScoreCategory, number> {
  return !isTdm && (gameMode || "").toLowerCase().includes("solo")
    ? { combat: 50, tactical: 15, survival: 35 }
    : { combat: 40, tactical: 35, survival: 25 };
}

export interface MatchVerdictMetric {
  category: MatchScoreCategory;
  label: string;
  score: number;
  max: number;
  evidence: string;
}

// 만점 대비 이 비율 이상이면 좋았던 점 후보, 미만이면 아쉬웠던 점 후보다.
const VERDICT_SPLIT_RATIO = 0.5;

/**
 * 범주별 점수를 만점 대비 비율로 비교해 가장 높은 범주(비율 0.5 이상)와 가장 낮은 범주(0.5 미만)를 하나씩 고른다.
 * 근거 문장이 없거나 "측정 불가"로 끝나는 범주는 표본이 없는 것으로 보고 고르지 않는다. 동률이면 전투·전술·생존 순서를 따른다.
 */
export function pickMatchVerdictMetrics(input: {
  breakdown: Partial<Record<MatchScoreCategory, unknown>> | null | undefined;
  max: Record<MatchScoreCategory, number>;
  evidence: Partial<Record<MatchScoreCategory, string>>;
}): { best: MatchVerdictMetric | null; weak: MatchVerdictMetric | null } {
  const candidates = CATEGORIES.flatMap((category) => {
    const score = input.breakdown?.[category];
    const max = input.max[category];
    const evidence = input.evidence[category]?.trim();
    if (typeof score !== "number" || !Number.isFinite(score) || !(max > 0)) return [];
    if (!evidence || evidence.endsWith("측정 불가")) return [];
    const ratio = Math.min(1, Math.max(0, score / max));
    return [{ metric: { category, label: MATCH_SCORE_CATEGORY_LABELS[category], score, max, evidence }, ratio }];
  });
  let best: (typeof candidates)[number] | null = null;
  let weak: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.ratio >= VERDICT_SPLIT_RATIO) {
      if (!best || candidate.ratio > best.ratio) best = candidate;
    } else if (!weak || candidate.ratio < weak.ratio) {
      weak = candidate;
    }
  }
  return { best: best?.metric ?? null, weak: weak?.metric ?? null };
}
