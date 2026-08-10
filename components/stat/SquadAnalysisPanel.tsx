"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Flame,
  ShieldAlert,
  Award,
  ChevronDown,
  ChevronUp,
  Share2,
  Copy,
  Camera,
  Download,
} from "lucide-react";
import dynamic from "next/dynamic";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/components/AuthProvider";
import { toast } from "sonner";
import SquadCauseScenes, { SquadCauseSceneCardData } from "./SquadCauseScenes";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import type { StatsPlatform } from "@/types/stats-page";

const Squad2DMap = dynamic(() => import("./Squad2DMap"), { ssr: false });

interface Teammate {
  name: string;
  role: string;
  roleDesc: string;
  avgDamage: number;
  avgKills: number;
  avgAssists: number;
  avgDbnos: number;
  totalDamage?: number;
  totalKills?: number;
  shares: {
    damage: number;
    kill: number;
    assist: number;
    dbno: number;
  };
}

interface MatchSummaryItem {
  matchId: string;
  mapName: string;
  mapDisplayName: string;
  winPlace: number;
  createdAt: string;
}

interface SquadAnalysisData {
  groupKey: string;
  matchCount: number;
  matchesSummary: MatchSummaryItem[];
  stats: {
    avgIsolation: number;
    avgTradeLatency: number;
    totalSmokeRescues: number;
    totalRevives: number;
    avgCoverRate: number;
    totalTeamWipes: number;
    totalTeammateKnocks?: number;
  };
  scores: {
    formation: number;
    backupSpeed: number;
    survivalCare: number;
    focusFire: number;
    teamWipe: number;
  };
  squadGrade: string;
  benchmarkStats?: {
    tier: string;
    avgIsolation: number;
    avgTradeLatency: number;
    avgReviveRate: number;
    avgSmokeRate: number;
    avgTeamWipes: number;
  };
  roleProfiles: Teammate[];
  causeScenes?: SquadCauseSceneCardData[];
}

interface TeammateFeedback {
  name: string;
  praise: string;
  fault: string;
  advice: string;
}

interface AiFeedback {
  squadGrade: string;
  summary: string;
  strength: string;
  weakness: string;
  coaching: string;
  memberFeedbacks?: TeammateFeedback[];
  overallOpinion?: string;
}

export interface SquadAnalysisPanelProps {
  nickname: string;
  platform: StatsPlatform;
  groupKey?: string;
  onGroupKeyChange(value: string): void;
}

