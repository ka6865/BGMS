// 파일 위치: components/stat/StatSearch.tsx
"use client";

import { useState, useEffect, useCallback, useRef, type MouseEvent } from "react";
import AdSenseBanner from "../ads/AdSenseBanner";
import { StatSummaryPanel } from "./StatSummaryPanel";
import { RecentAISummary, type AiSummarySnapshot } from "./RecentAISummary";
import SquadAnalysisPanel from "./SquadAnalysisPanel";
import AdfitBanner from "@/components/ads/AdfitBanner";
import { Shield, ChevronDown, User } from "lucide-react";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { useAuth } from "@/components/AuthProvider";
import { useRouter } from "next/navigation";
import { useStatsPageController } from "@/hooks/useStatsPageController";
import { useStatsAutocomplete } from "@/hooks/useStatsAutocomplete";
import { useStatsProfilePrefill } from "@/hooks/useStatsProfilePrefill";
import { useStatsSearchHistory } from "@/hooks/useStatsSearchHistory";
import { StatsSearchBar } from "./search/StatsSearchBar";
import { StatsLandingState } from "./search/StatsLandingState";
import { PlayerProfileHeader } from "./profile/PlayerProfileHeader";
import { StatsSectionTabs } from "./overview/StatsSectionTabs";
import { MatchFeed } from "./matches/MatchFeed";
import { buildStatsCompareUrl, buildStatsWeaponsUrl } from "@/lib/stats/statsPageModel";
import type { StatsSectionTab } from "@/types/stats-page";
import { useAdViewportClass } from "@/hooks/useAdViewportClass";
// import CompanionEntryCard from "@/components/overwolf/CompanionEntryCard";

const STATS_MOBILE_AD_UNIT = "DAN-tQGcqmddMC8tPpXA";
const STATS_LEADERBOARD_AD_UNIT = "DAN-dPiCxgIGtXKjLPP3";
const STATS_DESKTOP_AD_UNIT = "DAN-RjyosR2uf8eSsVIC";
const NAVIGATION_PENDING_TIMEOUT_MS = 1_000;

interface StatSearchProps {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
}

interface IdentityOwnedAiState {
  identity: string;
  summary: AiSummarySnapshot | null;
  expanded: boolean;
}

