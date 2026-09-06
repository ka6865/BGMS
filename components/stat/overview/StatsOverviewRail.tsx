"use client";

import type { AiSummarySnapshot } from "@/components/stat/RecentAISummary";
import type { StatsModeAvailability, StatsOverviewMetrics } from "@/types/stats-page";

export interface StatsOverviewRailProps {
  metrics: StatsOverviewMetrics;
  aiSummary: AiSummarySnapshot | null;
  aiExpanded: boolean;
  onAiToggle(): void;
}

function Metric({ testId, label, value }: { testId: string; label: string; value: string | number }) {
  return (
    <div className="min-w-0 py-2">
      <div data-testid={testId} className="truncate text-xl font-black text-white">{value}</div>
      <div className="mt-1 text-[11px] font-bold text-white/40">{label}</div>
    </div>
  );
}

function AvailabilityNotice({
  availability,
  message,
}: {
  availability?: StatsModeAvailability;
  message?: string;
}) {
  if (!availability || availability.status === "ready") return null;
  if (availability.status === "unavailable") {
    return (
      <div
        data-testid="stats-availability-notice"
        role="status"
        className="mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs font-bold leading-5 text-amber-100/80"
      >
        <div className="font-black text-amber-200">조회 불가</div>
        <div>{message || "이 모드 전적을 조회하지 못해 현재 수치를 표시할 수 없습니다."}</div>
      </div>
    );
  }

  const parsed = availability.updatedAt ? Date.parse(availability.updatedAt) : Number.NaN;
  const updated = Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
    : "갱신 시각 확인 불가";
  return (
    <div
      data-testid="stats-availability-notice"
      role="status"
      className="mb-3 rounded-xl border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2 text-xs font-bold leading-5 text-sky-100/80"
    >
      <div className="font-black text-sky-200">이전 자료로 표시 중</div>
      <div>마지막 갱신: {updated}</div>
    </div>
  );
}

function AiCompactSummary({
  summary,
  expanded,
  onToggle,
}: {
  summary: AiSummarySnapshot | null;
  expanded: boolean;
  onToggle(): void;
}) {
  if (!summary) return null;

  return (
    <div className="border-t border-white/10 pt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-black text-indigo-300">AI 한줄 요약</span>
        {summary.tier && <span className="rounded-md bg-indigo-500/20 px-2 py-1 text-xs font-black text-indigo-200">{summary.tier}</span>}
      </div>
      <p className={`break-words text-sm leading-6 text-white/70 ${expanded ? "" : "line-clamp-2 md:line-clamp-3"}`}>
        {summary.verdict}
      </p>
      <button
        type="button"
        aria-label={expanded ? "AI 요약 접기" : "AI 요약 더보기"}
        onClick={onToggle}
        className="mt-2 min-h-11 text-xs font-black text-indigo-300 hover:text-indigo-200"
      >
        {expanded ? "접기" : "더보기"}
      </button>
    </div>
  );
}

export function StatsOverviewRail({
  metrics,
  aiSummary,
  aiExpanded,
  onAiToggle,
}: StatsOverviewRailProps) {
  if (metrics.kind === "unavailable") {
    return (
      <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="핵심 통계">
        <AvailabilityNotice availability={metrics.availability} message={metrics.message} />
        <AiCompactSummary summary={aiSummary} expanded={aiExpanded} onToggle={onAiToggle} />
      </section>
    );
  }

  if (metrics.kind === "empty") {
    return (
      <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="핵심 통계">
        <AvailabilityNotice availability={metrics.availability} />
        <div className="flex min-h-32 items-center justify-center text-sm font-black text-white/40">{metrics.label}</div>
        <AiCompactSummary summary={aiSummary} expanded={aiExpanded} onToggle={onAiToggle} />
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="핵심 통계">
      <AvailabilityNotice availability={metrics.availability} />
      <div className="grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-4 lg:grid-cols-2">
        <Metric testId="kills" label="킬" value={metrics.kills} />
        <Metric testId="assists" label="어시스트" value={metrics.assists} />
        <Metric testId="dbnos" label="기절" value={metrics.dbnos} />
        <Metric testId="average-rank" label="평균 순위" value={metrics.averageRank} />
      </div>
      <AiCompactSummary summary={aiSummary} expanded={aiExpanded} onToggle={onAiToggle} />
    </section>
  );
}
