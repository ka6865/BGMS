"use client";

import type { RecentMapOverviewRow } from "@/lib/stats/recentMapOverview";

export interface StatsMapOverviewCardProps {
  rows: readonly RecentMapOverviewRow[];
}

export function StatsMapOverviewCard({ rows }: StatsMapOverviewCardProps) {
  if (!rows.length) return null;
  return (
    <section className="hidden rounded-2xl border border-white/10 bg-[#161616] p-5 lg:block lg:w-[320px] lg:shrink-0" aria-label="맵별 성적">
      <h2 className="text-base font-black text-white">맵별 성적</h2>
      <p className="mt-1 text-[11px] leading-5 text-white/50">최근 20경기 요약과 같은 배틀로얄 기록 기준입니다.</p>
      <table className="mt-3 w-full table-fixed border-t border-white/10 text-right text-xs">
        <thead>
          <tr className="text-[10px] font-bold text-white/50">
            <th scope="col" className="w-[30%] py-2 text-left font-bold">맵</th>
            <th scope="col" className="py-2 font-bold">경기</th>
            <th scope="col" className="py-2 font-bold">평균 순위</th>
            <th scope="col" className="py-2 font-bold">TOP 10</th>
            <th scope="col" className="py-2 font-bold">평균 피해</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.mapName} data-testid="map-overview-row" className="border-t border-white/5 font-bold text-white/80">
              <th scope="row" className="truncate py-2 text-left font-black text-white">{row.mapName}</th>
              <td className="py-2">{row.games}</td>
              <td className="py-2">{row.averageRank}</td>
              <td className="py-2">{row.top10Rate}</td>
              <td className="py-2">{row.averageDamage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
