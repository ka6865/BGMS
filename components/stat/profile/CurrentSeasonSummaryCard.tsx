"use client";

import { BarChart3, Clock3, Crosshair, Crown, Target, Trophy } from "lucide-react";
import type {
  StatsPartySize,
  StatsSeasonSummaryMetrics,
  StatsSurvivalMastery,
} from "@/types/stats-page";
import { getTierIconPath } from "@/utils/tier";

export interface CurrentSeasonSummaryCardProps {
  summary: StatsSeasonSummaryMetrics;
  survivalMastery?: StatsSurvivalMastery | null;
  partySize?: StatsPartySize;
  onPartySizeChange?(value: StatsPartySize): void;
}

const PARTY_LABELS: Record<StatsPartySize, string> = {
  solo: "솔로",
  duo: "듀오",
  squad: "스쿼드",
};

const PARTY_OPTIONS: readonly { value: StatsPartySize; label: string }[] = [
  { value: "solo", label: "솔로" },
  { value: "duo", label: "듀오" },
  { value: "squad", label: "스쿼드" },
];

function partyLabel(summary: StatsSeasonSummaryMetrics): string {
  return PARTY_LABELS[summary.partySize];
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

function EmptySummary({ seasonName, party }: { seasonName: string; party: string }) {
  return (
    <div className="flex min-h-28 items-center justify-center px-5 py-6 text-center">
      <div>
        <div className="text-sm font-black text-white/70">기록 없음</div>
        <div className="mt-1 text-xs font-bold text-white/35">{seasonName} 경쟁전에 저장된 {party} 경기가 아직 없습니다.</div>
      </div>
    </div>
  );
}

export function CurrentSeasonSummaryCard({
  summary,
  survivalMastery,
  partySize,
  onPartySizeChange,
}: CurrentSeasonSummaryCardProps) {
  const selectedPartySize = partySize ?? summary.partySize;
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
        {survivalMastery ? (
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-2.5 py-2">
            <Crown size={16} className="text-amber-300" aria-hidden="true" />
            <div className="text-right">
              <div className="text-[9px] font-black uppercase tracking-wider text-amber-200/60">생존 레벨</div>
              <div className="text-sm font-black tabular-nums text-amber-200">
                Lv.{survivalMastery.level}
                {survivalMastery.xp != null && (
                  <span className="ml-1 text-[10px] font-bold text-amber-100/60">{`XP ${survivalMastery.xp}`}</span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <Crown size={22} className="mt-1 shrink-0 text-amber-300" aria-hidden="true" />
        )}
      </div>

      {summary.kind === "empty" ? (
        <EmptySummary seasonName={summary.seasonName} party={party} />
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

      {onPartySizeChange && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-2.5 md:px-5">
          <span className="text-[10px] font-black uppercase tracking-wider text-white/40">랭크 파티</span>
          <div className="flex min-w-0 gap-1 rounded-lg bg-white/5 p-1" role="group" aria-label="현재 시즌 파티 필터">
            {PARTY_OPTIONS.map((option) => {
              const selected = option.value === selectedPartySize;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onPartySizeChange(option.value)}
                  className={`min-h-8 rounded-md px-2.5 text-[10px] font-black transition-colors ${
                    selected ? "bg-amber-500 text-black" : "text-white/50 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
