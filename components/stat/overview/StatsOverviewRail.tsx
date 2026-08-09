"use client";

import { Brain } from "lucide-react";
import type { AiSummarySnapshot } from "@/components/stat/RecentAISummary";
import type { StatsOverviewMetrics, StatsPartySize } from "@/types/stats-page";

export interface StatsOverviewRailProps {
  metrics: StatsOverviewMetrics;
  aiSummary: AiSummarySnapshot | null;
  aiExpanded: boolean;
  onAiOpen(): void;
  onAiToggle(): void;
}

const PARTY_LABELS: Record<StatsPartySize, string> = {
  solo: "솔로",
  duo: "듀오",
  squad: "스쿼드",
};

function Metric({ testId, label, value }: { testId: string; label: string; value: string | number }) {
  return (
    <div className="min-w-0 py-2">
      <div data-testid={testId} className="truncate text-xl font-black text-white">{value}</div>
      <div className="mt-1 text-[11px] font-bold text-white/40">{label}</div>
    </div>
  );
}

function AiCompactSummary({
  summary,
  expanded,
  onOpen,
  onToggle,
}: {
  summary: AiSummarySnapshot | null;
  expanded: boolean;
  onOpen(): void;
  onToggle(): void;
}) {
  if (!summary) {
    return (
      <button
        type="button"
        aria-label="AI 분석 시작"
        onClick={onOpen}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 text-sm font-black text-indigo-300 hover:bg-indigo-500/15"
      >
        <Brain size={16} aria-hidden="true" />
        AI 분석 시작
      </button>
    );
  }

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
  onAiOpen,
  onAiToggle,
}: StatsOverviewRailProps) {
  if (metrics.kind === "empty") {
    return (
      <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="핵심 통계">
        <div className="flex min-h-32 items-center justify-center text-sm font-black text-white/40">{metrics.label}</div>
        <AiCompactSummary summary={aiSummary} expanded={aiExpanded} onOpen={onAiOpen} onToggle={onAiToggle} />
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="핵심 통계">
      <div className="grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-4 lg:grid-cols-2">
        <Metric testId="rounds-played" label="게임 수" value={metrics.roundsPlayed} />
        <Metric testId="kda" label="KDA" value={metrics.kda} />
        <Metric testId="average-damage" label="평균 딜량" value={metrics.averageDamage} />
        <Metric testId="top10-rate" label="Top 10" value={metrics.top10Rate} />
      </div>
      <div className="mb-4 mt-2 border-t border-white/10 pt-3 text-xs text-white/50">
        선호 모드 <strong data-testid="preferred-mode" className="ml-2 text-white">{PARTY_LABELS[metrics.preferredMode]}</strong>
      </div>
      <AiCompactSummary summary={aiSummary} expanded={aiExpanded} onOpen={onAiOpen} onToggle={onAiToggle} />
    </section>
  );
}