export default function SquadAnalysisPanel({
  nickname,
  platform,
  groupKey,
  onGroupKeyChange,
}: SquadAnalysisPanelProps) {
  const router = useRouter();
  const { user } = useAuth();

  const [groups, setGroups] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [listError, setListError] = useState<boolean>(false);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<boolean>(false);
  const [analysisData, setAnalysisData] = useState<SquadAnalysisData | null>(null);
  
  // AI Coaching States
  const [coachingStyle, setCoachingStyle] = useState<"spicy" | "mild">("spicy");
  const [loadingAi, setLoadingAi] = useState<boolean>(false);
  const [aiFeedback, setAiFeedback] = useState<AiFeedback | null>(null);
  const [aiError, setAiError] = useState<boolean>(false);

  // 2D Map Selected Match State
  const [selectedMapMatchId, setSelectedMapMatchId] = useState<string>("");
  // 2D Map focus time (원인 장면 카드 클릭 시 설정, null이면 기절 이벤트 기준)
  const [selectedFocusTimeMs, setSelectedFocusTimeMs] = useState<number | null>(null);
  // 2D Map Collapse State
  const [showMap, setShowMap] = useState<boolean>(false);

  // 공유 상태 및 Ref
  const resultCardRef = useRef<HTMLDivElement | null>(null);
  const [shareBusy, setShareBusy] = useState<"share" | "copy" | "download" | "image" | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  // 1. Fetch detected squad list on mount
  const fetchSquadGroups = useCallback(async () => {
    try {
      setLoadingList(true);
      setListError(false);
      setGroups([]);
      const res = await fetch(`/api/pubg/squad-analyze?nickname=${encodeURIComponent(nickname)}&platform=${platform}`);
      if (!res.ok) throw new Error("Squad list request failed");
      const data = await res.json();
      if (data?.error) throw new Error("Squad list response failed");

      setGroups(Array.isArray(data.groups) ? data.groups : []);
    } catch (err) {
      console.error("Failed to load squad list:", err);
      setListError(true);
    } finally {
      setLoadingList(false);
    }
  }, [nickname, platform]);

  useEffect(() => {
    void fetchSquadGroups();
  }, [fetchSquadGroups]);

  const firstGroupKey = groups[0]?.groupKey as string | undefined;
  const hasSelectedGroup = Boolean(groupKey && groups.some((group) => group.groupKey === groupKey));

  useEffect(() => {
    if (!firstGroupKey || hasSelectedGroup) return;
    onGroupKeyChange(firstGroupKey);
  }, [firstGroupKey, groupKey, hasSelectedGroup, onGroupKeyChange]);

  // 2. Fetch detailed analysis when selected group changes
  const fetchSquadDetails = useCallback(async () => {
    if (!groupKey || !hasSelectedGroup) return;

    try {
      setLoadingDetail(true);
      setDetailError(false);
      setAnalysisData(null);
      setAiFeedback(null);
      const res = await fetch(
        `/api/pubg/squad-analyze?nickname=${encodeURIComponent(nickname)}&platform=${platform}&groupKey=${encodeURIComponent(groupKey)}`
      );
      if (!res.ok) throw new Error("Squad detail request failed");
      const data = await res.json();
      if (!data || data.error) throw new Error("Squad detail response failed");

      setAnalysisData(data);
      // GA4 스쿼드 시너지 전술 데이터 로드 완료
      trackEvent({
        name: "squad_synergy_completed",
        params: {
          nickname,
          platform,
          match_count: data.matchCount || 0,
          members_count: data.roleProfiles ? data.roleProfiles.length : 0,
        },
      });
    } catch (err) {
      console.error("Failed to load squad details:", err);
      setDetailError(true);
    } finally {
      setLoadingDetail(false);
    }
  }, [groupKey, hasSelectedGroup, nickname, platform]);

  useEffect(() => {
    void fetchSquadDetails();
  }, [fetchSquadDetails]);

  // Sync selected map match ID when analysisData loads
  useEffect(() => {
    if (analysisData?.matchesSummary && analysisData.matchesSummary.length > 0) {
      setSelectedMapMatchId(analysisData.matchesSummary[0].matchId);
    } else {
      setSelectedMapMatchId("");
    }
  }, [analysisData]);

  // 3. Request AI squad coaching
  const requestAiCoaching = async () => {
    if (!analysisData) return;
    if (!user) {
      toast.error("AI 스쿼드 분석은 로그인 후 이용할 수 있습니다.", {
        action: {
          label: "로그인",
          onClick: () => router.push("/login"),
        },
      });
      return;
    }

    // GA4 이벤트 트래킹: 스쿼드 시너지 분석 시작
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "squad-synergy",
        status: "start"
      }
    });

    try {
      setLoadingAi(true);
      setAiError(false);
      const res = await fetch("/api/pubg/ai-squad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupKey: analysisData.groupKey,
          matchCount: analysisData.matchCount,
          stats: analysisData.stats,
          scores: analysisData.scores,
          roleProfiles: analysisData.roleProfiles,
          matchIds: analysisData.matchesSummary.map((match) => match.matchId),
          nickname,
          platform,
          coachingStyle,
          squadGrade: analysisData.squadGrade,
          benchmarkStats: analysisData.benchmarkStats
        })
      });
      
      if (!res.ok) throw new Error("스쿼드 AI 분석 API 응답 에러");
      const data = await res.json();
      if (!data || data.error) throw new Error("스쿼드 AI 분석 응답 오류");
      setAiFeedback(data);
      
      // [GA4 Analytics] AI 스쿼드 코칭 생성 완료
      trackEvent({
        name: "ai_squad_coaching_requested",
        params: {
          nickname,
          coaching_style: coachingStyle,
          squad_grade: data.squadGrade || analysisData.squadGrade,
        },
      });

      // GA4 이벤트 트래킹: 스쿼드 시너지 분석 성공
      trackEvent({
        name: "feature_consumption",
        params: {
          feature_name: "squad-synergy",
          status: "success"
        }
      });
    } catch (err: any) {
      console.error("AI coaching request failed:", err);
      setAiError(true);
      
      // GA4 이벤트 트래킹: 스쿼드 시너지 분석 실패
      trackEvent({
        name: "feature_consumption",
        params: {
          feature_name: "squad-synergy",
          status: "fail",
          error_type: err.message || "unknown"
        }
      });
    } finally {
      setLoadingAi(false);
    }
  };

  // 공유 기능 및 유틸리티
  const buildShareUrl = () => {
    if (typeof window === "undefined") return "";
    const url = new URL(`/stats/${platform}/${encodeURIComponent(nickname)}`, window.location.origin);
    url.searchParams.set("tab", "squad");
    if (groupKey) {
      url.searchParams.set("groupKey", groupKey);
    }
    
    //  [추가] GA4 UTM 파라미터 강제 주입 (바이럴 유입 추적)
    url.searchParams.set("utm_source", "user_share");
    url.searchParams.set("utm_medium", "social");
    url.searchParams.set("utm_campaign", "squad_synergy_share");

    return url.toString();
  };

  const clearShareMessageLater = () => {
    window.setTimeout(() => setShareMessage(null), 2500);
  };

  const createShareImageBlob = async () => {
    if (!resultCardRef.current) throw new Error("공유할 결과 카드가 없습니다.");
    const { toPng } = await import("html-to-image");
    const dataUrl = await toPng(resultCardRef.current, {
      cacheBust: true,
      pixelRatio: 2,
      backgroundColor: "#0c0a1f",
    });
    const response = await fetch(dataUrl);
    return response.blob();
  };

  const handleCopyLink = async () => {
    try {
      setShareBusy("copy");
      await navigator.clipboard.writeText(buildShareUrl());
      trackEvent({ name: "share_clicked", params: { method: "link_copy", page: "squad" } });
      setShareMessage("공유 링크를 복사했어요.");
      clearShareMessageLater();
    } catch {
      setShareMessage("링크 복사에 실패했습니다.");
    } finally {
      setShareBusy(null);
    }
  };

  const handleShareLink = async () => {
    const shareUrl = buildShareUrl();
    try {
      setShareBusy("share");
      if (navigator.share) {
        await navigator.share({
          title: `${nickname} AI 스쿼드 분석 리포트 | BGMS`,
          url: shareUrl,
        });
        trackEvent({ name: "share_clicked", params: { method: "link_share", page: "squad" } });
        setShareMessage("공유 시트를 열었어요.");
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setShareMessage("공유 기능이 없어 링크를 대신 복사했어요.");
      }
      clearShareMessageLater();
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        setShareMessage("링크 공유에 실패했습니다.");
      }
    } finally {
      setShareBusy(null);
    }
  };

  const handleDownloadImage = async () => {
    try {
      setShareBusy("download");
      const blob = await createShareImageBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bgms-ai-squad-${nickname}.png`;
      link.click();
      URL.revokeObjectURL(url);
      trackEvent({ name: "share_clicked", params: { method: "image_download", page: "squad" } });
      setShareMessage("분석 리포트 이미지를 저장했어요.");
      clearShareMessageLater();
    } catch (err) {
      console.error(err);
      setShareMessage("이미지 저장에 실패했습니다.");
    } finally {
      setShareBusy(null);
    }
  };

  const handleShareImage = async () => {
    try {
      setShareBusy("image");
      const blob = await createShareImageBlob();
      const file = new File([blob], `bgms-ai-squad-${nickname}.png`, { type: "image/png" });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: "BGMS AI 스쿼드 분석 리포트",
          text: `${nickname}님의 AI 스쿼드 전술 분석 결과`,
          files: [file],
        });
        trackEvent({ name: "share_clicked", params: { method: "image_share", page: "squad" } });
        setShareMessage("이미지 공유 시트를 열었어요.");
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        URL.revokeObjectURL(url);
        setShareMessage("이미지 공유가 지원되지 않아 파일로 저장했어요.");
      }
      clearShareMessageLater();
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        setShareMessage("이미지 공유에 실패했습니다.");
      }
    } finally {
      setShareBusy(null);
    }
  };

  const handleSelectCauseSceneMatch = (matchId: string, anchorMs: number) => {
    setSelectedMapMatchId(matchId);
    setSelectedFocusTimeMs(anchorMs);
    setShowMap(true);
    trackEvent({
      name: "replay_2d_opened",
      params: {
        nickname,
        match_id: matchId
      }
    });
    window.setTimeout(() => {
      document.getElementById("squad-2d-map-feedback")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }, 80);
  };

  // Helper to compute SVG polygon points for Radar Chart
  const getRadarPoints = (scores: SquadAnalysisData["scores"]) => {
    const metrics = [
      scores.formation,    // Top
      scores.backupSpeed,  // Right-Top
      scores.survivalCare, // Right-Bottom
      scores.focusFire,    // Left-Bottom
      scores.teamWipe      // Left-Top
    ];
    
    return metrics.map((score, i) => {
      const angle = (i * 72 - 90) * (Math.PI / 180);
      const radius = 80 * (score / 100);
      const x = 100 + radius * Math.cos(angle);
      const y = 100 + radius * Math.sin(angle);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  };

  if (loadingList) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
        <span className="ml-2 text-zinc-400">스쿼드 그룹 목록을 감지하는 중...</span>
      </div>
    );
  }

  if (groups.length === 0) {
    if (listError) {
      return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-8 text-center">
          <ShieldAlert className="mx-auto mb-2 h-12 w-12 text-red-400" />
          <p className="text-zinc-200">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
          <button
            type="button"
            onClick={() => void fetchSquadGroups()}
            className="mt-4 rounded-lg border border-red-400/30 px-4 py-2 text-xs font-bold text-red-200 transition-colors hover:bg-red-400/10"
          >
            다시 시도
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <ShieldAlert className="mx-auto h-12 w-12 text-zinc-600 mb-2" />
        <p className="text-zinc-400">최근 20경기 중 분석할 수 있는 스쿼드 모드 파티 게임 기록이 없습니다.</p>
        <p className="text-zinc-500 text-sm mt-1">솔로나 듀오 모드를 제외하고, 스쿼드 매치 데이터를 추가로 검색해 주세요.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Squad Selector Dropdown */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4 backdrop-blur-md">
        <div>
          <h3 className="font-semibold text-zinc-200">스쿼드 시너지 분석</h3>
          <p className="text-xs text-zinc-500">최근 20경기에서 감지된 고정 팀원 파티와의 전술 분석입니다.</p>
        </div>
        <div className="relative">
          <select
            aria-label="스쿼드 그룹"
            value={groupKey ?? ""}
            onChange={(e) => onGroupKeyChange(e.target.value)}
            className="w-full sm:w-72 appearance-none rounded-lg border border-zinc-800 bg-zinc-955 px-4 py-2 pr-10 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-purple-500"
          >
            {groups.map((g) => (
              <option key={g.groupKey} value={g.groupKey}>
                {g.members.length + 1}인 파티 ({g.matchCount}경기) - {g.groupKey.slice(0, 30)}...
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-2.5 h-4 w-4 text-zinc-500 pointer-events-none" />
        </div>
      </div>

      {loadingDetail && (
        <div className="flex h-60 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
          <span className="ml-2 text-zinc-400">선택된 스쿼드 시너지를 집계 분석 중...</span>
        </div>
      )}

      {detailError && !loadingDetail && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
          <p className="text-sm text-red-200">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
          <button
            type="button"
            onClick={() => void fetchSquadDetails()}
            className="mt-3 rounded-lg border border-red-400/30 px-4 py-2 text-xs font-bold text-red-200 transition-colors hover:bg-red-400/10"
          >
            다시 시도
          </button>
        </div>
      )}

      {analysisData && !loadingDetail && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Panel: Synergy Radar Chart & Stats Summary */}
          <div className="lg:col-span-5 rounded-xl border border-zinc-800/60 bg-zinc-900/20 p-5 space-y-6">
            <div className="text-center">
              <span className="text-xs font-semibold text-purple-400 tracking-wider uppercase">Synergy Radar</span>
              <h4 className="text-lg font-bold text-zinc-200 mt-1">협동 시너지 밸런스</h4>
            </div>

            {/* Radar Chart SVG */}
            <div className="relative flex justify-center">
              <svg width="220" height="220" viewBox="0 0 200 200" className="drop-shadow-lg">
                {/* Radial Grid lines (20, 40, 60, 80, 100%) */}
                {[0.2, 0.4, 0.6, 0.8, 1.0].map((scale, index) => {
                  const r = 80 * scale;
                  const pts = Array.from({ length: 5 }).map((_, i) => {
                    const angle = (i * 72 - 90) * (Math.PI / 180);
                    return `${(100 + r * Math.cos(angle)).toFixed(1)},${(100 + r * Math.sin(angle)).toFixed(1)}`;
                  }).join(" ");
                  return (
                    <polygon
                      key={index}
                      points={pts}
                      fill="none"
                      stroke="rgba(63, 63, 70, 0.35)"
                      strokeWidth="1"
                    />
                  );
                })}

                {/* Central axes */}
                {Array.from({ length: 5 }).map((_, i) => {
                  const angle = (i * 72 - 90) * (Math.PI / 180);
                  const x = 100 + 80 * Math.cos(angle);
                  const y = 100 + 80 * Math.sin(angle);
                  return (
                    <line
                      key={i}
                      x1="100"
                      y1="100"
                      x2={x}
                      y2={y}
                      stroke="rgba(63, 63, 70, 0.25)"
                      strokeWidth="1"
                    />
                  );
                })}

                {/* Plot Data Polygon */}
                <polygon
                  points={getRadarPoints(analysisData.scores)}
                  fill="rgba(168, 85, 247, 0.2)"
                  stroke="rgba(168, 85, 247, 0.85)"
                  strokeWidth="2"
                />

                {/* Data Points */}
                {Array.from({ length: 5 }).map((_, i) => {
                  const metrics = [
                    analysisData.scores.formation,
                    analysisData.scores.backupSpeed,
                    analysisData.scores.survivalCare,
                    analysisData.scores.focusFire,
                    analysisData.scores.teamWipe
                  ];
                  const angle = (i * 72 - 90) * (Math.PI / 180);
                  const radius = 80 * (metrics[i] / 100);
                  const x = 100 + radius * Math.cos(angle);
                  const y = 100 + radius * Math.sin(angle);
                  return (
                    <circle
                      key={i}
                      cx={x}
                      cy={y}
                      r="3"
                      fill="#a855f7"
                      stroke="#18181b"
                      strokeWidth="1"
                    />
                  );
                })}
              </svg>
 
              {/* Dynamic Axis Labels */}
              <div className="absolute top-0 text-[10px] text-zinc-300 font-semibold">대열 유지 ({analysisData.scores.formation})</div>
              <div className="absolute right-0 top-1/3 text-[10px] text-zinc-300 font-semibold text-right">백업 속도 ({analysisData.scores.backupSpeed})</div>
              <div className="absolute right-8 bottom-4 text-[10px] text-zinc-300 font-semibold">생존 케어 ({analysisData.scores.survivalCare})</div>
              <div className="absolute left-8 bottom-4 text-[10px] text-zinc-300 font-semibold">화력 집중 ({analysisData.scores.focusFire})</div>
              <div className="absolute left-0 top-1/3 text-[10px] text-zinc-300 font-semibold text-left">전멸 기여 ({analysisData.scores.teamWipe})</div>
            </div>
 
            {/* Synergy metrics key-value list */}
            <div className="rounded-lg bg-zinc-950/60 p-3.5 space-y-3.5 text-xs border border-zinc-800/40">
              {(() => {
                const normalizedSearchName = nickname.toLowerCase().replace(/[^a-zA-Z0-9_]/g, "");
                const myProfile = analysisData.roleProfiles.find(
                  p => p.name.toLowerCase().replace(/[^a-zA-Z0-9_]/g, "") === normalizedSearchName
                );
                const squadAvgDamage = Math.round(
                  analysisData.roleProfiles.reduce((sum, p) => sum + p.avgDamage, 0) / Math.max(1, analysisData.roleProfiles.length)
                );
                const squadAvgKills = (
                  analysisData.roleProfiles.reduce((sum, p) => sum + p.avgKills, 0) / Math.max(1, analysisData.roleProfiles.length)
                ).toFixed(1);

                return (
                  <>
                    <div className="flex justify-between border-b border-zinc-900 pb-2">
                      <span className="text-zinc-400 font-medium flex items-center gap-1.5">
                        <InlineIconLabel icon="rank">스쿼드 협동 등급</InlineIconLabel>
                      </span>
                      <span className="text-purple-400 font-black text-sm tracking-wide bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/15">
                        {analysisData.squadGrade} Grade
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-zinc-900 pb-2">
                      <span className="text-zinc-400 font-medium">내 평균 딜량 / 킬</span>
                      <span className="text-purple-300 font-bold">
                        {myProfile ? `${Math.round(myProfile.avgDamage)}딜 / ${myProfile.avgKills}킬` : "N/A"}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-zinc-900 pb-2">
                      <span className="text-zinc-400 font-medium">스쿼드 평균 딜량 / 킬</span>
                      <span className="text-zinc-100 font-bold">{squadAvgDamage}딜 / {squadAvgKills}킬</span>
                    </div>
                  </>
                );
              })()}
              
              <div className="flex flex-col gap-1 border-b border-zinc-900 pb-2">
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-medium">평균 대열 이탈율 (고립)</span>
                  <span className={`font-bold ${analysisData.stats.avgIsolation > 3.5 ? "text-red-400" : "text-zinc-100"}`}>
                    {analysisData.stats.avgIsolation} (평균)
                  </span>
                </div>
                {analysisData.benchmarkStats && (
                  <div className="text-[10px] text-zinc-500 text-right -mt-0.5">
                    {analysisData.benchmarkStats.tier}티어 기준치: {analysisData.benchmarkStats.avgIsolation} (낮을수록 우수)
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1 border-b border-zinc-900 pb-2">
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-medium">평균 백업 반응 속도 (트레이드)</span>
                  <span className="text-zinc-100 font-bold">
                    {analysisData.stats.avgTradeLatency > 0
                      ? `${(analysisData.stats.avgTradeLatency / 1000).toFixed(2)}초`
                      : "측정 불가"}
                  </span>
                </div>
                {analysisData.benchmarkStats && (
                  <div className="text-[10px] text-zinc-500 text-right -mt-0.5">
                    {analysisData.benchmarkStats.tier}티어 기준치: {(analysisData.benchmarkStats.avgTradeLatency / 1000).toFixed(2)}초 (빠를수록 우수)
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1 border-b border-zinc-900 pb-2">
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-medium">누적 세이브 (연막/소생)</span>
                  <span className="text-zinc-100 font-bold">{analysisData.stats.totalSmokeRescues}회 / {analysisData.stats.totalRevives}회</span>
                </div>
                {analysisData.benchmarkStats && (
                  <div className="text-[10px] text-zinc-500 text-right -mt-0.5">
                    {analysisData.benchmarkStats.tier}티어 기준치 (경기당 평균): 부활 {analysisData.benchmarkStats.avgReviveRate}% / 연막 {analysisData.benchmarkStats.avgSmokeRate}%
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1 border-b border-zinc-900 pb-2">
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-medium">평균 아군 집중사격 커버율</span>
                  <span className="text-zinc-100 font-bold">{Math.round(analysisData.stats.avgCoverRate * 100)}%</span>
                </div>
                <div className="text-[10px] text-zinc-500 text-right -mt-0.5">
                  글로벌 권장 기준치: 30% 이상
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-medium">적 스쿼드 전멸 유발 수</span>
                  <span className="text-purple-300 font-bold">{analysisData.stats.totalTeamWipes}회 전멸</span>
                </div>
                {analysisData.benchmarkStats && (
                  <div className="text-[10px] text-zinc-500 text-right -mt-0.5">
                    {analysisData.benchmarkStats.tier}티어 기준치: 경기당 평균 {analysisData.benchmarkStats.avgTeamWipes}회
                  </div>
                )}
              </div>
            </div>
          </div>
 
          {/* Right Panel: Squad Teammate Cards & Role Profiles */}
          <div className="lg:col-span-7 space-y-4">
            <h5 className="font-bold text-zinc-200 text-sm">스쿼드원 역할 분담 프로필</h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {analysisData.roleProfiles.map((p) => (
                <div key={p.name} className="rounded-xl border border-zinc-800/50 bg-zinc-900/10 p-4 space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="font-bold text-zinc-100 text-sm block truncate w-32">{p.name}</span>
                      <div className="flex flex-col text-[10px] text-zinc-400 mt-0.5">
                        <span>평균 {Math.round(p.avgDamage)}딜 / {p.avgKills}킬</span>
                        {p.totalDamage !== undefined && p.totalKills !== undefined && (
                          <span className="text-zinc-500 font-medium">총 {Math.round(p.totalDamage)}딜 / {p.totalKills}킬 ({analysisData.matchCount}판 누적)</span>
                        )}
                      </div>
                    </div>
                    <span className="rounded bg-purple-500/15 border border-purple-500/20 px-2 py-0.5 text-xs text-purple-400 font-medium">
                      {p.role}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed min-h-[36px] font-medium">
                    {p.roleDesc}
                  </p>
                  
                  {/* Share Graphs */}
                  <div className="space-y-1 text-[10px]">
                    <div className="flex justify-between text-zinc-400">
                      <span>딜량 기여</span>
                      <span className="text-zinc-200 font-semibold">{p.shares.damage}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div className="h-full bg-purple-500" style={{ width: `${p.shares.damage}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {analysisData?.causeScenes && analysisData.causeScenes.length > 0 && (
        <SquadCauseScenes
          scenes={analysisData.causeScenes}
          selectedMatchId={selectedMapMatchId}
          onSelectMatch={handleSelectCauseSceneMatch}
          teamNames={analysisData?.roleProfiles?.map((p) => p.name) || [nickname]}
        />
      )}
 
      {/* AI Coaching Section */}
      {analysisData && (
        <div className="rounded-xl border border-purple-500/10 bg-purple-950/5 p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400">
                <Flame className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-bold text-zinc-200">AI 스쿼드 분석 피드백</h4>
                <p className="text-xs text-zinc-400">현재 스쿼드 지표를 토대로 분석한 Gemini의 협동 보고서입니다.</p>
              </div>
            </div>
            
            {/* Tone Toggle & Request Button */}
            <div className="flex items-center gap-3">
              <div className="flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
                <button
                  onClick={() => setCoachingStyle("spicy")}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${coachingStyle === "spicy" ? "bg-purple-600 text-white" : "text-zinc-400 hover:text-zinc-250"}`}
                >
                  매운맛 (Spicy)
                </button>
                <button
                  onClick={() => setCoachingStyle("mild")}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${coachingStyle === "mild" ? "bg-purple-600 text-white" : "text-zinc-400 hover:text-zinc-250"}`}
                >
                  다정한맛 (Mild)
                </button>
              </div>
              
              <button
                onClick={requestAiCoaching}
                disabled={loadingAi}
                className="flex items-center justify-center rounded-lg bg-purple-600 hover:bg-purple-700 px-4 py-2 text-xs font-semibold text-white transition-all disabled:opacity-50"
              >
                {loadingAi ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    분석 중...
                  </>
                ) : "AI 코칭 보고서 생성"}
              </button>
            </div>
          </div>
 
          {aiError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-center">
              <p className="text-sm text-red-200">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
              <button
                type="button"
                onClick={requestAiCoaching}
                className="mt-3 rounded-lg border border-red-400/30 px-3 py-1.5 text-xs font-bold text-red-200 transition-colors hover:bg-red-400/10"
              >
                다시 시도
              </button>
            </div>
          )}

          {/* AI Result View */}
          {aiFeedback && (
            <div className="space-y-4 pt-4 border-t border-purple-500/10">
              {/* 캡처 타겟 박스 (resultCardRef) */}
              <div
                ref={resultCardRef}
                className="p-6 rounded-2xl bg-[#0c0a1f] border border-purple-500/20 shadow-xl flex flex-col gap-6"
              >
                <div className="flex flex-col md:grid md:grid-cols-12 gap-6">
                  {/* Grade Shield */}
                  <div className="w-full md:col-span-3 flex flex-col items-center justify-center text-center p-5 rounded-2xl bg-purple-950/15 border border-purple-500/10 h-fit min-w-0 md:min-w-[180px] shrink-0">
                    <span className="text-xs text-purple-400 font-bold tracking-wide">Squad Grade</span>
                    <div className="relative flex items-center justify-center h-20 w-20 my-3">
                      <Award className="h-16 w-16 text-purple-500" />
                      <span className="absolute text-xl font-black text-white">{aiFeedback.squadGrade}</span>
                    </div>
                    <p className="text-xs text-zinc-200 font-semibold max-w-[200px] break-keep text-center leading-relaxed">{aiFeedback.summary}</p>
                  </div>
     
                  {/* Detail Content */}
                  <div className="w-full md:col-span-9 space-y-4 min-w-0">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="rounded-lg bg-zinc-950/40 p-4 border border-zinc-800/40">
                        <h5 className="text-xs font-bold text-green-400 mb-1 flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                          스쿼드 협동 강점
                        </h5>
                        <p className="text-xs text-zinc-200 leading-relaxed font-medium">{aiFeedback.strength}</p>
                      </div>
                      <div className="rounded-lg bg-zinc-950/40 p-4 border border-zinc-800/40">
                        <h5 className="text-xs font-bold text-red-400 mb-1 flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                          스쿼드 취약점
                        </h5>
                        <p className="text-xs text-zinc-200 leading-relaxed font-medium">{aiFeedback.weakness}</p>
                      </div>
                    </div>
     
                    <div className="rounded-lg bg-purple-950/10 p-4 border border-purple-500/10">
                      <h5 className="text-xs font-bold text-purple-300 mb-1">
                        <InlineIconLabel icon="info" iconSize={13}>전술적 개선 코칭 제안</InlineIconLabel>
                      </h5>
                      <p className="text-xs text-zinc-100 leading-relaxed font-medium">{aiFeedback.coaching}</p>
                    </div>
                  </div>

                  {/* 팀원 개별 피드백 */}
                  {aiFeedback.memberFeedbacks && aiFeedback.memberFeedbacks.length > 0 && (
                    <div className="col-span-12 border-t border-purple-500/10 pt-6 space-y-4">
                      <h5 className="font-bold text-zinc-200 text-xs flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                        <InlineIconLabel icon="team" iconSize={13}>팀원 개별 AI 평가 및 피드백</InlineIconLabel>
                      </h5>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {aiFeedback.memberFeedbacks.map((member: any) => (
                          <div key={member.name} className="rounded-xl border border-zinc-800/50 bg-zinc-950/40 p-4 space-y-3.5 shadow-sm">
                            <div className="flex justify-between items-center border-b border-zinc-900 pb-2">
                              <span className="font-bold text-purple-300 text-xs">{member.name}</span>
                              <span className="text-[9px] bg-purple-500/15 border border-purple-500/20 text-purple-400 font-black px-2 py-0.5 rounded uppercase tracking-wider">Teammate</span>
                            </div>
                            
                            <div className="space-y-2.5">
                              {/* 칭찬할 점 */}
                              <div className="text-[11px] leading-relaxed">
                                <div className="font-bold text-green-400 flex items-center gap-1 mb-0.5">
                                  <InlineIconLabel icon="check" iconSize={12}>칭찬할 점</InlineIconLabel>
                                </div>
                                <p className="text-zinc-300 pl-1 font-medium">{member.praise}</p>
                              </div>
                              
                              {/* 못한 점 */}
                              <div className="text-[11px] leading-relaxed">
                                <div className="font-bold text-red-400 flex items-center gap-1 mb-0.5">
                                  <InlineIconLabel icon="alert" iconSize={12}>못한 점</InlineIconLabel>
                                </div>
                                <p className="text-zinc-300 pl-1 font-medium">{member.fault}</p>
                              </div>
                              
                              {/* 피드백 */}
                              <div className="text-[11px] leading-relaxed">
                                <div className="font-bold text-purple-400 flex items-center gap-1 mb-0.5">
                                  <InlineIconLabel icon="info" iconSize={12}>개인 피드백</InlineIconLabel>
                                </div>
                                <p className="text-zinc-300 pl-1 font-medium">{member.advice}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 팀 전체 총평 */}
                  {aiFeedback.overallOpinion && (
                    <div className="col-span-12 border-t border-purple-500/10 pt-4">
                      <div className="rounded-xl bg-gradient-to-r from-purple-950/20 to-zinc-950/60 p-5 border border-purple-500/15 shadow-md">
                        <h5 className="text-xs font-bold text-purple-300 mb-2 flex items-center gap-2">
                          <Flame className="h-4 w-4 text-purple-400 fill-purple-400/20" />
                          팀 전체 총평 (AI 코치의 한마디)
                        </h5>
                        <p className="text-xs text-zinc-200 leading-relaxed font-semibold">{aiFeedback.overallOpinion}</p>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* 브랜딩 워터마크 추가 */}
                <div className="text-center text-[10px] font-black tracking-[0.2em] text-purple-400/35 border-t border-purple-500/10 pt-4 mt-2">
                  BGMS AI SQUAD PERFORMANCE REPORT
                </div>
              </div>

              {/* 공유 버튼 그룹 */}
              <div className="rounded-2xl border border-purple-500/10 bg-purple-950/[0.03] p-5 backdrop-blur-xl">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-black text-zinc-200">분석결과 공유하기</div>
                    <div className="text-xs text-zinc-500 mt-1">스쿼드 보고서를 링크로 공유하거나, 이미지로 캡처하여 소장할 수 있습니다.</div>
                  </div>
                  {shareMessage && (
                    <div className="text-xs font-bold text-emerald-400 animate-pulse">{shareMessage}</div>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <button
                    onClick={handleShareLink}
                    disabled={shareBusy !== null}
                    className="h-10 rounded-xl border border-sky-500/20 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition-all font-bold text-xs flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Share2 size={14} />
                    {shareBusy === "share" ? "공유 중..." : "링크 공유"}
                  </button>
                  <button
                    onClick={handleCopyLink}
                    disabled={shareBusy !== null}
                    className="h-10 rounded-xl border border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800 transition-all font-bold text-xs flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Copy size={14} />
                    {shareBusy === "copy" ? "복사 중..." : "링크 복사"}
                  </button>
                  <button
                    onClick={handleShareImage}
                    disabled={shareBusy !== null}
                    className="h-10 rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-all font-bold text-xs flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Camera size={14} />
                    {shareBusy === "image" ? "생성 중..." : "이미지 공유"}
                  </button>
                  <button
                    onClick={handleDownloadImage}
                    disabled={shareBusy !== null}
                    className="h-10 rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all font-bold text-xs flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Download size={14} />
                    {shareBusy === "download" ? "저장 중..." : "이미지 저장"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2D Map Trajectory Section (V3.2) */}
      {analysisData && analysisData.matchesSummary && analysisData.matchesSummary.length > 0 && (
        <div id="squad-2d-map-feedback" className="scroll-mt-24 rounded-xl border border-zinc-800/60 bg-zinc-900/10 p-5 space-y-4">
          <button
            onClick={() => setShowMap(!showMap)}
            className="w-full flex items-center justify-between text-left cursor-pointer group focus:outline-none"
          >
            <div>
              <h4 className="font-bold text-zinc-200 group-hover:text-purple-400 transition-colors flex items-center gap-2 text-sm sm:text-base">
                <InlineIconLabel icon="map" iconSize={16}>교전 동선 2D 맵 피드백</InlineIconLabel>
              </h4>
              <p className="text-xs text-zinc-400 mt-0.5">아군 최초 기절 당시의 대열 배치를 2D 지도로 분석합니다.</p>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-850 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-400 font-semibold group-hover:border-purple-500 group-hover:text-purple-400 transition-all shrink-0">
              {showMap ? "지도 접기" : "지도 펼치기"}
              {showMap ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </div>
          </button>

          {/* Collapsible Content */}
          {showMap && (
            <div className="space-y-4 pt-4 border-t border-zinc-800/40">
              {/* Match Selector Chips (Scrollable on Mobile) */}
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none whitespace-nowrap -mx-4 px-4 sm:mx-0 sm:px-0">
                {analysisData.matchesSummary.map((m) => (
                  <button
                    key={m.matchId}
                    onClick={() => setSelectedMapMatchId(m.matchId)}
                    className={`inline-block rounded-full px-4 py-1.5 text-xs font-bold transition-all border cursor-pointer ${
                      selectedMapMatchId === m.matchId
                        ? "bg-purple-600 border-purple-500 text-white shadow-md shadow-purple-500/10"
                        : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {m.mapDisplayName} ({m.winPlace}등)
                  </button>
                ))}
              </div>

              {/* 2D Map Component */}
              {selectedMapMatchId && (
                <Squad2DMap
                  key={`${selectedMapMatchId}-${selectedFocusTimeMs ?? "default"}`}
                  matchId={selectedMapMatchId}
                  nickname={nickname}
                  platform={platform}
                  mapName={analysisData.matchesSummary.find((m) => m.matchId === selectedMapMatchId)?.mapName || "Baltic_Main"}
                  focusTimeMs={selectedFocusTimeMs}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
