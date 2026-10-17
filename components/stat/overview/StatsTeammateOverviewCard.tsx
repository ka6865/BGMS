"use client";

import type { RecentTeammateOverviewRow } from "@/lib/stats/recentTeammateOverview";

export interface StatsTeammateOverviewCardProps {
  rows: readonly RecentTeammateOverviewRow[];
}

export function StatsTeammateOverviewCard({ rows }: StatsTeammateOverviewCardProps) {
  if (!rows.length) return null;
  return (
    <section className="hidden rounded-2xl border border-white/10 bg-[#161616] p-5 lg:block lg:w-[320px] lg:shrink-0" aria-label="함께한 팀원">
      <h2 className="text-base font-black text-white">함께한 팀원</h2>
      <p className="mt-1 text-[11px] leading-5 text-white/50">최근 20경기에서 2경기 이상 같은 팀이었던 플레이어입니다.</p>
      <table className="mt-3 w-full table-fixed border-t border-white/10 text-right text-xs">
        <thead>
          <tr className="text-[10px] font-bold text-white/50">
            <th scope="col" className="w-[55%] py-2 text-left font-bold">닉네임</th>
            <th scope="col" className="py-2 font-bold">경기</th>
            <th scope="col" className="py-2 font-bold">평균 순위</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} data-testid="teammate-overview-row" className="border-t border-white/5 font-bold text-white/80">
              <th scope="row" className="truncate py-2 text-left font-black text-white">{row.name}</th>
              <td className="py-2">{row.games}</td>
              <td className="py-2">{row.averageRank ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
