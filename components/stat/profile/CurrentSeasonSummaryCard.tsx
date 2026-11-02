"use client";

import { BarChart3, Clock3, Crosshair, Crown, Target, Trophy } from "lucide-react";
import type {
  StatsMode,
  StatsModeAvailability,
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
      <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-white/75">
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
  label,
  seasonName,
  mode,
  party,
  availability,
}: {
  label: string;
  seasonName: string;
  mode: string;
  party: string;
  availability?: StatsModeAvailability;
}) {
  if (availability?.status === "stale") {
    const parsed = availability.updatedAt ? Date.parse(availability.updatedAt) : Number.NaN;
    const updated = Number.isFinite(parsed)
      ? new Date(parsed).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
      : "갱신 시각 확인 불가";
    return (
      <div className="flex min-h-28 items-center justify-center px-5 py-6 text-center">
        <div>
          <div className="text-sm font-black text-sky-200">이전 자료를 확인할 수 없습니다</div>
          <div className="mt-1 text-xs font-bold text-white/75">마지막 갱신: {updated} · {seasonName} {mode} {party} 자료</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-28 items-center justify-center px-5 py-6 text-center">
      <div>
        <div className="text-sm font-black text-white/70">{label}</div>
        <div className="mt-1 text-xs font-bold text-white/75">{label === "아직 갱신하지 않은 시즌"
          ? "전적 갱신을 눌러 이 시즌의 기록을 불러오세요."
          : `${seasonName} ${mode}에 저장된 ${party} 경기가 아직 없습니다.`}</div>
      </div>
    </div>
  );
}

function UnavailableSummary({ message }: { message: string }) {
  return (
    <div
      data-testid="stats-availability-notice"
      role="status"
      className="flex min-h-28 items-center justify-center px-5 py-6 text-center"
    >
      <div>
        <div className="text-sm font-black text-amber-200">조회 불가</div>
        <div className="mt-1 text-xs font-bold leading-5 text-white/75">{message}</div>
      </div>
    </div>
  );
}

function AvailabilityNotice({ availability }: { availability?: StatsModeAvailability }) {
  if (!availability || availability.status !== "stale") return null;
  const parsed = availability.updatedAt ? Date.parse(availability.updatedAt) : Number.NaN;
  const updated = Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
    : "갱신 시각 확인 불가";
  return (
    <div
      data-testid="stats-availability-notice"
      role="status"
      className="mb-4 rounded-xl border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2 text-xs font-bold leading-5 text-sky-100/80"
    >
      <div className="font-black text-sky-200">이전 자료로 표시 중</div>
      <div>마지막 갱신: {updated}</div>
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
      <div className="border-b border-white/10 bg-gradient-to-r from-[#1c2b2d] to-[#182022] px-3 py-2.5 md:px-5 md:py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-black uppercase tracking-wide text-teal-100">
            <span>현재 시즌</span>
            <span className="text-white/20">|</span>
            <span>{modeLabel} · {party}</span>
          </div>
          <h3 className="mt-0.5 truncate text-lg font-black tracking-tight text-white md:text-2xl">
            {summary.seasonName}
          </h3>
        </div>
      </div>

      {summary.kind === "unavailable" ? (
        <UnavailableSummary message={summary.message} />
      ) : summary.kind === "empty" ? (
        <EmptySummary
          label={summary.label}
          seasonName={summary.seasonName}
          mode={modeLabel}
          party={party}
          availability={summary.availability}
        />
      ) : (
        <>
          <AvailabilityNotice availability={summary.availability} />
          <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4 md:p-4">
            {summary.mode === "ranked" ? (
              <div className="flex min-w-0 items-center gap-1.5 rounded-xl bg-amber-400/[0.06] p-2.5 md:gap-2">
                {summary.tier ? (
                  <img
                    src={getTierIconPath(summary.tier, summary.subTier)}
                    alt={`${rankLabel(summary)} 티어 아이콘`}
                    className="h-8 w-8 shrink-0 object-contain md:h-10 md:w-10"
                  />
                ) : (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 text-white/60 md:h-10 md:w-10">
                    <Trophy size={20} aria-hidden="true" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-xs font-black text-white/75">현재 랭크</div>
                  {/* 가장 긴 티어 이름(Platinum 3)도 좁은 화면에서 잘리지 않게 글자 크기를 줄이고 줄바꿈을 허용한다 */}
                  <div className="text-base font-black leading-tight break-words text-amber-300 md:text-lg">{rankLabel(summary)}</div>
                  <div className="text-xs font-bold tabular-nums text-white/80">
                    {summary.rankPoint != null ? `${summary.rankPoint} RP` : "RP —"}
                  </div>
                </div>
              </div>
            ) : (
              <div className="min-w-0 rounded-xl bg-sky-400/[0.06] px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-black text-white/75">
                  <BarChart3 size={12} aria-hidden="true" /> 일반전 성적
                </div>
                <div className="mt-1 text-lg font-black text-sky-200">{summary.roundsPlayed}경기</div>
                <div className="text-xs font-bold text-white/70">랭크 티어 미적용</div>
              </div>
            )}
            <Metric icon={<Crosshair size={12} aria-hidden="true" />} label="평균 딜량" value={summary.averageDamage} />
            <Metric label="KDA" value={summary.kda} />
            <Metric icon={<Target size={12} aria-hidden="true" />} label="승률" value={summary.winRate} accent />
          </div>

          <details className="border-t border-white/10 px-3 py-2 md:px-4">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-bold text-white/80 focus-visible:outline-2 focus-visible:outline-amber-300">
              기타 시즌 지표 및 생존 레벨
            </summary>
            <div className="grid grid-cols-2 gap-2 pb-2 md:grid-cols-4">
              {summary.mode === "ranked" && <Metric icon={<BarChart3 size={12} aria-hidden="true" />} label="경기" value={summary.roundsPlayed} />}
              <Metric icon={<Trophy size={12} aria-hidden="true" />} label="승" value={summary.wins} accent />
              <Metric icon={<Crown size={12} aria-hidden="true" />} label="Top 10률" value={summary.top10Rate} accent />
              <Metric icon={<Clock3 size={12} aria-hidden="true" />} label="평균 생존" value={summary.averageSurvival} />
              <Metric label="헤드샷률" value={summary.headshotRate} />
              {(summary.bestTier || summary.bestRankPoint != null) && (
                <div className="col-span-2 self-center px-3 py-2 text-sm font-bold text-white/75 md:col-span-1">
                  최고 {summary.bestTier && `${summary.bestTier}${summary.bestSubTier != null ? ` ${summary.bestSubTier}` : ""}`}
                  {summary.bestRankPoint != null && ` · ${summary.bestRankPoint} RP`}
                </div>
              )}
              {survivalMastery && (
                <div
                  className="group relative col-span-2 flex min-h-11 items-center gap-2 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-amber-300 md:col-span-1"
                  tabIndex={0}
                  role="group"
                  aria-label={`생존 티어 ${survivalMastery.tier ?? "확인 불가"}, 레벨 ${survivalMastery.level}${survivalMastery.xp != null ? `, 누적 XP ${survivalMastery.xp.toLocaleString("ko-KR")}` : ""}`}
                  title={survivalMastery.xp != null ? `누적 XP ${survivalMastery.xp.toLocaleString("ko-KR")}` : undefined}
                >
                  <Crown size={16} className="text-amber-300" aria-hidden="true" />
                  <span className="text-sm font-bold text-amber-100">
                    생존 티어 {survivalMastery.tier ?? "—"} · Lv.{survivalMastery.level}
                  </span>
                  {survivalMastery.xp != null && (
                    <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-30 mt-2 whitespace-nowrap rounded-lg border border-amber-300/20 bg-[#111] px-3 py-2 text-xs font-black text-amber-100 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100 group-focus:opacity-100">
                      누적 XP {survivalMastery.xp.toLocaleString("ko-KR")}
                    </span>
                  )}
                </div>
              )}
            </div>
          </details>
        </>
      )}

      {summary.kind !== "ready" && survivalMastery && (
        <details className="border-t border-white/10 px-3 py-2 md:px-4">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-bold text-white/80 focus-visible:outline-2 focus-visible:outline-amber-300">
            기타 시즌 지표 및 생존 레벨
          </summary>
          <div
            className="flex min-h-11 items-center gap-2 px-3 py-2"
            role="group"
            aria-label={`생존 티어 ${survivalMastery.tier ?? "확인 불가"}, 레벨 ${survivalMastery.level}${survivalMastery.xp != null ? `, 누적 XP ${survivalMastery.xp.toLocaleString("ko-KR")}` : ""}`}
          >
            <Crown size={16} className="text-amber-300" aria-hidden="true" />
            <span className="text-sm font-bold text-amber-100">
              생존 티어 {survivalMastery.tier ?? "—"} · Lv.{survivalMastery.level}
              {survivalMastery.xp != null && ` · 누적 XP ${survivalMastery.xp.toLocaleString("ko-KR")}`}
            </span>
          </div>
        </details>
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
                      className={`min-h-11 min-w-11 rounded-md px-2.5 text-xs font-black transition-colors ${
                      selected ? "bg-amber-500 text-black" : "text-white/75 hover:bg-white/5 hover:text-white"
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
                      className={`min-h-11 min-w-11 rounded-md px-2.5 text-xs font-black transition-colors ${
                      selected ? "bg-amber-500 text-black" : "text-white/75 hover:bg-white/5 hover:text-white"
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
