// 파일 위치: components/stat/layout/StatsPageShell.tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { StatSummaryPanel } from "@/components/stat/StatSummaryPanel";
import { RecentAISummary, type AiSummarySnapshot } from "@/components/stat/RecentAISummary";
import SquadAnalysisPanel from "@/components/stat/SquadAnalysisPanel";
import { Shield, ChevronDown } from "lucide-react";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { useAuth } from "@/components/AuthProvider";
import { useRouter } from "next/navigation";
import { useStatsPageController } from "@/hooks/useStatsPageController";
import { useStatsAutocomplete } from "@/hooks/useStatsAutocomplete";
import { useStatsProfilePrefill } from "@/hooks/useStatsProfilePrefill";
import { useStatsSearchHistory } from "@/hooks/useStatsSearchHistory";
import { StatsSearchBar } from "@/components/stat/search/StatsSearchBar";
import { StatsLandingState } from "@/components/stat/search/StatsLandingState";
import { PlayerProfileHeader } from "@/components/stat/profile/PlayerProfileHeader";
import { StatsSectionTabs } from "@/components/stat/overview/StatsSectionTabs";
import { MatchFeed } from "@/components/stat/matches/MatchFeed";
import { ResponsiveAdSlot } from "@/components/ads/ResponsiveAdSlot";
import { StatsPageStates } from "./StatsPageStates";
import { buildStatsCompareUrl, buildStatsWeaponsUrl } from "@/lib/stats/statsPageModel";
import type { StatsPlatform, StatsSectionTab } from "@/types/stats-page";
import { useAdViewportClass } from "@/hooks/useAdViewportClass";
import { StatsManualAdRails } from "@/components/ads/StatsManualAdRails";
// import CompanionEntryCard from "@/components/overwolf/CompanionEntryCard";

const NAVIGATION_PENDING_TIMEOUT_MS = 1_000;
const SEARCH_COOLDOWN_MS = 3_000;

export interface StatsPageShellProps {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
}

interface StatsSearchIntent {
  nickname: string;
  platform: StatsPlatform;
  seasonId: string;
  forceRefresh: boolean;
}

interface IdentityOwnedAiState {
  identity: string;
  summary: AiSummarySnapshot | null;
  expanded: boolean;
}

