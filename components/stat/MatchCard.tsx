"use client";

import { useEffect, useState } from "react";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type { MatchData } from "@/types/stat";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { isMatchOlderThan14Days } from "@/components/stat/matchExpiryHelper";
import { CompactMatchRow } from "@/components/stat/matches/CompactMatchRow";
import { ExpandedMatchDetails } from "@/components/stat/matches/ExpandedMatchDetails";
import type { StatsPlatform } from "@/types/stats-page";

export interface MatchCardProps {
  matchId: string;
  nickname: string;
  platform: StatsPlatform;
  isMobile: boolean;
  index?: number;
  initialMatchData?: MatchSummaryData;
  onNicknameClick?(nickname: string): void;
  onModeDetected?(matchId: string, gameMode: string, matchType?: string, mapName?: string): void;
  onFailure?(reason: "detail_failed" | "analysis_failed"): void;
  onRecovery?(reason: "detail_failed" | "analysis_failed"): void;
}

interface MatchCardExpansionState {
  identity: string;
  isExpanded: boolean;
  hasExpandedOnce: boolean;
}

function matchOwnerIdentity(platform: StatsPlatform, nickname: string, matchId: string) {
  return `${platform}:${normalizeName(nickname)}:${matchId}`;
}

export function MatchCard(props: MatchCardProps) {
  const {
    matchId,
    nickname,
    platform,
    initialMatchData,
    onModeDetected,
  } = props;
  const identity = matchOwnerIdentity(platform, nickname, matchId);
  const [expansion, setExpansion] = useState<MatchCardExpansionState>({
    identity,
    isExpanded: false,
    hasExpandedOnce: false,
  });
  const [detailData, setDetailData] = useState<MatchData | null>(null);
  const isCurrent = expansion.identity === identity;
  const isExpanded = isCurrent && expansion.isExpanded;
  const hasExpandedOnce = isCurrent && expansion.hasExpandedOnce;
  const matchDate = (initialMatchData as (MatchSummaryData & { playedAt?: string }) | undefined)?.playedAt
    || initialMatchData?.createdAt
    || initialMatchData?.matchInfo?.date
    || "";
  const isHistoricalSummary = Boolean(initialMatchData && isMatchOlderThan14Days(matchDate));
  const summaryGameMode = initialMatchData?.gameMode || initialMatchData?.matchInfo?.mode || "";
  const summaryMatchType = initialMatchData?.matchType;
  const summaryMapName = initialMatchData?.mapName;
  const hasInitialSummary = Boolean(initialMatchData);

  useEffect(() => {
    setDetailData(null);
  }, [identity]);

  const displaySummary = initialMatchData && detailData
    ? {
        ...initialMatchData,
        ...detailData,
        stats: detailData.stats,
        isSummary: false,
      } as MatchSummaryData
    : initialMatchData;

  useEffect(() => {
    if (!hasInitialSummary) return;
    onModeDetected?.(matchId, summaryGameMode, summaryMatchType, summaryMapName);
  }, [hasInitialSummary, matchId, onModeDetected, summaryGameMode, summaryMapName, summaryMatchType]);

  const handleToggle = () => {
    setExpansion((current) => current.identity === identity
      ? { ...current, isExpanded: !current.isExpanded, hasExpandedOnce: true }
      : { identity, isExpanded: true, hasExpandedOnce: true });
  };

  const expanded = hasExpandedOnce && !isHistoricalSummary ? (
    <div
      data-testid="expanded-match-details"
      hidden={!isExpanded}
      aria-hidden={!isExpanded}
    >
      <ExpandedMatchDetails
        key={identity}
        matchId={matchId}
        nickname={nickname}
        platform={platform}
        summary={initialMatchData}
        onNicknameClick={props.onNicknameClick}
        onModeDetected={onModeDetected}
        onDetailReady={setDetailData}
        onFailure={props.onFailure}
        onRecovery={props.onRecovery}
      />
    </div>
  ) : null;

  if (!initialMatchData) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#161616] p-3">
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "매치 상세 접기" : "매치 상세 불러오기"}
          onClick={handleToggle}
          className="min-h-11 w-full rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-black text-white/60"
        >
          {isExpanded ? "매치 상세 접기" : "매치 상세 불러오기"}
        </button>
        {expanded}
      </div>
    );
  }

  return (
    <div className="min-w-0" data-match-card-identity={identity}>
      <CompactMatchRow
        summary={displaySummary!}
        isExpanded={isExpanded}
        isMobile={props.isMobile}
        onToggle={handleToggle}
      />
      {hasExpandedOnce && isHistoricalSummary && (
        <div
          data-testid="expanded-match-details"
          hidden={!isExpanded}
          aria-hidden={!isExpanded}
          className="rounded-b-2xl border border-t-0 border-sky-500/20 bg-sky-500/10 p-4 text-sm font-bold text-sky-200"
        >
          14일이 경과된 과거 전적입니다. 보존된 순위, 킬, 피해량, 맵 요약을 확인할 수 있습니다.
        </div>
      )}
      {expanded}
    </div>
  );
}
