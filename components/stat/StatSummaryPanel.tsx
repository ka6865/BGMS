"use client";

import type { AiSummarySnapshot } from "@/components/stat/RecentAISummary";
import { StatsOverviewRail } from "@/components/stat/overview/StatsOverviewRail";
import type {
  PlayerStatsResponse,
  StatsMode,
  StatsOverviewMetrics,
  StatsPartySize,
} from "@/types/stats-page";

export interface StatSummaryPanelProps {
  stats: PlayerStatsResponse["stats"];
  statsAvailability?: PlayerStatsResponse["statsAvailability"];
  mode: StatsMode;
  partySize: StatsPartySize;
  aiSummary: AiSummarySnapshot | null;
  aiExpanded: boolean;
  onAiToggle(): void;
}

function getSelectedOverviewMetrics(
  stats: PlayerStatsResponse["stats"],
  statsAvailability: PlayerStatsResponse["statsAvailability"],
  mode: StatsMode,
  partySize: StatsPartySize,
): StatsOverviewMetrics {
  const availability = statsAvailability?.[mode];
  if (availability?.status === "unavailable") {
    return {
      kind: "unavailable",
      label: "조회 불가",
      message: "이 모드 전적을 조회하지 못해 현재 수치를 표시할 수 없습니다.",
      availability,
    };
  }

  const bucket = stats[mode]?.[partySize];
  if (!bucket || bucket.roundsPlayed <= 0) {
    return availability ? { kind: "empty", label: "기록 없음", availability } : { kind: "empty", label: "기록 없음" };
  }

  const deaths = bucket.deaths ?? bucket.losses ?? 0;
  const top10 = bucket.top10Ratio != null
    ? bucket.top10Ratio * 100
    : ((bucket.top10s ?? 0) / bucket.roundsPlayed) * 100;
  const metrics: Extract<StatsOverviewMetrics, { kind: "ready" }> = {
    kind: "ready",
    roundsPlayed: bucket.roundsPlayed,
    kda: ((bucket.kills + bucket.assists) / (deaths || 1)).toFixed(2),
    averageDamage: (bucket.damageDealt / bucket.roundsPlayed).toFixed(0),
    top10Rate: `${top10.toFixed(1)}%`,
    kills: bucket.kills,
    assists: bucket.assists,
    dbnos: bucket.dBNOs,
    averageRank: bucket.avgRank != null && bucket.avgRank > 0 ? bucket.avgRank.toFixed(1) : "—",
    preferredMode: partySize,
  };
  return availability ? { ...metrics, availability } : metrics;
}

export function StatSummaryPanel({
  stats,
  statsAvailability,
  mode,
  partySize,
  aiSummary,
  aiExpanded,
  onAiToggle,
}: StatSummaryPanelProps) {
  const metrics = getSelectedOverviewMetrics(stats, statsAvailability, mode, partySize);
  return (
    <div className="flex w-full flex-col gap-3 lg:w-[320px] lg:shrink-0">
      <StatsOverviewRail
        metrics={metrics}
        aiSummary={aiSummary}
        aiExpanded={aiExpanded}
        onAiToggle={onAiToggle}
      />
    </div>
  );
}
