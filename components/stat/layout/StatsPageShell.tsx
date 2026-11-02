// 파일 위치: components/stat/layout/StatsPageShell.tsx
"use client";


import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createSquadRequestCache } from "@/lib/stats/squadRequestCache";
import { StatSummaryPanel } from "@/components/stat/StatSummaryPanel";
import { seasonOverviewForResult } from "@/components/stat/overview/StatsSeasonOverviewCard";
import dynamic from "next/dynamic";
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
import type { StatsPlatform, StatsSectionTab, StatsStoredSeasonSummary } from "@/types/stats-page";
import { useAdViewportClass } from "@/hooks/useAdViewportClass";
import { StatsManualAdRails } from "@/components/ads/StatsManualAdRails";
// import CompanionEntryCard from "@/components/overwolf/CompanionEntryCard";

const RecentAISummary = dynamic(
  () => import("@/components/stat/RecentAISummary").then((mod) => mod.RecentAISummary),
  { loading: () => <p role="status" className="min-h-28 rounded-2xl bg-white/5 p-5 text-sm text-white/60">AI 분석 화면을 준비하고 있습니다.</p> },
);
const SquadAnalysisPanel = dynamic(() => import("@/components/stat/SquadAnalysisPanel"), {
  loading: () => <p role="status" className="min-h-40 rounded-2xl bg-white/5 p-5 text-sm text-white/60">팀 분석 화면을 준비하고 있습니다.</p>,
});

const NAVIGATION_PENDING_TIMEOUT_MS = 1_000;
const SEARCH_COOLDOWN_MS = 3_000;

export interface StatsPageShellProps {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
  /** URL 플레이어의 저장된 시즌 합계. 다른 플레이어 결과에는 쓰지 않는다. */
  initialSeasonSummary?: StatsStoredSeasonSummary;
}

interface StatsSearchIntent {
  nickname: string;
  platform: StatsPlatform;
  seasonId: string;
  forceRefresh: boolean;
}

