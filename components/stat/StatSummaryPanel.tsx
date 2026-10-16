"use client";

import { StatsMapOverviewCard } from "@/components/stat/overview/StatsMapOverviewCard";
import { StatsOverviewRail } from "@/components/stat/overview/StatsOverviewRail";
import { StatsSessionOverviewCard } from "@/components/stat/overview/StatsSessionOverviewCard";
import { StatsTeammateOverviewCard } from "@/components/stat/overview/StatsTeammateOverviewCard";
import { buildRecentMapOverview } from "@/lib/stats/recentMapOverview";
import { buildRecentMatchOverview, type RecentMatchOverviewInput } from "@/lib/stats/recentMatchOverview";
import { buildRecentSessionOverview } from "@/lib/stats/recentSessionOverview";
import { buildRecentTeammateOverview } from "@/lib/stats/recentTeammateOverview";

export type StatSummaryPanelProps = RecentMatchOverviewInput;

export function StatSummaryPanel(props: StatSummaryPanelProps) {
  return (
    <div className="flex w-full flex-col gap-3 lg:w-[320px] lg:shrink-0">
      <StatsOverviewRail summary={buildRecentMatchOverview(props)} status={props.summaryStatus} />
      {/* 맵별 성적·최근 세션·함께한 팀원은 데스크톱 왼쪽 열을 채운다. 모바일은 경기 목록이 먼저 보이도록 표시하지 않는다. */}
      <StatsMapOverviewCard rows={buildRecentMapOverview(props)} />
      <StatsSessionOverviewCard session={buildRecentSessionOverview(props)} />
      <StatsTeammateOverviewCard rows={buildRecentTeammateOverview(props)} />
    </div>
  );
}