/** 전적 검색 메인 컴포넌트 */
export function StatsPageShell({
  initialPlatform,
  initialNickname,
  initialTab,
  initialGroupKey,
}: StatsPageShellProps) {
  const router = useRouter();
  const controller = useStatsPageController({
    initialPlatform,
    initialNickname,
    initialTab,
    initialGroupKey,
  });
  const {
    status,
    result,
    error: controllerError,
    suggestedPlayers: suggestedUsers,
    platform,
    nickname,
    seasonId: selectedSeason,
    sectionTab: activeTab,
    matchFilter: matchTab,
    groupKey,
    matchSummaries,
    missingMatchIds,
    matchModeMeta,
    summaryStatus,
    matchIds,
    historyStatus,
    historyPage,
    historyTotalPages,
    refreshAvailableAt,
    isRefreshCoolingDown: isCoolingDown,
    statsMode,
    partySize,
    setPlatform,
    setNickname,
    setSectionTab: setActiveTab,
    setStatsMode,
    setPartySize,
    setMatchFilter: setMatchTab,
    setGroupKey,
    search,
    retrySummaries,
    setHistoryPage,
    retryHistory,
    onModeDetected: handleModeDetected,
    reportPartial,
    clearPartial,
  } = controller;
  const loading = status === "loading" || status === "refreshing";
  const refreshing = status === "refreshing";
  const viewportClass = useAdViewportClass();

  const handleMatchFilterChange = useCallback((value: typeof matchTab) => {
    setMatchTab(value);
    if (value !== matchTab) void setHistoryPage(1);
  }, [matchTab, setHistoryPage, setMatchTab]);

  const { user } = useAuth();
  const [cooldown, setCooldown] = useState(false);
  const isSearchingRef = useRef(false);
  const cooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationPendingRef = useRef(false);
  const navigationPendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [navigationPending, setNavigationPending] = useState(false);
  const userEditedRef = useRef(false);
  const recordedResultRef = useRef<string | null>(null);
  const lastSearchIntentRef = useRef<StatsSearchIntent | null>(null);
  const [releasedRetryAt, setReleasedRetryAt] = useState<number>();
  const isMobile = viewportClass === "mobile";
  const {
    recentSearches,
    favorites,
    addRecent,
    toggleFavorite: toggleStoredFavorite,
    removeRecent,
  } = useStatsSearchHistory();
  const autocomplete = useStatsAutocomplete(nickname);
  const profilePrefill = useStatsProfilePrefill(user?.id);

  const handleControllerSearch = useCallback(async (
    targetSeason?: string,
    overrideNickname?: string,
    overridePlatform?: string,
    forceApiRefresh = false,
    bypassCooldown = false
  ) => {
    const rawResolvedSeason = targetSeason ?? selectedSeason;
    const resolvedSeason = rawResolvedSeason && rawResolvedSeason !== "null" && rawResolvedSeason !== "undefined"
      ? rawResolvedSeason
      : "";
    const searchName = overrideNickname || nickname;
    const searchPlatform: StatsPlatform = (overridePlatform || platform) === "kakao" ? "kakao" : "steam";
    if (!searchName.trim() || (!bypassCooldown && cooldown)) return;
    if (isSearchingRef.current) return;
    isSearchingRef.current = true;
    setCooldown(true);

    const intent: StatsSearchIntent = {
      nickname: searchName,
      platform: searchPlatform,
      seasonId: resolvedSeason,
      forceRefresh: forceApiRefresh,
    };
    lastSearchIntentRef.current = intent;

    try {
      await search(intent);
    } finally {
      isSearchingRef.current = false;
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      cooldownTimeoutRef.current = setTimeout(() => setCooldown(false), SEARCH_COOLDOWN_MS);
    }
  }, [cooldown, nickname, platform, search, selectedSeason]);

  const navigateToPlayer = useCallback((
    name: string,
    targetPlatform = platform,
    respectSubmitGuard = true,
  ) => {
    const normalized = name.trim();
    if (
      !normalized || navigationPendingRef.current ||
      (respectSubmitGuard && (loading || cooldown))
    ) return;
    navigationPendingRef.current = true;
    setNavigationPending(true);
    if (navigationPendingTimeoutRef.current) clearTimeout(navigationPendingTimeoutRef.current);
    navigationPendingTimeoutRef.current = setTimeout(() => {
      navigationPendingTimeoutRef.current = null;
      navigationPendingRef.current = false;
      setNavigationPending(false);
    }, NAVIGATION_PENDING_TIMEOUT_MS);
    router.push(`/stats/${targetPlatform}/${encodeURIComponent(normalized)}`);
  }, [cooldown, loading, platform, router]);

  useEffect(() => {
    lastSearchIntentRef.current = null;
    if (navigationPendingTimeoutRef.current) {
      clearTimeout(navigationPendingTimeoutRef.current);
      navigationPendingTimeoutRef.current = null;
    }
    navigationPendingRef.current = false;
    setNavigationPending(false);
  }, [initialNickname, initialPlatform]);

  useEffect(() => {
    return () => {
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      if (navigationPendingTimeoutRef.current) clearTimeout(navigationPendingTimeoutRef.current);
    };
  }, []);

  const retryAt = controllerError?.type === "rate_limit" ? controllerError.retryAt : undefined;
  useEffect(() => {
    if (!retryAt) return;
    const remaining = Math.max(0, retryAt - Date.now());
    const timeout = setTimeout(() => setReleasedRetryAt(retryAt), remaining);
    return () => clearTimeout(timeout);
  }, [retryAt]);

  useEffect(() => {
    if (
      initialNickname || status !== "idle" || userEditedRef.current || nickname ||
      !profilePrefill.loaded || !profilePrefill.nickname
    ) return;
    setNickname(profilePrefill.nickname);
    setPlatform(profilePrefill.platform ?? "steam");
  }, [
    initialNickname,
    nickname,
    profilePrefill.loaded,
    profilePrefill.nickname,
    profilePrefill.platform,
    setNickname,
    setPlatform,
    status,
  ]);

  const resultPlatform = result?.platform ?? "";
  const resultNickname = result?.nickname ?? "";
  const resultIdentity = result ? `${resultPlatform}:${resultNickname}` : "";
  useEffect(() => {
    if (!resultIdentity || recordedResultRef.current === resultIdentity) return;
    recordedResultRef.current = resultIdentity;
    addRecent(resultNickname);
  }, [addRecent, resultIdentity, resultNickname]);

  const toggleFavorite = (name: string) => toggleStoredFavorite(name);

  const [showGuideline, setShowGuideline] = useState(false);
  const aiIdentity = result
    ? `${result.platform}\u001f${result.nickname}\u001f${result.recentMatches.join("\u001e")}`
    : "";
  const [aiState, setAiState] = useState<IdentityOwnedAiState | null>(null);
  const aiSummary = aiState?.identity === aiIdentity ? aiState.summary : null;
  const aiExpanded = aiState?.identity === aiIdentity ? aiState.expanded : false;
  const handleAiSummaryChange = useCallback((summary: AiSummarySnapshot | null) => {
    setAiState((previous) => ({
      identity: aiIdentity,
      summary,
      expanded: summary && previous?.identity === aiIdentity ? previous.expanded : false,
    }));
  }, [aiIdentity]);
  const handleAiToggle = useCallback(() => {
    setAiState((previous) => previous?.identity === aiIdentity
      ? { ...previous, expanded: !previous.expanded }
      : { identity: aiIdentity, summary: null, expanded: false });
  }, [aiIdentity]);
  const handleRetry = useCallback(() => {
    const fallbackPlatform: StatsPlatform = initialPlatform === "kakao" ? "kakao" : "steam";
    const fallbackNickname = initialNickname?.trim() ?? "";
    const intent = lastSearchIntentRef.current ?? (fallbackNickname
      ? {
          nickname: fallbackNickname,
          platform: fallbackPlatform,
          seasonId: selectedSeason,
          forceRefresh: false,
        }
      : null);
    if (!intent) return;
    void handleControllerSearch(
      intent.seasonId,
      intent.nickname,
      intent.platform,
      intent.forceRefresh,
    );
  }, [handleControllerSearch, initialNickname, initialPlatform, selectedSeason]);

  const routeBooting = !result && status === "idle" && Boolean(initialNickname?.trim());
  const routeLoading = routeBooting || navigationPending;
  const showTopAd = Boolean(result) || (!routeLoading && status === "idle");
  const retryRateLimited = Boolean(retryAt && releasedRetryAt !== retryAt);
  const retryDisabled = loading || cooldown || navigationPending || retryRateLimited;

  return (
    <section
      className="stats-page stats-auto-ads-excluded pb-safe-nav w-full text-white"
       data-testid="stats-auto-ads-boundary"
       {...({ "google-side-rail-overlap": "false" } as Record<string, string>)}
     >
       {result && (
         <StatsManualAdRails />
       )}
       <h1 className="mb-5 text-center text-2xl/8 font-bold text-[#F2A900]">
        <InlineIconLabel icon="activity" iconSize={24} className="justify-center">AI 전적 검색</InlineIconLabel>
      </h1>

      <StatsSearchBar
        platform={platform}
        nickname={nickname}
        recentSearches={recentSearches}
        favorites={favorites}
        suggestions={autocomplete.suggestions}
        suggesting={autocomplete.suggesting}
        empty={autocomplete.empty}
        submitDisabled={!nickname.trim() || loading || cooldown || navigationPending}
        submitLabel={loading ? "검색중..." : cooldown ? "쿨타임" : "검색"}
        onPlatformChange={setPlatform}
        onNicknameChange={(value) => {
          userEditedRef.current = true;
          setNickname(value);
        }}
        onSubmit={() => navigateToPlayer(nickname)}
        onQuickSearch={(name) => navigateToPlayer(name)}
        onSuggestionSelect={(suggestion) => navigateToPlayer(suggestion.nickname, suggestion.platform)}
        onFavoriteToggle={toggleStoredFavorite}
        onRecentRemove={removeRecent}
      />

      <StatsPageStates
        status={status}
        error={controllerError}
        suggestedPlayers={suggestedUsers}
        hasResult={Boolean(result)}
        routeBooting={routeLoading}
        retryDisabled={retryDisabled}
        onRetry={handleRetry}
        onSuggestedPlayer={(player) => navigateToPlayer(player.nickname, player.platform)}
      />

      {/* [Empty State V1.0] 결과 없음 + 로딩/에러 아님 → 유저 상태별 분기 화면 */}
      {!result && status === "idle" && !routeLoading && (
        <StatsLandingState
          onCompare={() => router.push("/stats/battle")}
          authenticated={Boolean(user)}
          profileLoaded={profilePrefill.loaded}
          hasRegisteredNickname={Boolean(profilePrefill.nickname)}
        />
      )}

      {!result && showTopAd && (
        <ResponsiveAdSlot placement="stats-top" viewportClass={viewportClass} />
      )}

      {result && (
        <div className="relative flex w-full flex-col gap-2 md:gap-4">
          <PlayerProfileHeader
            player={result}
            seasonId={selectedSeason}
            refreshing={refreshing}
            isRefreshCoolingDown={isCoolingDown}
            refreshAvailableAt={refreshAvailableAt}
            favorite={favorites.includes(result.nickname)}
            onSeasonChange={(value) => {
              void handleControllerSearch(value, result.nickname, result.platform, false, true);
            }}
            onRefresh={() => {
              void handleControllerSearch(selectedSeason, result.nickname, result.platform, true);
            }}
            onFavoriteToggle={() => toggleFavorite(result.nickname)}
            onCompare={() => router.push(buildStatsCompareUrl(result.nickname, result.platform))}
            onWeapons={() => router.push(buildStatsWeaponsUrl(result.nickname, result.platform))}
            statsMode={statsMode}
            onStatsModeChange={setStatsMode}
            partySize={partySize}
            onPartySizeChange={setPartySize}
          />

          <ResponsiveAdSlot placement="stats-top" viewportClass={viewportClass} />

          {/* 탭 네비게이션 */}
          <StatsSectionTabs value={activeTab} onChange={setActiveTab} />

          {activeTab === "overview" ? (
            <div className="flex flex-col gap-2 md:gap-4">

              <div role="region" aria-label="AI 분석" tabIndex={-1}>
                {result.recentMatches.length > 0 ? (
                  <RecentAISummary
                    matchIds={result.recentMatches}
                    nickname={result.nickname}
                    platform={result.platform}
                    isMobile={isMobile}
                    onSummaryChange={handleAiSummaryChange}
                  />
                ) : (
                  <p
                    role="status"
                    aria-label="AI 분석할 최근 매치 없음"
                    className="rounded-2xl border border-white/10 bg-[#161616] p-5 text-center text-sm font-bold text-white/50"
                  >
                    최근 매치 기록이 없어 AI 분석을 시작할 수 없습니다.
                  </p>
                )}
              </div>

              <div className="stats-result-grid">
                <aside className="stats-overview-rail">
                  <StatSummaryPanel
                    stats={result.stats}
                    statsAvailability={result.statsAvailability}
                    mode={statsMode}
                    partySize={partySize}
                    aiSummary={aiSummary}
                    aiExpanded={aiExpanded}
                    onAiToggle={handleAiToggle}
                  />
                </aside>
                <div className="stats-match-column">
                  <MatchFeed
                    matchIds={matchIds}
                    summaries={matchSummaries}
                    missingMatchIds={missingMatchIds}
                    matchModeMeta={matchModeMeta}
                    summaryStatus={summaryStatus}
                    filter={matchTab}
                    viewportClass={viewportClass}
                    nickname={result.nickname}
                    platform={result.platform}
                    onFilterChange={handleMatchFilterChange}
                    onRetrySummaries={() => void retrySummaries()}
                    historyStatus={historyStatus}
                    historyPage={historyPage}
                    historyTotalPages={historyTotalPages}
                    onPageChange={(page) => void setHistoryPage(page)}
                    onRetryHistory={() => void retryHistory()}
                    onNicknameClick={(clickedName) => {
                      navigateToPlayer(clickedName, result.platform, false);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    onModeDetected={handleModeDetected}
                    onFailure={reportPartial}
                    onRecovery={clearPartial}
                  />
                </div>
              </div>

              {/* BGMS AI 전술 분석 시스템 설명 (토글형으로 최적화) */}
              <div>
                <button
                  type="button"
                  aria-expanded={showGuideline}
                  onClick={() => setShowGuideline((value) => !value)}
                  className="group flex min-h-11 w-full items-center justify-between rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 transition-all hover:bg-amber-500/10"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-amber-500 rounded-lg shadow-[0_0_15px_rgba(245,158,11,0.3)]">
                      <Shield size={18} className="text-black" aria-hidden="true" />
                    </div>
                    <div className="flex flex-col items-start">
                      <h3 className="text-sm font-black text-amber-500 tracking-tight">BGMS AI 전술 분석 가이드 (V7.0)</h3>
                      <span className="text-[10px] text-amber-500/60 font-bold">지표 산출 공식 및 시스템 안내 확인하기</span>
                    </div>
                  </div>
                  <ChevronDown
                    size={20}
                    aria-hidden="true"
                    className={`text-amber-500/50 group-hover:text-amber-500 transition-transform duration-300 ${showGuideline ? 'rotate-180' : ''}`}
                  />
                </button>

                {showGuideline && (
                  <div className="mt-3 p-6 bg-black/40 border border-white/5 rounded-[2rem] backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                      <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
                        <div className="text-amber-500 text-[11px] font-black mb-1">01. 상황 입체 분석</div>
                        <div className="text-gray-400 text-xs leading-relaxed">단순 킬/딜을 넘어 교전 거리, 지형 고도차, 아군과의 거리 등 텔레메트리를 입체적으로 분석합니다.</div>
                      </div>
                      <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
                        <div className="text-amber-500 text-[11px] font-black mb-1">02. 공정한 평가</div>
                        <div className="text-gray-400 text-xs leading-relaxed">불가항력적인 자기장 피해나 교전 기회가 없던 상황(N/A)은 지표 계산에서 제외하여 억울한 비난을 방지합니다.</div>
                      </div>
                      <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
                        <div className="text-amber-500 text-[11px] font-black mb-1">03. 티어 판별 엔진</div>
                        <div className="text-gray-400 text-xs leading-relaxed">프로급(Elite) 유저들의 전술 데이터를 기준으로 당신의 현재 실력을 S~C 티어로 정밀 판별합니다.</div>
                      </div>
                    </div>

                    <div className="border-t border-white/5 pt-6">
                      <div className="flex items-center gap-2 mb-4">
                        <div className="w-1 h-3 bg-amber-500 rounded-full" />
                        <span className="text-xs font-black text-white uppercase tracking-wider">전술 지표 사전</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                        <div className="flex gap-3">
                          <span className="text-amber-500/30 font-black italic">01</span>
                          <div>
                            <div className="text-gray-200 text-xs font-bold mb-1">평균 반응 속도</div>
                            <div className="text-gray-500 text-[11px] leading-relaxed">피격 시점부터 적에게 반격을 가하기까지의 시간. 당신의 순수 피지컬과 위기 대처 능력을 측정합니다.</div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <span className="text-amber-500/30 font-black italic">02</span>
                          <div>
                            <div className="text-gray-200 text-xs font-bold mb-1">백업 소요 속도 (트레이드)</div>
                            <div className="text-gray-500 text-[11px] leading-relaxed">아군이 기절한 후 당신이 해당 적을 처치하기까지의 시간. 팀워크와 커버 능력을 측정합니다.</div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <span className="text-amber-500/30 font-black italic">03</span>
                          <div>
                            <div className="text-gray-200 text-xs font-bold mb-1">전투 주도권</div>
                            <div className="text-gray-500 text-[11px] leading-relaxed">교전 시작 시 먼저 선제 타격을 가한 비율. 능동적으로 교전을 리드하는 성향을 분석합니다.</div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <span className="text-amber-500/30 font-black italic">04</span>
                          <div>
                            <div className="text-gray-200 text-xs font-bold mb-1">팀 내 화력 지분</div>
                            <div className="text-gray-500 text-[11px] leading-relaxed">팀 전체 데미지 중 당신의 지분. 단순 킬 수를 넘어 교전에서 실제로 얼마나 화력을 담당했는지 측정합니다.</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

            </div>
          ) : (
            <SquadAnalysisPanel
              nickname={result.nickname}
              platform={result.platform}
              groupKey={groupKey}
              onGroupKeyChange={setGroupKey}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// 제재 상태 확인 버튼 및 팝오버 컴포넌트
// ─────────────────────────────────────────────────────────────
