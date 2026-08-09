// 파일 위치: components/stat/StatSearch.tsx
"use client";

import React, { useState, useEffect, useId, useCallback, useRef } from "react";
import { MatchCard } from "./MatchCard";
import AdSenseBanner from "../ads/AdSenseBanner";
import { StatSummaryPanel } from "./StatSummaryPanel";
import { RecentAISummary } from "./RecentAISummary";
import SquadAnalysisPanel from "./SquadAnalysisPanel";
import AdfitBanner from "@/components/ads/AdfitBanner";
import { Shield, ChevronDown, Swords, Star, User, Crosshair } from "lucide-react";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { useAuth } from "@/components/AuthProvider";
import { useRouter } from "next/navigation";
import { useStatsPageController } from "@/hooks/useStatsPageController";
import { useStatsAutocomplete } from "@/hooks/useStatsAutocomplete";
import { useStatsProfilePrefill } from "@/hooks/useStatsProfilePrefill";
import { useStatsSearchHistory } from "@/hooks/useStatsSearchHistory";
import { StatsSearchBar } from "./search/StatsSearchBar";
import { StatsLandingState } from "./search/StatsLandingState";
import type { StatsSectionTab } from "@/types/stats-page";
// import CompanionEntryCard from "@/components/overwolf/CompanionEntryCard";

const STATS_MOBILE_AD_UNIT = "DAN-tQGcqmddMC8tPpXA";
const STATS_LEADERBOARD_AD_UNIT = "DAN-dPiCxgIGtXKjLPP3";
const STATS_DESKTOP_AD_UNIT = "DAN-RjyosR2uf8eSsVIC";

