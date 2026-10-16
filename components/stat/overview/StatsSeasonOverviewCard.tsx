"use client";

import type { StatsStoredSeasonSummary } from "@/types/stats-page";
import { normalizeName } from "@/lib/pubg-analysis/utils";

export type StatsSeasonOverview = StatsStoredSeasonSummary & { seasonName: string | null };

export interface StatsSeasonOverviewCardProps {
  season: StatsSeasonOverview | null;
}

/** 화면에 보이는 플레이어가 서버가 요약한 URL 플레이어와 같을 때만 시즌 합계를 쓴다. */
export function seasonOverviewForResult(
  summary: StatsStoredSeasonSummary | undefined,
  result: { nickname: string; seasons: readonly { id: string; name: string }[] },
): StatsSeasonOverview | null {
  if (!summary || normalizeName(summary.nickname) !== normalizeName(result.nickname)) return null;
  return { ...summary, seasonName: result.seasons.find((season) => season.id === summary.seasonId)?.name ?? null };
}

// 최근 20경기 요약과 구분되도록 시즌 전체 합계임을 제목에 밝힌다. 모바일에서도 보인다.
export function StatsSeasonOverviewCard({ season }: StatsSeasonOverviewCardProps) {
  if (!season) return null;
  return (
    <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="이번 시즌 전체">
      <h2 className="text-base font-black text-white">이번 시즌 전체</h2>
      <p className="mt-1 text-[11px] leading-5 text-white/50">
        {season.seasonName ?? "최근 시즌"}의 경쟁전·일반전, 솔로·듀오·스쿼드를 모두 합친 기록입니다.
      </p>
      <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-white/10 pt-3 text-center">
        <div><dt className="text-[10px] font-bold text-white/50">경기</dt><dd className="text-sm font-black text-white">{season.rounds}</dd></div>
        <div><dt className="text-[10px] font-bold text-white/50">평균 딜량</dt><dd className="text-sm font-black text-white">{season.avgDamage}</dd></div>
        <div><dt className="text-[10px] font-bold text-white/50">경기당 킬</dt><dd className="text-sm font-black text-white">{season.killsPerRound}</dd></div>
        <div><dt className="text-[10px] font-bold text-white/50">우승</dt><dd className="text-sm font-black text-white">{season.wins}</dd></div>
      </dl>
    </section>
  );
}
