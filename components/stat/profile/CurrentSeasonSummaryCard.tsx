"use client";

import { BarChart3, Clock3, Crosshair, Crown, Target, Trophy } from "lucide-react";
import type {
  StatsMode,
  StatsPartySize,
  StatsSeasonSummaryMetrics,
  StatsSurvivalMastery,
} from "@/types/stats-page";
import { getTierIconPath } from "@/utils/tier";

export interface CurrentSeasonSummaryCardProps {
  summary: StatsSeasonSummaryMetrics;
  survivalMastery?: StatsSurvivalMastery | null;
  mode?: StatsMode;
  onModeChange?(value: StatsMode): void;
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

const MODE_LABELS: Record<StatsMode, string> = {
  ranked: "경쟁전",
  normal: "일반전",
};

const MODE_OPTIONS: readonly { value: StatsMode; label: string }[] = [
  { value: "ranked", label: "경쟁전" },
  { value: "normal", label: "일반전" },
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

function EmptySummary({
  seasonName,
  mode,
  party,
}: {
  seasonName: string;
  mode: string;
  party: string;
}) {
  return (
    <div className="flex min-h-28 items-center justify-center px-5 py-6 text-center">
      <div>
        <div className="text-sm font-black text-white/70">기록 없음</div>
        <div className="mt-1 text-xs font-bold text-white/35">{seasonName} {mode}에 저장된 {party} 경기가 아직 없습니다.</div>
      </div>
    </div>
  );
}

export function CurrentSeasonSummaryCard({
  summary,
  survivalMastery,
  mode,
  onModeChange,
  partySize,
  onPartySizeChange,
}: CurrentSeasonSummaryCardProps) {
  const selectedMode = mode ?? summary.mode;
  const selectedPartySize = partySize ?? summary.partySize;
  const modeLabel = MODE_LABELS[summary.mode];
  const party = partyLabel(summary);
  const ariaLabel = `현재 시즌 ${modeLabel} ${party} 요약`;

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
            <span>{modeLabel} · {party}</span>
          </div>
          <h3 className="mt-1 truncate text-xl font-black tracking-tight text-white md:text-2xl">
            {summary.seasonName}
          </h3>
        </div>
        {survivalMastery ? (
          <div
            className="group relative flex shrink-0 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
            tabIndex={0}
            role="group"
            aria-label={`생존 티어 ${survivalMastery.tier ?? "확인 불가"}, 레벨 ${survivalMastery.level}${survivalMastery.xp != null ? `, 누적 XP ${survivalMastery.xp.toLocaleString("ko-KR")}` : ""}`}
            title={survivalMastery.xp != null ? `누적 XP ${survivalMastery.xp.toLocaleString("ko-KR")}` : undefined}
          >
            <Crown size={16} className="text-amber-300" aria-hidden="true" />
            <div className="text-right">
              <div className="text-[9px] font-black uppercase tracking-wider text-amber-200/60">
                생존 티어 {survivalMastery.tier ?? "—"}
              </div>
              <div className="text-sm font-black tabular-nums text-amber-200">Lv.{survivalMastery.level}</div>
            </div>
            {survivalMastery.xp != null && (
              <div
                role="tooltip"
                className="pointer-events-none absolute right-0 top-full z-30 mt-2 whitespace-nowrap rounded-lg border border-amber-300/20 bg-[#111] px-3 py-2 text-[11px] font-black text-amber-100 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100 group-focus:opacity-100"
              >
                누적 XP {survivalMastery.xp.toLocaleString("ko-KR")}
              </div>
            )}
          </div>
        ) : (
          <Crown size={22} className="mt-1 shrink-0 text-amber-300" aria-hidden="true" />
        )}
      </div>

      {summary.kind === "empty" ? (
        <EmptySummary seasonName={summary.seasonName} mode={modeLabel} party={party} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(180px,0.78fr)_minmax(0,1.7fr)] md:p-5">
            {summary.mode === "ranked" ? (
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
                  {(summary.bestTier || summary.bestRankPoint != null) && (
                    <div className="mt-1 truncate text-[10px] font-bold text-white/45">
                      {summary.bestTier && `최고 ${summary.bestTier}${summary.bestSubTier != null ? ` ${summary.bestSubTier}` : ""}`}
                      {summary.bestRankPoint != null && ` · ${summary.bestRankPoint} RP`}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-400/10 bg-sky-400/[0.04] p-3">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-sky-400/10 text-sky-200 md:h-20 md:w-20">
                  <BarChart3 size={28} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-black uppercase tracking-wider text-white/40">일반전 성적</div>
                  <div className="mt-1 text-xl font-black text-sky-200">{summary.roundsPlayed}경기</div>
                  <div className="mt-1 text-[10px] font-bold text-white/45">랭크 티어 미적용</div>
                </div>
              </div>
            )}

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

      {(onModeChange || onPartySizeChange) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-2.5 md:px-5">
          <div className="flex flex-wrap items-center gap-2">
            {onModeChange && (
              <div className="flex min-w-0 gap-1 rounded-lg bg-white/5 p-1" role="group" aria-label="현재 시즌 모드 필터">
                {MODE_OPTIONS.map((option) => {
                  const selected = option.value === selectedMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onModeChange(option.value)}
                      className={`min-h-8 rounded-md px-2.5 text-[10px] font-black transition-colors ${
                        selected ? "bg-amber-500 text-black" : "text-white/50 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}
            {onPartySizeChange && (
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
            )}
          </div>
        </div>
      )}
    </section>
  );
}
