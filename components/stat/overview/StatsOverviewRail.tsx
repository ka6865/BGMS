"use client";

import type { RecentMatchOverview, RecentMatchOverviewInput } from "@/lib/stats/recentMatchOverview";

export interface StatsOverviewRailProps {
  summary: RecentMatchOverview;
  status: RecentMatchOverviewInput["summaryStatus"];
}

function Metric({ testId, label, value }: { testId: string; label: string; value: string | number | null }) {
  return (
    <div className="min-w-0 py-2">
      <div data-testid={testId} className="truncate text-xl font-black text-white">{value ?? "—"}</div>
      <div className="mt-1 text-[11px] font-bold text-white/50">{label}</div>
    </div>
  );
}

export function StatsOverviewRail({ summary, status }: StatsOverviewRailProps) {
  const missingCount = summary.requestedCount - summary.loadedCount;
  const modeCounts = [
    summary.counts.ranked ? `경쟁전 ${summary.counts.ranked}경기` : null,
    summary.counts.normal ? `일반전 ${summary.counts.normal}경기` : null,
    summary.counts.casual ? `캐주얼 ${summary.counts.casual}경기` : null,
  ].filter(Boolean).join(" · ");
  return (
    <section className="rounded-2xl border border-white/10 bg-[#161616] p-5 lg:w-[320px] lg:shrink-0" aria-label="최근 20경기 요약">
      <h2 className="text-base font-black text-white">최근 20경기 요약</h2>
      <p className="mt-2 text-xs leading-5 text-white/55">
        최근 최대 20경기 중 확인된 배틀로얄 기록을 모았습니다. 시즌 선택이나 목록 페이지를 바꿔도 같은 최근 경기 기준입니다.
      </p>
      <div className="mt-3 text-xs font-bold leading-5 text-indigo-200" role="status">
        {summary.matchCount > 0 ? `${summary.matchCount}경기 집계 · ${modeCounts}` : (
          !summary.requestedCount ? "최근 경기 기록이 없습니다." :
          status === "loading" || status === "idle" ? "최근 경기 기록을 불러오는 중입니다." :
          status === "error" ? "최근 경기 기록을 불러오지 못했습니다." : "집계 가능한 배틀로얄 기록이 없습니다."
        )}
      </div>
      {missingCount > 0 && summary.matchCount > 0 && (
        <p className="mt-1 text-xs leading-5 text-amber-200/80">
          {summary.requestedCount}경기 중 {summary.loadedCount}경기 조회됨 · {missingCount}경기 {status === "loading" ? "불러오는 중" : "미확인"}
        </p>
      )}
      {summary.excludedCount > 0 && (
        <p className="mt-1 text-xs leading-5 text-white/45">데스매치·유형 미확인 등 {summary.excludedCount}경기는 집계에서 제외했습니다.</p>
      )}
      {summary.matchCount > 0 && <>
        <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 border-t border-white/10 pt-2 md:grid-cols-4 lg:grid-cols-2">
          <Metric testId="wins" label="승리" value={summary.wins} />
          <Metric testId="win-rate" label="승률" value={summary.winRate} />
          <Metric testId="kills" label="총 킬" value={summary.kills} />
          <Metric testId="average-damage" label="경기당 평균 피해량" value={summary.averageDamage} />
          <Metric testId="assists" label="총 어시스트" value={summary.assists} />
          <Metric testId="dbnos" label="총 기절" value={summary.dbnos} />
          <Metric testId="top10-rate" label="TOP 10 비율" value={summary.top10Rate} />
          <Metric testId="average-rank" label="평균 순위" value={summary.averageRank} />
        </div>
        <p className="mt-3 border-t border-white/10 pt-3 text-[11px] leading-5 text-white/45">
          킬·어시스트·기절은 합계, 피해량·순위는 경기당 평균입니다. 일부 경기의 항목 정보가 없으면 —로 표시합니다.
        </p>
      </>}
    </section>
  );
}
