"use client";

import { StatsMapOverviewCard } from "@/components/stat/overview/StatsMapOverviewCard";
import { StatsOverviewRail } from "@/components/stat/overview/StatsOverviewRail";
import { buildRecentMapOverview } from "@/lib/stats/recentMapOverview";
import { buildRecentMatchOverview, type RecentMatchOverviewInput } from "@/lib/stats/recentMatchOverview";

export type StatSummaryPanelProps = RecentMatchOverviewInput;

export function StatSummaryPanel(props: StatSummaryPanelProps) {
  return (
    <div className="flex w-full flex-col gap-3 lg:w-[320px] lg:shrink-0">
      <StatsOverviewRail summary={buildRecentMatchOverview(props)} status={props.summaryStatus} />
      <StatsMapOverviewCard rows={buildRecentMapOverview(props)} />
    </div>
  );
}