interface StatSearchProps {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
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
    matchSummaries,
    missingMatchIds,
    matchModeMeta,
    isRefreshCoolingDown: isCoolingDown,
    setPlatform,
    setNickname,
    setSectionTab: setActiveTab,
    setMatchFilter: setMatchTab,
    search,
    onModeDetected: handleModeDetected,
  } = controller;
  const loading = status === "loading" || status === "refreshing";
  const error = controllerError?.message ?? "";
  const errorType = controllerError?.type ?? "";
  const dynamicMatchModes = Object.fromEntries(
    Object.entries(matchModeMeta).map(([matchId, meta]) => [matchId, meta.gameMode ?? ""]),
  );

  const { user } = useAuth();
  const seasonId = useId();
  const [cooldown, setCooldown] = useState(false);
  const isSearchingRef = useRef(false);
  const cooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationPendingRef = useRef(false);
  const [navigationPending, setNavigationPending] = useState(false);
  const userEditedRef = useRef(false);
  const recordedResultRef = useRef<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const {
    recentSearches,
    favorites,
    addRecent,
    toggleFavorite: toggleStoredFavorite,
    removeRecent,
  } = useStatsSearchHistory();
  const autocomplete = useStatsAutocomplete(nickname);
  const profilePrefill = useStatsProfilePrefill(user?.id);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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
      (respectSubmitGuard && (loading || cooldown || isCoolingDown))
    ) return;
    navigationPendingRef.current = true;
    setNavigationPending(true);
    router.push(`/stats/${targetPlatform}/${encodeURIComponent(normalized)}`);
  }, [cooldown, isCoolingDown, loading, platform, router]);

  useEffect(() => {
    navigationPendingRef.current = false;
    setNavigationPending(false);
  }, [initialNickname, initialPlatform]);

  useEffect(() => {
    return () => {
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
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

  const toggleFavorite = (name: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    toggleStoredFavorite(name);
  };

  const [showGuideline, setShowGuideline] = useState(false);

  return (
    <div className="w-full max-w-[1200px] mx-auto px-3.5 py-5 md:p-5 text-white">
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
        submitDisabled={!nickname.trim() || loading || cooldown || isCoolingDown || navigationPending}
        submitLabel={loading ? "검색중..." : cooldown || isCoolingDown ? "쿨타임" : "검색"}
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
        <StatsLandingState onCompare={() => router.push("/stats/battle")} />
      )}

      {result && (
        <div className="relative w-full" style={{ display: "flex", flexDirection: "column", gap: "30px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid #333", paddingBottom: "15px", flexWrap: "wrap", gap: "15px" }}>
            <div className="flex flex-col gap-3">
              {/* 1행: 플랫폼/닉네임 + 클랜 배지 + 제재 확인 배지 */}
              <div className="flex items-center gap-3 flex-wrap">
                <div style={{ fontSize: "28px", fontWeight: "bold" }}>
                  <span style={{ color: "#888", fontSize: "16px", marginRight: "10px", verticalAlign: "middle" }}>
                    {result.platform === "steam" ? "Steam" : "Kakao"}
                  </span>
                  {result.nickname}
                </div>
                {result.clan && (
                  <ClanBadge clan={result.clan} isMobile={isMobile} />
                )}
                <BanStatusButton banType={result.banType ?? "None"} isMobile={isMobile} />
              </div>

              {/* 2행: 전적 갱신 영역 (버튼, 즐겨찾기, 업데이트 시간 수평 정렬) */}
              {(() => {
                const isFav = favorites.includes(result.nickname);
                return (
                  <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
                    {isCoolingDown ? (
                      <button
                        disabled
                        className="px-3 py-1.5 bg-blue-600 text-white text-[11px] font-black rounded-lg border-none opacity-90 select-none cursor-not-allowed"
                      >
                        최신 전적
                      </button>
                    ) : (
                      <button
                        onClick={() => handleControllerSearch(selectedSeason, result.nickname, result.platform, true)}
                        disabled={loading}
                        className="px-3 py-1.5 bg-[#2dd4bf] hover:bg-[#14b8a6] text-white text-[11px] font-black rounded-lg border-none cursor-pointer transition-all active:scale-95 shadow-md shadow-teal-950/20"
                      >
                        {loading ? "갱신 중..." : "전적 갱신"}
                      </button>
                    )}
                    
                    <button
                      onClick={(event) => toggleFavorite(result.nickname, event)}
                      className={`p-1.5 rounded-lg border-none transition-all cursor-pointer ${isFav ? "text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20" : "text-gray-500 bg-white/5 hover:text-yellow-400 hover:bg-yellow-400/10"}`}
                    >
                      <Star size={13} fill={isFav ? "currentColor" : "none"} />
                    </button>
                    <span className="font-bold text-[11px] text-gray-500">
                      최근 업데이트: {timeAgo(result.updatedAt)}
                    </span>
                  </div>
                );
              })()}

              {/* 3행: 액션 버튼들 */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => router.push(`/stats/${result.platform}/${result.nickname}/weapons`)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-full text-[11px] font-black transition-all cursor-pointer"
                >
                  <Crosshair size={12} />
                  <span>무기 마스터리 분석</span>
                </button>
                <button
                  onClick={() => router.push(`/stats/battle?nick1=${encodeURIComponent(result.nickname)}`)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 border border-purple-500/30 rounded-full text-[11px] font-black transition-all group"
                >
                  <Swords size={12} className="group-hover:rotate-12 transition-transform" />
                  <span>이 플레이어와 비교하기</span>
                </button>
              </div>
            </div>
            <select
              id={seasonId}
              name="season"
              autoComplete="off"
              value={selectedSeason}
              onChange={(e) => {
                handleControllerSearch(e.target.value, result.nickname, result.platform, false, true);
              }}
              style={{ padding: "8px 12px", backgroundColor: "#252525", color: "white", border: "1px solid #444", borderRadius: "6px" }}
            >
              {result.seasons.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* 탭 네비게이션 */}
          <div className="flex border-b border-white/5 gap-2">
            <button
              onClick={() => setActiveTab("overview")}
              className={`pb-3 px-4 text-xs font-black border-b-2 transition-all cursor-pointer ${
                activeTab === "overview"
                  ? "border-amber-500 text-amber-500"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              개인 분석 개요
            </button>
            <button
              onClick={() => setActiveTab("squad")}
              className={`pb-3 px-4 text-xs font-black border-b-2 transition-all cursor-pointer ${
                activeTab === "squad"
                  ? "border-purple-500 text-purple-400"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              스쿼드 시너지
            </button>
          </div>

          {activeTab === "overview" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "30px" }}>

              {/* 경쟁전 / 일반전 통합 탭 패널 */}
              <StatSummaryPanel
                stats={{
                  ranked: result.stats.ranked ?? undefined,
                  normal: result.stats.normal ?? undefined,
                }}
                isMobile={isMobile}
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

              {/* 최근 10경기 AI 종합 분석 섹션 추가 - 닉네임이 바뀔 때마다 리셋되도록 key 부여 */}
              {result.recentMatches && result.recentMatches.length > 0 && (
                <RecentAISummary 
                  key={result.nickname}
                  matchIds={[...result.recentMatches]}
                  nickname={result.nickname} 
                  platform={result.platform} 
                  isMobile={isMobile}
                />
              )}

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
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
                  <h3 className="text-lg font-black text-white flex items-center gap-2">
                    <InlineIconLabel icon="battle" iconSize={18}>
                      최근 매치 <span className="text-xs text-white/40 font-bold">(최대 20게임)</span>
                    </InlineIconLabel>
                  </h3>
                  
                  {/* [V56.0] 4단 탭 필터링 버튼 (모바일 터치 스크롤 지원) */}
                  <div className="flex bg-white/5 p-1 rounded-xl gap-1 shrink-0">
                    {[
                      { id: "all", label: "전체" },
                      { id: "normal", label: "일반전" },
                      { id: "ranked", label: "경쟁전" },
                      { id: "tdm", label: "TDM" }
                    ].map((tab) => {
                      const isActive = matchTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setMatchTab(tab.id as any)}
                          className={`py-1.5 px-3 rounded-lg text-xs font-black transition-all cursor-pointer whitespace-nowrap
                            ${isActive 
                              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' 
                              : 'text-white/40 hover:text-white/70 hover:bg-white/5'
                            }`}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {(() => {
                  const filteredMatches = (result.recentMatches || []).filter((matchId: string) => {
                    // matches-summary에서도 찾지 못한 매치는 표시 안 함
                    if (missingMatchIds.has(matchId)) return false;
                    if (matchTab === "all") return true;
                    const rawMode = ((dynamicMatchModes && dynamicMatchModes[matchId]) || "").toLowerCase();
                    if (!rawMode) return true;
                    
                    // TDM 판정 (하드코딩 매치 ID 및 tdm 문자열 체크)
                    const isTdm = rawMode.includes("tdm") || 
                                  matchId === "0f436bf2-2cab-4cc6-9b47-828cc85942f9" || 
                                  matchId === "6c5bddad-b7e8-4fca-b344-a1bb4b9582e6" ||
                                  matchId === "041eddef-2681-4d0c-884c-b92ada5b831a" ||
                                  matchId === "7424d661-6860-4eb7-b799-4326d059ab7b" ||
                                  matchId === "cb7742e0-1e65-473b-a6df-57493a095fb9" ||
                                  matchId === "9de66d2c-2ce5-4a3c-8686-200730969c4c" ||
                                  matchId === "5886bda2-497a-47b6-b4c0-40f1ad1a501d" ||
                                  matchId === "c7805862-5259-4ad5-9da7-c1b2f5af0d01";

                    if (matchTab === "tdm") return isTdm;

                    const isRanked = !isTdm && (rawMode.includes("competitive") || rawMode.includes("ranked"));
                    if (matchTab === "ranked") return isRanked;

                    if (matchTab === "normal") {
                      return !isRanked && !isTdm;
                    }
                    return true;
                  }).slice(0, 20);

                  const getEmptyMessage = () => {
                    if (matchTab === "ranked") return "최근 14일 이내에 플레이한 경쟁전(랭크전) 기록이 없습니다.";
                    if (matchTab === "tdm") return "최근 14일 이내에 플레이한 팀 데스매치(TDM) 기록이 없습니다.";
                    if (matchTab === "normal") return "최근 14일 이내에 플레이한 일반전 기록이 없습니다.";
                    return "최근 14일 이내에 플레이한 매치 기록이 없습니다.";
                  };

                  return filteredMatches.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {filteredMatches.map((matchId: string, index: number) => (
                        <React.Fragment key={matchId}>
                          <MatchCard
                            matchId={matchId}
                            nickname={result.nickname}
                            platform={result.platform}
                            isMobile={isMobile}
                            index={index}
                            initialMatchData={matchSummaries[matchId]}
                            onNicknameClick={(clickedName) => {
                              navigateToPlayer(clickedName, result.platform, false);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                            onModeDetected={handleModeDetected}
                          />
                          {(index === 4 || index === 14) && (
                            /* 인피드 광고는 높이를 제한하지 않는다. 잘린 광고 렌더는 정책 위반이다. */
                            <div className="my-2 w-full bg-[#1a1a1a] rounded-3xl p-0 border border-white/5 flex items-center justify-center">
                              <div className="w-full">
                                <AdSenseBanner
                                  client="ca-pub-3993032200487955"
                                  slot="4661728917"
                                  format="fluid"
                                  layoutKey="-fb+5w+4e-db+86"
                                />
                              </div>
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  ) : (
                    <div className="p-10 bg-white/3 border border-white/5 rounded-3xl text-center text-xs text-white/40 font-bold font-sans">
                      {getEmptyMessage()}
                    </div>
                  );
                })()}
              </div>
            </div>
          ) : (
            <SquadAnalysisPanel nickname={result.nickname} platform={result.platform} />
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
// 클랜 배지 컴포넌트
// ─────────────────────────────────────────────────────────────

interface ClanData {
  id: string;
  name: string;
  tag: string;
  level: number;
  memberCount: number;
}

function ClanBadge({ clan, isMobile }: { clan: ClanData; isMobile: boolean }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isMobile || !open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isMobile, open]);

  return (
    <div
      ref={ref}
      className="relative inline-block"
      onMouseEnter={() => !isMobile && setOpen(true)}
      onMouseLeave={() => !isMobile && setOpen(false)}
      onClick={() => isMobile && setOpen((v) => !v)}
    >
      {/* 배지 */}
      <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border cursor-pointer select-none"
        style={{
          background: "linear-gradient(135deg, rgba(242,169,0,0.15) 0%, rgba(255,200,80,0.08) 100%)",
          borderColor: "rgba(242,169,0,0.4)",
        }}
      >
        <Shield size={11} className="text-amber-400" />
        <span className="text-[12px] font-black text-amber-400 tracking-wide">[{clan.tag}]</span>
      </div>

      {/* 팝오버 */}
      {open && (
        <div
          className="absolute top-full left-0 mt-2 z-50 min-w-[200px] p-4 rounded-2xl border shadow-2xl animate-in fade-in slide-in-from-top-1 duration-150"
          style={{
            background: "linear-gradient(145deg, #1a1400 0%, #0f0a00 100%)",
            borderColor: "rgba(242,169,0,0.25)",
            boxShadow: "0 20px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(242,169,0,0.1) inset",
          }}
        >
          <div className="flex items-center gap-2 mb-3 pb-2 border-b" style={{ borderColor: "rgba(242,169,0,0.15)" }}>
            <div className="p-1.5 rounded-lg" style={{ background: "rgba(242,169,0,0.15)" }}>
              <Shield size={14} className="text-amber-400" />
            </div>
            <div>
              <div className="text-xs font-black text-white">{clan.name}</div>
              <div className="text-[10px] text-amber-400/70 font-bold">[{clan.tag}]</div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-gray-500 font-bold">클랜 레벨</span>
              <span className="text-[11px] font-black text-amber-400">Lv. {clan.level}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-gray-500 font-bold">멤버 수</span>
              <span className="text-[11px] font-black text-white">{clan.memberCount}명</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 제재 상태 확인 버튼 및 팝오버 컴포넌트
// ─────────────────────────────────────────────────────────────

interface BanStatusButtonProps {
  banType: string;
  isMobile: boolean;
}

function BanStatusButton({ banType, isMobile }: BanStatusButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMobile || !open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isMobile, open]);

  const normalizedType = banType ? banType.trim() : "None";
  const lowerType = normalizedType.toLowerCase();
  const isNormal = lowerType === "none" || lowerType === "innocent";
  const isPermanent = lowerType.startsWith("permanent");
  const isInherited = lowerType.startsWith("inherited");

  const label = "제재 상태 확인";
  let statusText = "정상 활동 계정";
  let statusDesc = "현재 특별한 플랫폼 제한 또는 영구 제재 조치가 없는 정상 상태입니다.";
  let badgeColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20";
  let popoverBg = "linear-gradient(145deg, #022013 0%, #000c07 100%)";
  let popoverBorder = "rgba(16,185,129,0.3)";
  let popoverShadow = "0 20px 40px rgba(0,0,0,0.6), 0 0 15px rgba(16,185,129,0.1) inset";

  if (isPermanent) {
    statusText = "영구 이용 정지 계정";
    statusDesc = "PUBG 보안 및 게임 정책 위반으로 시스템에 의해 영구 이용 제한 조치된 상태입니다.";
    badgeColor = "text-rose-400 border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20";
    popoverBg = "linear-gradient(145deg, #25060d 0%, #0c0003 100%)";
    popoverBorder = "rgba(244,63,94,0.3)";
    popoverShadow = "0 20px 40px rgba(0,0,0,0.6), 0 0 15px rgba(244,63,94,0.1) inset";
  } else if (isInherited) {
    statusText = "상속된 제재 상태";
    statusDesc = "연결된 Steam 또는 타 서비스의 외부 보안 정책 위반에 의해 연동 제재된 상태입니다.";
    badgeColor = "text-amber-400 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20";
    popoverBg = "linear-gradient(145deg, #201302 0%, #0c0700 100%)";
    popoverBorder = "rgba(245,158,11,0.3)";
    popoverShadow = "0 20px 40px rgba(0,0,0,0.6), 0 0 15px rgba(245,158,11,0.1) inset";
  } else if (!isNormal) {
    statusText = "임시 보호 조치";
    statusDesc = "조사를 위해 일시적으로 계정이 동결되었거나 안전 상태 점검 중입니다.";
    badgeColor = "text-sky-400 border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20";
    popoverBg = "linear-gradient(145deg, #0c1a30 0%, #030810 100%)";
    popoverBorder = "rgba(14,165,233,0.3)";
    popoverShadow = "0 20px 40px rgba(0,0,0,0.6), 0 0 15px rgba(14,165,233,0.1) inset";
  }

  return (
    <div
      ref={ref}
      className="relative inline-block"
      onMouseEnter={() => !isMobile && setOpen(true)}
      onMouseLeave={() => !isMobile && setOpen(false)}
      onClick={() => isMobile && setOpen((v) => !v)}
    >
      <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border cursor-pointer select-none text-[11px] font-black tracking-wide transition-all duration-200 ${badgeColor}`}>
        <Shield size={11} />
        <span>{label}</span>
      </div>

      {open && (
        <div
          className="absolute top-full left-0 mt-2 z-[999] min-w-[280px] md:min-w-[320px] p-4 rounded-2xl border shadow-2xl animate-in fade-in slide-in-from-top-1 duration-150 backdrop-blur-md"
          style={{
            background: popoverBg,
            borderColor: popoverBorder,
            boxShadow: popoverShadow,
          }}
        >
          <div className="flex items-center gap-2 mb-3 pb-2 border-b" style={{ borderColor: popoverBorder }}>
            <div className="p-1.5 rounded-lg" style={{ background: "rgba(255,255,255,0.05)" }}>
              <Shield size={14} className={isNormal ? "text-emerald-400" : isPermanent ? "text-rose-400" : isInherited ? "text-amber-400" : "text-sky-400"} />
            </div>
            <div>
              <div className="text-xs font-black text-white">PUBG 계정 보안 상태</div>
              <div className={`text-[10px] font-bold ${isNormal ? "text-emerald-400/80" : isPermanent ? "text-rose-400/80" : isInherited ? "text-amber-400/80" : "text-sky-400/80"}`}>
                {statusText} ({normalizedType})
              </div>
            </div>
          </div>
          <p className="text-[11px] text-gray-300 leading-relaxed font-medium">
            {statusDesc}
          </p>
        </div>
      )}
    </div>
  );
}

// [V61.0] 최근 업데이트 경과 시간을 한글 텍스트로 변환해주는 헬퍼 함수
function timeAgo(dateString?: string) {
  if (!dateString) return "정보 없음";
  const now = new Date();
  const past = new Date(dateString);
  const diffMs = now.getTime() - past.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  
  if (diffSec < 10) return "방금";
  if (diffSec < 60) return `${diffSec}초 전`;
  
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}일 전`;
}