/** 전적 검색 메인 컴포넌트 */
export default function StatSearch({
  initialPlatform,
  initialNickname,
  initialTab,
  initialGroupKey,
}: StatSearchProps) {
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
    onModeDetected: handleModeDetected,
    reportPartial,
    clearPartial,
  } = controller;
  const loading = status === "loading" || status === "refreshing";
  const refreshing = status === "refreshing";
  const error = controllerError?.message ?? "";
  const errorType = controllerError?.type ?? "";
  const viewportClass = useAdViewportClass();

  const { user } = useAuth();
  const [cooldown, setCooldown] = useState(false);
  const isSearchingRef = useRef(false);
  const cooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationPendingRef = useRef(false);
  const navigationPendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [navigationPending, setNavigationPending] = useState(false);
  const userEditedRef = useRef(false);
  const recordedResultRef = useRef<string | null>(null);
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
    const searchPlatform = overridePlatform || platform;
    if (!searchName.trim() || (!bypassCooldown && cooldown)) return;
    if (isSearchingRef.current) return;
    isSearchingRef.current = true;
    setCooldown(true);

    try {
      await search({
        nickname: searchName,
        platform: searchPlatform === "kakao" ? "kakao" : "steam",
        seasonId: resolvedSeason,
        forceRefresh: forceApiRefresh,
      });
    } finally {
      isSearchingRef.current = false;
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      cooldownTimeoutRef.current = setTimeout(() => setCooldown(false), 3000);
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

  useEffect(() => {
    if (!result) return;
    const identity = `${result.platform}:${result.nickname}`;
    if (recordedResultRef.current === identity) return;
    recordedResultRef.current = identity;
    addRecent(result.nickname);
  }, [addRecent, result]);

  const toggleFavorite = (name: string, event?: MouseEvent) => {
    event?.stopPropagation();
    toggleStoredFavorite(name);
  };

  const [showGuideline, setShowGuideline] = useState(false);
  const aiIdentity = result
    ? `${result.platform}\u001f${result.nickname}\u001f${result.recentMatches.join("\u001e")}`
    : "";
  const [aiState, setAiState] = useState<IdentityOwnedAiState | null>(null);
  const aiSummary = aiState?.identity === aiIdentity ? aiState.summary : null;
  const aiExpanded = aiState?.identity === aiIdentity ? aiState.expanded : false;
  const aiSectionRef = useRef<HTMLDivElement>(null);
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
  const handleAiOpen = useCallback(() => {
    const section = aiSectionRef.current;
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    const firstButton = section?.querySelector<HTMLButtonElement>("button");
    (firstButton ?? section)?.focus();
  }, []);

  return (
    <div className="stats-page w-full max-w-[1200px] mx-auto px-3.5 py-5 md:p-5 text-white">
      <h1 style={{ color: "#F2A900", fontSize: "24px", fontWeight: "bold", marginBottom: "20px", textAlign: "center" }}>
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

      {error && (
        <div
          className={`mb-5 rounded-xl border p-4 text-center backdrop-blur-md shadow-lg ${
            errorType === "not_found"
              ? "bg-amber-500/10 border-amber-500/25 shadow-amber-950/20"
              : "bg-red-500/10 border-red-500/25 shadow-red-950/20"
          }`}
        >
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/25 border border-white/10">
            <User size={18} className={errorType === "not_found" ? "text-amber-400" : "text-red-400"} />
          </div>
          <div className={`text-sm font-extrabold tracking-tight ${errorType === "not_found" ? "text-amber-300" : "text-red-400"}`}>
            {errorType === "not_found" ? "플레이어를 찾을 수 없습니다" : "전적을 불러오지 못했습니다"}
          </div>
          <div className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-gray-400">
            {error}
          </div>
          {errorType === "not_found" && (
            <div className="mx-auto mt-3 max-w-xl rounded-lg border border-amber-500/15 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-amber-100/70">
              PUBG 닉네임은 대소문자와 플랫폼이 다르면 검색되지 않을 수 있습니다. Steam/Kakao 선택과 닉네임 표기를 다시 확인해 주세요.
            </div>
          )}
          {suggestedUsers.length > 0 && (
            <div className="mt-3 pt-3 border-t border-amber-500/20">
              <p className="text-xs text-gray-400 mb-2">혹시 이 플레이어를 찾으시나요?</p>
              <div className="flex justify-center gap-2 flex-wrap">
                {suggestedUsers.map((user) => (
                  <button
                    key={`${user.nickname}-${user.platform}`}
                    aria-label={`${user.nickname} ${user.platform === "steam" ? "스팀" : "카카오"}로 검색`}
                    onClick={() => navigateToPlayer(user.nickname, user.platform)}
                    className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs font-black rounded-full hover:bg-amber-500 hover:text-black transition-all cursor-pointer"
                  >
                    {user.nickname} ({user.platform === "steam" ? "스팀" : "카카오"})
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* [Empty State V1.0] 결과 없음 + 로딩/에러 아님 → 유저 상태별 분기 화면 */}
      {!result && !loading && !error && (
        <StatsLandingState
          onCompare={() => router.push("/stats/battle")}
          authenticated={Boolean(user)}
          profileLoaded={profilePrefill.loaded}
          hasRegisteredNickname={Boolean(profilePrefill.nickname)}
        />
      )}

      {result && (
        <div className="relative w-full" style={{ display: "flex", flexDirection: "column", gap: "30px" }}>
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
          />

          {/* 탭 네비게이션 */}
          <StatsSectionTabs value={activeTab} onChange={setActiveTab} />

          {activeTab === "overview" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "30px" }}>

              {/* 경쟁전 / 일반전 통합 탭 패널 */}
              <StatSummaryPanel
                stats={result.stats}
                mode={statsMode}
                partySize={partySize}
                aiSummary={aiSummary}
                aiExpanded={aiExpanded}
                onModeChange={setStatsMode}
                onPartySizeChange={setPartySize}
                onAiOpen={handleAiOpen}
                onAiToggle={handleAiToggle}
              />

              {/* BGMS AI 전술 분석 시스템 설명 (토글형으로 최적화) */}
              <div className="mt-4 mb-6">
                <button 
                  onClick={() => setShowGuideline(!showGuideline)}
                  className="w-full flex items-center justify-between p-4 bg-amber-500/5 border border-amber-500/20 rounded-2xl hover:bg-amber-500/10 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-amber-500 rounded-lg shadow-[0_0_15px_rgba(245,158,11,0.3)]">
                      <Shield size={18} className="text-black" />
                    </div>
                    <div className="flex flex-col items-start">
                      <h3 className="text-sm font-black text-amber-500 tracking-tight">BGMS AI 전술 분석 가이드 (V7.0)</h3>
                      <span className="text-[10px] text-amber-500/60 font-bold">지표 산출 공식 및 시스템 안내 확인하기</span>
                    </div>
                  </div>
                  <ChevronDown 
                    size={20} 
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

              <div ref={aiSectionRef} role="region" aria-label="AI 분석" tabIndex={-1}>
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

              <div className="my-4 flex justify-center lg:hidden" aria-label="광고">
                <AdfitBanner
                  adUnit={STATS_MOBILE_AD_UNIT}
                  adWidth={320}
                  adHeight={100}
                />
              </div>
              <div className="my-4 hidden justify-center lg:flex 2xl:hidden" aria-label="광고">
                <AdfitBanner
                  adUnit={STATS_LEADERBOARD_AD_UNIT}
                  adWidth={728}
                  adHeight={90}
                />
              </div>

              <div className="mt-8">
                <MatchFeed
                  matchIds={result.recentMatches.slice(0, 20)}
                  summaries={matchSummaries}
                  missingMatchIds={missingMatchIds}
                  matchModeMeta={matchModeMeta}
                  summaryStatus={summaryStatus}
                  filter={matchTab}
                  viewportClass={viewportClass}
                  nickname={result.nickname}
                  platform={result.platform}
                  onFilterChange={setMatchTab}
                  onRetrySummaries={() => void retrySummaries()}
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
          ) : (
            <SquadAnalysisPanel
              nickname={result.nickname}
              platform={result.platform}
              groupKey={groupKey}
              onGroupKeyChange={setGroupKey}
            />
          )}

          {/* 우측 레일은 고정하지 않고 상단에 한 번만 노출한다. 좌우 동시 고정 광고는 정책 위반이다. */}
          <aside
            className="hidden [@media(min-width:1536px)_and_(min-height:680px)]:block w-[160px] absolute left-[calc(100%+24px)] top-0"
            aria-label="광고"
          >
            <AdfitBanner
              adUnit={STATS_DESKTOP_AD_UNIT}
              adWidth={160}
              adHeight={600}
            />
          </aside>

          {/*
            뷰포트 고정 광고는 좌측 한 곳만 유지한다.
            부모 높이가 auto이므로 h-full은 해석되지 않는다. inset-y-0으로 부모 높이만큼 늘려
            내부 sticky 요소가 이동할 여유를 확보한다.
          */}
          <aside
            className="hidden [@media(min-width:1536px)_and_(min-height:680px)]:block w-[160px] absolute right-[calc(100%+24px)] inset-y-0"
            aria-label="광고"
          >
            <div className="sticky top-16 h-[600px]">
              <AdSenseBanner
                client="ca-pub-3993032200487955"
                slot="7728921550"
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 제재 상태 확인 버튼 및 팝오버 컴포넌트
// ─────────────────────────────────────────────────────────────
