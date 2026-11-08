"use client";

import { summarizeSeasonStats } from "@/lib/stats/seasonSummary";
import type { PlayerStatsResponse, StatsStoredSeasonSummary } from "@/types/stats-page";
import { normalizeName } from "@/lib/pubg-analysis/utils";

export type StatsSeasonOverview = StatsStoredSeasonSummary & { seasonName: string | null };

export interface StatsSeasonOverviewCardProps {
  season: StatsSeasonOverview | null;
}

/** 현재 플레이어·시즌에 맞는 전체 모드 합계만 표시한다. */
export function seasonOverviewForResult(
  summary: StatsStoredSeasonSummary | undefined,
  result: Pick<PlayerStatsResponse, "nickname" | "seasonId" | "seasons" | "stats" | "statsAvailability">,
): StatsSeasonOverview | null {
  if (!summary || normalizeName(summary.nickname) !== normalizeName(result.nickname)) return null;
  const complete = result.statsAvailability?.ranked?.status === "ready"
    && result.statsAvailability?.normal?.status === "ready"
    && result.stats.ranked && result.stats.normal;
  if (complete) {
    const refreshed = summarizeSeasonStats({ [result.seasonId]: result.stats });
    if (!refreshed) return null;
    summary = { ...refreshed, nickname: result.nickname };
  } else if (summary.seasonId !== result.seasonId) {
    return null;
  }
  return { ...summary, seasonName: result.seasons.find((season) => season.id === summary.seasonId)?.name ?? null };
}

// 최근 20경기 요약과 구분되도록 시즌 전체 합계임을 제목에 밝힌다. 모바일에서도 보인다.
export function StatsSeasonOverviewCard({ season }: StatsSeasonOverviewCardProps) {
  if (!season) return null;
  return (
    <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="이번 시즌 전체">
      <h2 className="text-base font-black text-white">이번 시즌 전체</h2>
      <p className="mt-1 text-xs leading-5 text-white/75">
        {season.seasonName ?? "최근 시즌"}의 경쟁전·일반전, 솔로·듀오·스쿼드를 모두 합친 기록입니다.
      </p>
      <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-white/10 pt-3 text-center">
        <div><dt className="text-xs font-bold text-white/70">경기</dt><dd className="text-sm font-black text-white">{season.rounds}</dd></div>
        <div><dt className="text-xs font-bold text-white/70">평균 딜량</dt><dd className="text-sm font-black text-white">{season.avgDamage}</dd></div>
        <div><dt className="text-xs font-bold text-white/70">경기당 킬</dt><dd className="text-sm font-black text-white">{season.killsPerRound}</dd></div>
        <div><dt className="text-xs font-bold text-white/70">우승</dt><dd className="text-sm font-black text-white">{season.wins}</dd></div>
      </dl>
    </section>
  );
}