/** 전적 검색 메인 컴포넌트 */
export function StatsPageShell({
  initialPlatform,
  initialNickname,
  initialTab,
  initialGroupKey,
  initialSeasonSummary,
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
    collectionProgress,
    matchIds,
    recentMatchIds,
    aiMatchIds,
    applyRecentMatchIdsToAi,
    historyStatus,
    historyPage,
    historyTotalPages,
    historyTotalCount,
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
  }, [setMatchTab]);

  const { user } = useAuth();
  // A fresh search/refresh result or login change owns a fresh cache. Tab
  // switches retain this page instance and reuse both pending and ready GETs.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Deliberately replace the cache when its owning snapshot or user changes.
  const squadRequestCache = useMemo(() => createSquadRequestCache(), [result, user?.id]);
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
    if (resultPlatform) addRecent(resultNickname, resultPlatform);
  }, [addRecent, resultIdentity, resultNickname, resultPlatform]);

  const toggleFavorite = (name: string) => toggleStoredFavorite(name, result?.platform ?? platform);

  const [showGuideline, setShowGuideline] = useState(false);
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
      className="stats-page stats-auto-ads-excluded pb-safe-nav min-h-screen w-full text-white"
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
        placeholder={result ? "다른 플레이어 닉네임 검색 (대소문자 구분)" : undefined}
        onPlatformChange={setPlatform}
        onNicknameChange={(value) => {
          userEditedRef.current = true;
          setNickname(value);
        }}
        onSubmit={() => navigateToPlayer(nickname)}
        onQuickSearch={(name, savedPlatform) => navigateToPlayer(name, savedPlatform)}
        onSuggestionSelect={(suggestion) => navigateToPlayer(suggestion.nickname, suggestion.platform)}
        onFavoriteToggle={toggleStoredFavorite}
        onRecentRemove={removeRecent}
      />

      <StatsPageStates
        status={status}
        error={controllerError}
        suggestedPlayers={suggestedUsers}
        hasResult={Boolean(result)}
        partialReasons={controller.partialReasons}
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
            favorite={favorites.some(entry => entry.platform === result.platform && entry.nickname.toLowerCase() === result.nickname.toLowerCase())}
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

          {/* 탭 네비게이션 */}
          <StatsSectionTabs value={activeTab} onChange={setActiveTab} />

          {activeTab === "overview" ? (
            <div className="flex flex-col gap-2 md:gap-4">
              <div role="region" aria-label="AI 분석" tabIndex={-1}>
                <details open={user ? true : undefined} className="group rounded-2xl border border-white/10 bg-[#161616]">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-black text-amber-200 focus-visible:outline-2 focus-visible:outline-amber-300 [&::-webkit-details-marker]:hidden">
                    <span>AI 전술 분석</span>
                    <span className="flex items-center gap-1 text-xs font-bold text-white/70">
                      {!user && <span>로그인 후 이용 가능 ·</span>}
                      <span className="group-open:hidden">펼치기</span>
                      <span className="hidden group-open:inline">접기</span>
                      <ChevronDown size={16} aria-hidden="true" className="transition-transform duration-200 group-open:rotate-180" />
                    </span>
                  </summary>
                  <div className="px-2 pb-2">
                    {aiMatchIds === null ? (
                      <p role="status" className="p-3 text-center text-sm text-white/75">AI 분석에 사용할 최근 경기를 확인하고 있습니다.</p>
                    ) : aiMatchIds.length > 0 ? (
                      <RecentAISummary
                        matchIds={aiMatchIds}
                        nickname={result.nickname}
                        platform={result.platform}
                        isMobile={isMobile}
                        pendingMatchCount={(recentMatchIds ?? []).filter((id) => !aiMatchIds.includes(id)).length}
                        onApplyPendingMatches={applyRecentMatchIdsToAi}
                      />
                    ) : (
                      <p
                        role="status"
                        aria-label="AI 분석할 최근 매치 없음"
                        className="p-3 text-center text-sm font-bold text-white/75"
                      >
                        최근 매치 기록이 없어 AI 분석을 시작할 수 없습니다.
                      </p>
                    )}
                    {/* BGMS AI 전술 분석 시스템 설명 */}
                    <div className="mt-2 px-2">
                      <button
                        type="button"
                        aria-expanded={showGuideline}
                        onClick={() => setShowGuideline((value) => !value)}
                        className="group flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/5"
                      >
                        <span className="flex items-center gap-2">
                          <Shield size={16} className="shrink-0 text-amber-400" aria-hidden="true" />
                          <span className="text-sm font-black text-amber-300">BGMS AI 전술 분석 가이드 (V7.0)</span>
                          <span className="hidden text-xs font-bold text-white/70 sm:inline">지표 산출 공식 및 시스템 안내</span>
                        </span>
                        <ChevronDown
                          size={18}
                          aria-hidden="true"
                          className={`shrink-0 text-amber-400/70 transition-transform duration-300 group-hover:text-amber-300 ${showGuideline ? "rotate-180" : ""}`}
                        />
                      </button>

                      {showGuideline && (
                        <div className="mt-2 rounded-2xl border border-white/10 bg-black/30 p-4 md:p-5">
                          <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
                            <div className="rounded-xl border border-white/5 bg-white/5 p-4">
                              <div className="mb-1 text-sm font-black text-amber-400">01. 상황 입체 분석</div>
                              <div className="text-sm leading-relaxed text-gray-300">단순 킬/딜을 넘어 교전 거리, 지형 고도차, 아군과의 거리 등 텔레메트리를 입체적으로 분석합니다.</div>
                            </div>
                            <div className="rounded-xl border border-white/5 bg-white/5 p-4">
                              <div className="mb-1 text-sm font-black text-amber-400">02. 공정한 평가</div>
                              <div className="text-sm leading-relaxed text-gray-300">불가항력적인 자기장 피해나 교전 기회가 없던 상황(N/A)은 지표 계산에서 제외하여 억울한 비난을 방지합니다.</div>
                            </div>
                            <div className="rounded-xl border border-white/5 bg-white/5 p-4">
                              <div className="mb-1 text-sm font-black text-amber-400">03. 티어 판별 엔진</div>
                              <div className="text-sm leading-relaxed text-gray-300">프로급(Elite) 유저들의 전술 데이터를 기준으로 당신의 현재 실력을 S~C 티어로 정밀 판별합니다.</div>
                            </div>
                          </div>

                          <div className="border-t border-white/10 pt-5">
                            <div className="mb-4 flex items-center gap-2">
                              <div className="h-3 w-1 rounded-full bg-amber-500" />
                              <span className="text-sm font-black text-white">전술 지표 사전</span>
                            </div>
                            <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
                              <div className="flex gap-3">
                                <span className="text-sm font-black text-amber-400/60">01</span>
                                <div>
                                  <div className="mb-1 text-sm font-bold text-gray-100">반격 소요 시간</div>
                                  <div className="text-sm leading-relaxed text-gray-300">상대에게 피해를 받은 뒤 해당 상대에게 처음 피해를 주기까지의 시간입니다. 피격 전 연속 발사·불확실한 기록은 제외하며, 반사신경을 직접 측정한 값은 아닙니다.</div>
                                </div>
                              </div>
                              <div className="flex gap-3">
                                <span className="text-sm font-black text-amber-400/60">02</span>
                                <div>
                                  <div className="mb-1 text-sm font-bold text-gray-100">백업 소요 속도 (트레이드)</div>
                                  <div className="text-sm leading-relaxed text-gray-300">아군이 기절한 후 당신이 해당 적을 처치하기까지의 시간. 팀워크와 커버 능력을 측정합니다.</div>
                                </div>
                              </div>
                              <div className="flex gap-3">
                                <span className="text-sm font-black text-amber-400/60">03</span>
                                <div>
                                  <div className="mb-1 text-sm font-bold text-gray-100">선제 타격 성공률</div>
                                  <div className="text-sm leading-relaxed text-gray-300">먼저 피해를 준 교전 중 승리하거나 아군 마무리를 지원한 비율입니다. 전체 교전에서 먼저 발사한 비율은 아닙니다.</div>
                                </div>
                              </div>
                              <div className="flex gap-3">
                                <span className="text-sm font-black text-amber-400/60">04</span>
                                <div>
                                  <div className="mb-1 text-sm font-bold text-gray-100">팀 내 화력 지분</div>
                                  <div className="text-sm leading-relaxed text-gray-300">팀 전체 데미지 중 당신의 지분. 단순 킬 수를 넘어 교전에서 실제로 얼마나 화력을 담당했는지 측정합니다.</div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </details>
              </div>

              <div className="stats-result-grid">
                <div className="stats-match-column">
                  <MatchFeed
                    matchIds={matchIds}
                    summaries={matchSummaries}
                    missingMatchIds={missingMatchIds}
                    matchModeMeta={matchModeMeta}
                    summaryStatus={summaryStatus}
                    filter={matchTab}
                    collectionProgress={collectionProgress}
                    viewportClass={viewportClass}
                    nickname={result.nickname}
                    platform={result.platform}
                    onFilterChange={handleMatchFilterChange}
                    onRetrySummaries={() => void retrySummaries()}
                    historyStatus={historyStatus}
                    historyPage={historyPage}
                    historyTotalPages={historyTotalPages}
                    historyTotalCount={historyTotalCount}
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
                <aside className="stats-overview-rail">
                  <StatSummaryPanel
                    matchIds={recentMatchIds ?? []}
                    summaries={matchSummaries}
                    matchModeMeta={matchModeMeta}
                    summaryStatus={summaryStatus}
                    seasonSummary={seasonOverviewForResult(initialSeasonSummary, result)}
                  />
                </aside>
              </div>


            </div>
          ) : (
            <SquadAnalysisPanel
              requestCache={squadRequestCache}
              nickname={result.nickname}
              platform={result.platform}
              groupKey={groupKey}
              onGroupKeyChange={setGroupKey}
            />
          )}

          <ResponsiveAdSlot placement="stats-top" viewportClass={viewportClass} />
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// 제재 상태 확인 버튼 및 팝오버 컴포넌트
// ─────────────────────────────────────────────────────────────
