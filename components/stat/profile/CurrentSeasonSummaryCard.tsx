"use client";

import { BarChart3, Clock3, Crosshair, Crown, Target, Trophy } from "lucide-react";
import type { StatsPartySize, StatsSeasonSummaryMetrics } from "@/types/stats-page";
import { getTierIconPath } from "@/utils/tier";

export interface CurrentSeasonSummaryCardProps {
  summary: StatsSeasonSummaryMetrics;
}

const PARTY_LABELS: Record<StatsPartySize, string> = {
  solo: "솔로",
  duo: "듀오",
  squad: "스쿼드",
};

function partyLabel(summary: StatsSeasonSummaryMetrics): string {
  return summary.kind === "ready" ? PARTY_LABELS[summary.partySize] : PARTY_LABELS.squad;
}

function rankLabel(summary: Extract<StatsSeasonSummaryMetrics, { kind: "ready" }>): string {
  if (!summary.tier) return "언랭크";
  const subTier = summary.subTier == null || String(summary.subTier).trim() === ""
    ? ""
    : ` ${summary.subTier}`;
  return `${summary.tier}${subTier}`;
}

function Metric({
  icon,
  label,
  value,
  accent = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-white/[0.035] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-white/40">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1 truncate text-lg font-black tabular-nums ${accent ? "text-amber-300" : "text-white"}`}>
        {value}
      </div>
    </div>
  );
}

function EmptySummary({ seasonName }: { seasonName: string }) {
  return (
    <div className="flex min-h-28 items-center justify-center px-5 py-6 text-center">
      <div>
        <div className="text-sm font-black text-white/70">기록 없음</div>
        <div className="mt-1 text-xs font-bold text-white/35">{seasonName} 경쟁전에 저장된 스쿼드 경기가 아직 없습니다.</div>
      </div>
    </div>
  );
}

export function CurrentSeasonSummaryCard({ summary }: CurrentSeasonSummaryCardProps) {
  const party = partyLabel(summary);
  const ariaLabel = `현재 시즌 경쟁전 ${party} 요약`;

  return (
    <section
      aria-label={ariaLabel}
      className="overflow-hidden rounded-2xl border border-white/10 bg-[#161616]"
    >
      <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-gradient-to-r from-[#1c2b2d] to-[#182022] px-4 py-3 md:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-teal-200/70">
            <span>현재 시즌</span>
            <span className="text-white/20">|</span>
            <span>경쟁전 · {party}</span>
          </div>
          <h3 className="mt-1 truncate text-xl font-black tracking-tight text-white md:text-2xl">
            {summary.seasonName}
          </h3>
        </div>
        <Crown size={22} className="mt-1 shrink-0 text-amber-300" aria-hidden="true" />
      </div>

      {summary.kind === "empty" ? (
        <EmptySummary seasonName={summary.seasonName} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(180px,0.78fr)_minmax(0,1.7fr)] md:p-5">
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-400/10 bg-amber-400/[0.04] p-3">
              {summary.tier ? (
                <img
                  src={getTierIconPath(summary.tier, summary.subTier)}
                  alt={`${rankLabel(summary)} 티어 아이콘`}
                  className="h-16 w-16 shrink-0 object-contain md:h-20 md:w-20"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/5 text-white/25 md:h-20 md:w-20">
                  <Trophy size={28} aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-wider text-white/40">현재 랭크</div>
                <div className="mt-1 truncate text-xl font-black text-amber-300">{rankLabel(summary)}</div>
                <div className="mt-1 text-sm font-black tabular-nums text-white/80">
                  {summary.rankPoint != null ? `${summary.rankPoint} RP` : "RP —"}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Metric icon={<BarChart3 size={12} aria-hidden="true" />} label="경기" value={summary.roundsPlayed} />
              <Metric icon={<Trophy size={12} aria-hidden="true" />} label="승" value={summary.wins} accent />
              <Metric icon={<Target size={12} aria-hidden="true" />} label="승률" value={summary.winRate} accent />
              <Metric icon={<Crown size={12} aria-hidden="true" />} label="Top 10률" value={summary.top10Rate} accent />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-white/10 px-4 py-4 md:grid-cols-4 md:px-5">
            <Metric icon={<Crosshair size={12} aria-hidden="true" />} label="평균 딜량" value={summary.averageDamage} />
            <Metric label="KDA" value={summary.kda} />
            <Metric icon={<Clock3 size={12} aria-hidden="true" />} label="평균 생존" value={summary.averageSurvival} />
            <Metric label="헤드샷률" value={summary.headshotRate} />
          </div>
        </>
      )}
    </section>
  );
}
