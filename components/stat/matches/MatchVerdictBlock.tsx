"use client";

import { estimateUserTier } from "@/lib/pubg-analysis/benchmarkScore";
import type { MatchReport } from "@/lib/pubg-analysis/matchReport";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import {
  getMatchScoreMax,
  MATCH_SCORE_CATEGORY_LABELS,
  pickMatchVerdictMetrics,
  type MatchScoreCategory,
  type MatchVerdictMetric,
} from "@/lib/pubg-analysis/matchVerdict";
import { buildTierEvidence } from "./MatchPerformancePanel";
import { MatchDeathLine } from "./MatchReportSections";

const CATEGORY_BY_LABEL = Object.fromEntries(
  Object.entries(MATCH_SCORE_CATEGORY_LABELS).map(([category, label]) => [label, category]),
) as Record<string, MatchScoreCategory>;

function VerdictRow({ title, tone, metric }: { title: string; tone: string; metric: MatchVerdictMetric }) {
  return (
    <div className="flex items-start gap-2 text-xs leading-relaxed">
      <dt className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-black ${tone}`}>{title}</dt>
      <dd className="min-w-0 break-keep text-gray-200">
        <span className="font-black text-white">{metric.label} {metric.score} / {metric.max}점</span>
        <span className="text-gray-400"> · {metric.evidence}</span>
      </dd>
    </div>
  );
}

/** 펼친 경기 상단의 결론. 사망 경위, 경기 점수, 점수 비율이 가장 높고 낮은 범주를 서버 계산값만으로 보여 준다. */
export function MatchVerdictBlock({
  matchData,
  report,
  showScore,
}: {
  matchData: MatchSummaryData;
  report: MatchReport | null;
  showScore: boolean;
}) {
  const benchmark = showScore ? matchData.benchmark : undefined;
  const hasScore = Boolean(benchmark && typeof benchmark.score === "number" && Number.isFinite(benchmark.score));
  const hasDeath = Boolean(report?.death);
  if (!hasScore && !hasDeath) return null;

  const evidence: Partial<Record<MatchScoreCategory, string>> = {};
  if (hasScore) {
    for (const item of buildTierEvidence(matchData).summaryItems) {
      const category = CATEGORY_BY_LABEL[item.label];
      if (category) evidence[category] = item.value;
    }
  }
  const { best, weak } = hasScore
    ? pickMatchVerdictMetrics({ breakdown: benchmark!.breakdown, max: getMatchScoreMax(matchData.gameMode, false), evidence })
    : { best: null, weak: null };

  return (
    <section aria-label="이 판 결론" data-testid="match-verdict" className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-black text-white">이 판 결론</h4>
        {hasScore && (
          <span className="rounded-full bg-indigo-500/15 px-2.5 py-1 text-[11px] font-black text-indigo-200" data-testid="match-verdict-score">
            {estimateUserTier(benchmark!.score)} 티어 · {Number(benchmark!.score.toFixed(1))} / 100점
          </span>
        )}
      </div>
      {report && <MatchDeathLine report={report} />}
      {(best || weak) && (
        <dl className="mt-3 space-y-2">
          {best && <VerdictRow title="좋았던 점" tone="bg-emerald-500/15 text-emerald-300" metric={best} />}
          {weak && <VerdictRow title="아쉬운 점" tone="bg-amber-500/15 text-amber-300" metric={weak} />}
        </dl>
      )}
    </section>
  );
}
