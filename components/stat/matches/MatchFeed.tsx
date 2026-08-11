"use client";

import { Fragment } from "react";
import { ResponsiveAdSlot } from "@/components/ads/ResponsiveAdSlot";
import { MatchCard } from "@/components/stat/MatchCard";
import {
  getStatsFeedSlots,
  statsAdPlacements,
  type AdViewportClass,
  type StatsAdRegistry,
} from "@/lib/ads/statsAdPlacements";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { filterRenderableMatches } from "@/lib/stats/statsPageModel";
import type {
  StatsMatchFilter,
  StatsMatchModeMeta,
  StatsPartialReason,
  StatsPlatform,
} from "@/types/stats-page";

export interface MatchFeedProps {
  matchIds: readonly string[];
  summaries: Record<string, MatchSummaryData>;
  missingMatchIds: ReadonlySet<string>;
  matchModeMeta: Record<string, StatsMatchModeMeta>;
  summaryStatus: "idle" | "loading" | "ready" | "error";
  filter: StatsMatchFilter;
  viewportClass: AdViewportClass;
  nickname: string;
  platform: StatsPlatform;
  placements?: StatsAdRegistry;
  onFilterChange(value: StatsMatchFilter): void;
  onRetrySummaries(): void;
  onNicknameClick(name: string): void;
  onModeDetected(matchId: string, gameMode: string, matchType?: string, mapName?: string): void;
  onFailure?(reason: Extract<StatsPartialReason, "detail_failed" | "analysis_failed">, sourceId: string): void;
  onRecovery?(reason: Extract<StatsPartialReason, "detail_failed" | "analysis_failed">, sourceId: string): void;
}

const FILTERS: readonly { value: StatsMatchFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "normal", label: "일반전" },
  { value: "ranked", label: "경쟁전" },
  { value: "casual", label: "캐주얼" },
  { value: "tdm", label: "TDM" },
];

const EMPTY_MESSAGES: Record<StatsMatchFilter, string> = {
  all: "최근 14일 이내에 플레이한 매치 기록이 없습니다.",
  normal: "최근 14일 이내에 플레이한 일반전 기록이 없습니다.",
  ranked: "최근 14일 이내에 플레이한 경쟁전(랭크전) 기록이 없습니다.",
  casual: "최근 14일 이내에 플레이한 캐주얼 모드 기록이 없습니다.",
  tdm: "최근 14일 이내에 플레이한 팀 데스매치(TDM) 기록이 없습니다.",
};

function overlayModeMeta(summary: MatchSummaryData, meta?: StatsMatchModeMeta): MatchSummaryData {
  if (!meta) return summary;
  return {
    ...summary,
    gameMode: meta.gameMode ?? summary.gameMode,
    matchType: meta.matchType ?? summary.matchType,
    mapName: meta.mapName ?? summary.mapName,
  };
}

export function MatchFeed({
  matchIds,
  summaries,
  missingMatchIds,
  matchModeMeta,
  summaryStatus,
  filter,
  viewportClass,
  nickname,
  platform,
  placements = statsAdPlacements,
  onFilterChange,
  onRetrySummaries,
  onNicknameClick,
  onModeDetected,
  onFailure,
  onRecovery,
}: MatchFeedProps) {
  const availableMatches = matchIds.flatMap((matchId) => {
    if (missingMatchIds.has(matchId)) return [];
    const value = summaries[matchId];
    return value ? [overlayModeMeta(value, matchModeMeta[matchId])] : [];
  });
  const renderableMatches = filterRenderableMatches(availableMatches, new Set<string>(), filter);
  const slots = getStatsFeedSlots({
    placements,
    viewportClass,
    renderableMatchCount: renderableMatches.length,
  });

  return (
    <section aria-label="최근 매치" className="min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-lg font-black text-white">최근 매치 <span className="text-xs text-white/40">(최대 20게임)</span></h3>
        <div role="group" aria-label="매치 유형 필터" className="flex gap-1 rounded-xl bg-white/5 p-1">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => onFilterChange(item.value)}
              className={`min-h-11 rounded-lg px-3 text-xs font-black ${filter === item.value ? "bg-indigo-600 text-white" : "text-white/50"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {summaryStatus === "error" && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
          <span className="text-sm font-bold text-red-200">최근 매치 요약을 불러오지 못했습니다.</span>
          <button type="button" onClick={onRetrySummaries} className="min-h-11 rounded-lg px-3 text-xs font-black text-red-100">
            매치 요약 다시 시도
          </button>
        </div>
      )}

      {summaryStatus === "loading" ? (
        <div role="status" aria-label="최근 매치 요약 로딩" className="space-y-2">
          {matchIds.slice(0, Math.min(3, matchIds.length)).map((matchId) => (
            <div key={matchId} data-match-skeleton className="h-24 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
          ))}
        </div>
      ) : renderableMatches.length > 0 ? (
        <div className="space-y-2">
          {renderableMatches.map((summary, index) => {
            const sourceId = `match:${summary.matchId}`;
            const afterMatchCount = index + 1;
            const afterSlots = slots.filter((slot) => slot.afterMatchCount === afterMatchCount);
            return (
              <Fragment key={`${platform}:${nickname.trim().toLowerCase()}:${summary.matchId}`}>
                <div data-feed-sequence={summary.matchId}>
                  <MatchCard
                    matchId={summary.matchId}
                    nickname={nickname}
                    platform={platform}
                    isMobile={viewportClass === "mobile"}
                    initialMatchData={summary}
                    onNicknameClick={onNicknameClick}
                    onModeDetected={onModeDetected}
                    onFailure={(reason) => onFailure?.(reason, sourceId)}
                    onRecovery={(reason) => onRecovery?.(reason, sourceId)}
                  />
                </div>
                {afterSlots.map((slot) => (
                  <div
                    key={slot.placement}
                    className={`stats-feed-ad-sequence stats-ad-slot--${slot.reservationVisibility}`}
                    data-feed-sequence={`ad-${slot.placement}`}
                    data-feed-ad-after={slot.afterMatchCount}
                    data-feed-ad-visibility={slot.reservationVisibility}
                  >
                    <ResponsiveAdSlot
                      placement={slot.placement}
                      viewportClass={viewportClass}
                      renderableMatchCount={renderableMatches.length}
                    />
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/5 bg-white/3 p-10 text-center text-xs font-bold text-white/40">
          {EMPTY_MESSAGES[filter]}
        </div>
      )}
    </section>
  );
}
