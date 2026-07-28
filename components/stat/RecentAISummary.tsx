"use client";

import React, { useState } from "react";
import { ShieldAlert, Clock, TrendingUp, TrendingDown, Minus, Flame, Skull, Target, HelpCircle, Zap, Brain, X, ChevronDown, ChevronUp } from "lucide-react";
import { getNextTierInfo } from "@/lib/pubg-analysis/benchmarkScore";

import { IsolationRadar } from "./IsolationRadar";
import { SpiderChart } from "./SpiderChart";
import { MapKingCard } from "./MapKingCard";
import { useEffect, useRef } from "react";
import { useAIStatus, aiManager } from "@/lib/ai-management";
import { useAuth } from "@/components/AuthProvider";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { BgmsIcon, type BgmsIconName } from "@/components/common/BgmsIcon";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

interface DebateStat {
  label: string;
  value: string;
}

function getAiTierIconName(tier?: string | null): BgmsIconName {
  if (tier === "S") return "award";
  if (tier?.startsWith("A")) return "flame";
  if (tier?.startsWith("B")) return "battle";
  if (tier?.startsWith("C")) return "zap";
  return "shield";
}

interface DebateIssue {
  topic: string;
  question: string;
  kindOpinion: string;
  spicyOpinion: string;
  winner: "kind" | "spicy" | "draw";
  userStats: DebateStat[];
  benchmarkStats: DebateStat[];
}

interface ActionItem {
  icon: string;
  title: string;
  desc: string;
}

interface DebateData {
  debateIssues: DebateIssue[];
  finalVerdict: string;
  weaknessDiagnostic?: string;
  actionItems: ActionItem[];

  signature?: string;
  signatureSub?: string;
  visuals?: {
    // ✅ API 응답 실제 구조에 맞게 정리: latency 객체는 미사용, counterLatency만 실제 사용됨
    counterLatency: string;
    tierBreakdown?: {
      combat: number;
      tactical: number;
      survival: number;
      total: number;
    };
    latestMatchTime?: string;
    reactionLatency: string;
    reactionTier?: string;
    backupTier?: string;
    overallTier?: string;
    roleInfo?: {
      primaryRole: string;
      secondaryRole: string | null;
      title: string;
      roleLabel: string;
      description: string;
      signatureWeapon: string;
      signatureWeaponStats?: { kills: number; dbnos: number; consistency?: number; isReliable?: boolean };
      weakness?: string | null;
      scores: Record<string, number>;
    };

    initiativeSuccess: string;
    duelStats?: { winRate: string; wins: number; losses: number; reversals: number; reversalAttempts: number };
    reversalRate: string;
    coverRate: string;
    goldenTime?: { early: number; mid1: number; mid2: number; late: number };
    killContrib?: { solo: number; cleanup: number };
    deathPhase?: number;
    bluezoneWaste?: number;
    modeDistribution?: {
      ranked: number;
      normal: number;
      main: string;
    };
    mapStats?: {
      list: Array<{
        mapName: string;
        displayName: string;
        matchCount: number;
        avgDamage: number;
        avgKills: number;
        avgDeathPhase: number;
      }>;
      bestMap: { mapName: string; displayName: string; matchCount: number; avgDamage: number; avgKills: number; avgDeathPhase: number };
      worstMap: { mapName: string; displayName: string; matchCount: number; avgDamage: number; avgKills: number; avgDeathPhase: number };
    } | null;
    weaknessDiagnostic?: string;
    trends?: {
      dmgTrend: number;
      winTrend: number;
      status: string;
      recent: { damage: number; winRate: number };
      older: { damage: number; winRate: number };
    } | null;

    tactical?: {

      suppRate: string;
      smokeRate: string;
      reviveRate: string;
      baitCount: number;
      counts?: {
        knocks: number;
        smokes: number;
        rescueSmokes?: number;
        smokeRescues: number;
        revives: number;
        trades: number;
        supps: number;
        enemyTeamWipes: number;
        initiative: { attempts: number; success: number };
      };
      isolation?: {
        isolationIndex: number;
        minDist: number;
        heightDiff: number;
        isCrossfire: boolean;
        teammateCount: number;
      };
    };
  };
}

const getRelativeTime = (dateStr: string) => {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffInMs = now.getTime() - date.getTime();
  const diffInMins = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInDays > 0) return `${diffInDays}일 전`;
  if (diffInHours > 0) return `${diffInHours}시간 전`;
  if (diffInMins > 0) return `${diffInMins}분 전`;
  return "방금 전";
};

export const RecentAISummary = ({ matchIds, nickname, platform, isMobile }: { matchIds: string[]; nickname: string; platform: string; isMobile?: boolean }) => {
  const [debateData, setDebateData] = useState<DebateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openIssueIdx, setOpenIssueIdx] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showTierTooltip, setShowTierTooltip] = useState(false);
  const [activeStatTooltip, setActiveStatTooltip] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const statTooltipRef = useRef<HTMLDivElement>(null);

  const textBufferRef = useRef("");
  const lineBufferRef = useRef("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const isLoadingRef = useRef(false);
  // [AUTO-RETRY] 일시적 Gemini 스트림 오류 자동 재시도
  const retryCountRef = useRef(0);
  const MAX_AUTO_RETRIES = 1;
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const { isAnalyzing: isGlobalAnalyzing } = useAIStatus();
  const { user } = useAuth();
  const router = useRouter();

  /** 일시적 오류 판별 (Failed to parse stream, 네트워크 순단, 서버 과부하 등) */
  const isTransientError = (msg: string) => {
    const lower = msg.toLowerCase();
    return (
      lower.includes('parse stream') ||
      lower.includes('network') ||
      lower.includes('fetch') ||
      lower.includes('timeout') ||
      lower.includes('overloaded') ||
      lower.includes('503') ||
      lower.includes('502') ||
      lower.includes('500')
    );
  };

  const handleFetchSummary = async (force = false) => {
    // 🔒 [보안] 비로그인 유저 AI 요약 차단 — 로그인 유도 토스트
    if (!user) {
      toast.error("AI 전술 분석은 로그인 후 이용할 수 있습니다.", {
        action: {
          label: "로그인",
          onClick: () => router.push("/login"),
        },
      });
      return;
    }

    // 🔄 [세션 동기화] API fetch 전 브라우저 쿠키를 최신 세션 토큰으로 강제 동기화 (401 방지)
    try {
      await supabase.auth.getSession();
    } catch (e) {
      console.warn("[AI-SUMMARY] Session refresh failed (ignored):", e);
    }

    // [V46.1] 전역 락 체크 및 중복 실행 방지
    if (isGlobalAnalyzing || loading || isLoadingRef.current || (!force && debateData)) return;

    if (!aiManager.startAnalysis("summary")) return;

    // 수동 시작 시 재시도 카운트 초기화
    if (!retryCountRef.current) retryCountRef.current = 0;
    setRetryMessage(null);

    setLoading(true);
    isLoadingRef.current = true;
    setError(null);
    setStreamingText("");

    if (force) {
      setDebateData(null);
      textBufferRef.current = "";
      lineBufferRef.current = "";
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // 서버의 전체 AI 생성 제한(약 22초)보다 길게 두어 fallback 응답까지 수신한다.
    const safetyTimeout = setTimeout(() => {
      if (isLoadingRef.current) {
        console.warn("[AI-SUMMARY] Safety timeout triggered. Forcing cleanup.");
        readerRef.current?.cancel().catch(() => {});
        abortController.abort();
        // 타임아웃도 자동 재시도 대상
        if (retryCountRef.current < MAX_AUTO_RETRIES) {
          retryCountRef.current++;
          setRetryMessage(`AI 서버 응답이 느려요. 잠깐만요... (${retryCountRef.current}/${MAX_AUTO_RETRIES})`);
          setLoading(false);
          isLoadingRef.current = false;
          aiManager.stopAnalysis("summary");
          setTimeout(() => { setRetryMessage(null); handleFetchSummary(true); }, 2500);
        } else {
          retryCountRef.current = 0;
          setError("분석 서버 응답이 너무 느립니다. 잠시 후 다시 시도해주세요.");
          setLoading(false);
          isLoadingRef.current = false;
          aiManager.stopAnalysis("summary");
        }
      }
    }, 35000);

    // GA4 이벤트 트래킹: 10경기 요약 시작
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "ai-coaching",
        status: "start"
      }
    });

    try {
      const response = await fetch('/api/pubg/ai-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          matchIds,
          nickname,
          platform,
          force
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "분석 서버 응답 오류가 발생했습니다.");
      }

      const reader = response.body?.getReader();
      // [MOBILE-FIX] ref에 저장해 safety timeout에서도 cancel() 호출 가능하게
      readerRef.current = reader ?? null;
      const decoder = new TextDecoder();
      let fullText = "";

      // [V45.3] UI 업데이트를 위한 인터벌 (스트리밍 시각화용)
      const updateInterval = setInterval(() => {
        if (textBufferRef.current !== streamingText) {
          setStreamingText(textBufferRef.current);
        }
      }, 100);

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            lineBufferRef.current += chunk;

            const lines = lineBufferRef.current.split("\n");
            lineBufferRef.current = lines.pop() || "";

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;

              try {
                const parsed = JSON.parse(trimmedLine);

                if (parsed.type === "visuals") {
                  // 비주얼 데이터가 오면 로딩을 풀고 UI를 보여줌
                  setDebateData(prev => ({ ...prev, visuals: parsed.data } as any));
                  setLoading(false);
                } else if (parsed.type === "chunk") {
                  textBufferRef.current += parsed.data;
                  fullText += parsed.data;
                } else if (parsed.type === "final") {
                  // [V54.3] 서버에서 보내준 최종 정제된 JSON으로 교체 (중복 방지)
                  fullText = parsed.data;
                } else if (parsed.type === "done") {
                  if (parsed.valid === false) {
                    const errMsg = parsed.error || "서버 분석 도중 오류가 발생했습니다.";
                    console.error("[AI-SUMMARY] Server reported failure:", errMsg);
                    if (isTransientError(errMsg) && retryCountRef.current < MAX_AUTO_RETRIES) {
                      retryCountRef.current++;
                      setRetryMessage(`AI 서버가 잠깐 바빴어요. 자동으로 재시도 중이에요. (${retryCountRef.current}/${MAX_AUTO_RETRIES})`);
                      setTimeout(() => { setRetryMessage(null); handleFetchSummary(true); }, 2500);
                    } else {
                      retryCountRef.current = 0;
                      setError("AI 분석 중 오류가 발생했어요. 다시 시도해주세요.");
                    }
                  } else {
                    try {
                      let cleanJson = fullText.trim();
                      const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
                      if (jsonMatch) cleanJson = jsonMatch[0];

                      const finalJson = JSON.parse(cleanJson);
                      setDebateData(prev => ({
                        ...finalJson,
                        visuals: prev?.visuals || finalJson.visuals
                      }));
                      retryCountRef.current = 0;

                      // GA4 이벤트 트래킹: 10경기 요약 성공
                      trackEvent({
                        name: "feature_consumption",
                        params: {
                          feature_name: "ai-coaching",
                          status: "success"
                        }
                      });
                    } catch (e: any) {
                      console.error("[AI-SUMMARY] Final result parse failed:", e);
                      setError("분석 결과 데이터 처리에 실패했습니다.");

                      // GA4 이벤트 트래킹: 10경기 요약 파싱 실패
                      trackEvent({
                        name: "feature_consumption",
                        params: {
                          feature_name: "ai-coaching",
                          status: "fail",
                          error_type: "parse_error"
                        }
                      });
                    }
                  }
                }
              } catch (e) {
                // 개별 라인 파싱 실패는 무시하되 로그 남김 (데이터가 잘렸을 경우 대비)
                console.warn("[AI-SUMMARY] Line parse error (ignored):", e);
              }
            }
          }
        } catch (readError: any) {
          if (readError.name === 'AbortError') {
            // 사용자가 페이지를 이탈하거나 안전 타임아웃이 동작한 정상 중단입니다.
          } else {
            throw readError;
          }
        } finally {
          clearInterval(updateInterval);
          setStreamingText(textBufferRef.current);
          setLoading(false);
          isLoadingRef.current = false;
          readerRef.current = null; // ref 정리
        }
      }

    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error("[AI-SUMMARY] Critical Error:", err);
        const errMsg = err.message || "알 수 없는 오류가 발생했습니다.";
        
        // GA4 이벤트 트래킹: 10경기 요약 실패
        trackEvent({
          name: "feature_consumption",
          params: {
            feature_name: "ai-coaching",
            status: "fail",
            error_type: errMsg
          }
        });

        // Failed to parse stream 등 일시적 에러 → 자동 재시도
        if (isTransientError(errMsg) && retryCountRef.current < MAX_AUTO_RETRIES) {
          retryCountRef.current++;
          setRetryMessage(`AI 서버가 잠깐 바빴어요. 자동으로 재시도 중이에요. (${retryCountRef.current}/${MAX_AUTO_RETRIES})`);
          setTimeout(() => { setRetryMessage(null); handleFetchSummary(true); }, 2500);
        } else {
          retryCountRef.current = 0;
          setError("AI 분석 중 오류가 발생했어요. 다시 시도해주세요.");
        }
      }
    } finally {
      clearTimeout(safetyTimeout);
      setLoading(false);
      isLoadingRef.current = false;
      readerRef.current = null; // ref 정리
      aiManager.stopAnalysis("summary");
      abortControllerRef.current = null;
    }
  };

  const getScore = () => {
    if (!debateData?.debateIssues) return { kind: 0, spicy: 0, draw: 0 };
    const scoreMap = { kind: 0, spicy: 0, draw: 0 };
    debateData.debateIssues.forEach(issue => {
      const w = issue.winner?.toLowerCase() || "";
      if (w.includes("spicy")) scoreMap.spicy++;
      else if (w.includes("kind")) scoreMap.kind++;
      else scoreMap.draw++;
    });
    return scoreMap;
  };

  const score = getScore();

  useEffect(() => {
    if (!showTierTooltip && !activeStatTooltip) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(event.target as Node)) {
        setShowTierTooltip(false);
      }
      if (statTooltipRef.current && !statTooltipRef.current.contains(event.target as Node)) {
        setActiveStatTooltip(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTierTooltip, activeStatTooltip, isMobile]);

  useEffect(() => {
    // [V40.9] 닉네임이 바뀌면 기존 데이터를 초기화하여 데이터 전이 방지
    setDebateData(null);
    setStreamingText("");
    textBufferRef.current = "";
    lineBufferRef.current = "";

    return () => {
      if (abortControllerRef.current) {
        // [MOBILE-FIX] reader도 명시적으로 cancel
        readerRef.current?.cancel().catch(() => {});
        readerRef.current = null;
        abortControllerRef.current.abort();
        aiManager.stopAnalysis("summary");
      }
    };
  }, [nickname]);

  // [AUTO-RETRY] 재시도 중 메시지 표시
  if (retryMessage) {
    return (
      <div className="p-8 bg-white/5 rounded-3xl border border-white/10 text-center">
        <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-indigo-300 text-sm font-medium">{retryMessage}</p>
        <p className="text-gray-600 text-xs mt-2">잠시만 기다려주세요</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-white/5 border border-white/10 rounded-2xl text-center">
        <BgmsIcon name="info" size={28} className="mx-auto mb-3 text-indigo-300" />
        <p className="text-gray-300 text-sm mb-1">AI 분석이 잠깐 막혔어요.</p>
        <p className="text-gray-500 text-xs mb-4">서버가 바쁘거나 네트워크가 불안정할 때 가끔 생겨요.</p>
        <button
          onClick={() => { retryCountRef.current = 0; setError(null); setDebateData(null); }}
          className="px-5 py-2 bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 rounded-xl text-sm hover:bg-indigo-500/30 transition-colors"
        >
          다시 시도하기
        </button>
      </div>
    );
  }

  if (!debateData && !loading) {
    // 🔒 비로그인 유저에게는 로그인 유도 CTA 표시
    if (!user) {
      return (
        <button
          onClick={() => router.push("/login")}
          className="w-full p-8 rounded-3xl font-bold flex flex-col items-center gap-4 transition-all active:scale-[0.98] bg-indigo-500/5 border-2 border-dashed border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10"
        >
          <LogIn size={40} />
          <div className="flex flex-col items-center gap-2">
            <span>로그인 후 AI 전술 분석을 이용할 수 있습니다</span>
            <span className="text-xs font-normal opacity-60">카카오/구글 로그인으로 간편하게 시작하세요</span>
          </div>
        </button>
      );
    }

    return (
      <button
        onClick={() => handleFetchSummary(true)}
        disabled={isGlobalAnalyzing || loading}
        className={`w-full p-8 rounded-3xl font-bold flex flex-col items-center gap-4 transition-all active:scale-[0.98] ${(isGlobalAnalyzing || loading)
          ? "bg-white/5 border border-white/10 text-gray-500 cursor-not-allowed grayscale"
          : "bg-indigo-500/5 border-2 border-dashed border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10"
          }`}
      >
        {isGlobalAnalyzing ? (
          <>
            <Clock size={40} className="text-gray-600" />
            <div className="flex flex-col items-center gap-2">
              <span className="italic">다른 AI 분석이 이미 진행 중입니다</span>
              <span className="text-xs font-normal opacity-40">이전 분석이 완료되거나 취소된 후 시도할 수 있습니다.</span>
            </div>
          </>
        ) : (
          <>
            <BgmsIcon name="flame" size={40} className="text-indigo-300" />
            <div className="flex flex-col items-center gap-2">
              <span>최근 10경기 AI 끝장 토론 시작</span>
              <span className="text-xs font-normal opacity-60">(기본지표는 10판이지만 10판중 잘한5판 티어높은5판 기준으로 상위권과 비교합니다)</span>
            </div>
          </>
        )}
      </button>
    );
  }

  // [V46.5] 로딩 중이지만 이미 데이터가 있는 경우(갱신 중)에는 전체 화면 스피너를 보여주지 않음 (Partial Loading)
  if (loading && !debateData) {
    return (
      <div className="p-12 bg-white/5 rounded-3xl border border-white/10 text-center">
        <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mx-auto mb-6" />
        <p className="text-gray-400 animate-pulse text-sm">AI 분석 엔진이 데이터 정합성을 체크 중입니다...</p>
      </div>
    );
  }

  const parseRate = (s: string | undefined) => {
    if (!s) return 0;
    const n = parseInt(s);
    return isNaN(n) ? 0 : n;
  };

  return (
    <div className="w-full flex flex-col gap-6">
      {/* [MOBILE-FIX] @container + animate-in 조합이 모바일 Chrome에서 전체 회전 유발 → 제거 */}
      {/* [V55.0] Premium Summary Dashboard & Toggle */}
      <div className="relative overflow-hidden bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent border border-white/10 rounded-[32px] p-1 shadow-2xl">
        <div className={`${isMobile ? "bg-[#161616]/95 backdrop-blur-none" : "bg-black/40 backdrop-blur-xl"} rounded-[30px] p-6 md:p-8 flex flex-col gap-6`}>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            {/* Left: Role & Title */}
            <div className="flex items-start gap-5">
              <div className="w-16 h-16 md:w-20 md:h-20 bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 rounded-2xl flex items-center justify-center border border-white/10 shadow-inner group">
                <Brain size={isMobile ? 32 : 40} className="text-indigo-400 group-hover:scale-110 transition-transform" />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-indigo-500/20 border border-indigo-500/30 rounded text-[10px] text-indigo-300 font-black tracking-widest uppercase">
                    최근 10경기 핵심 전술
                  </span>
                  {debateData?.visuals?.latestMatchTime && (
                    <span className="text-[10px] text-white/40 font-bold">{getRelativeTime(debateData.visuals.latestMatchTime)}</span>
                  )}
                </div>
                <h3 className="text-2xl md:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-white to-white/60 tracking-tight">
                  {debateData?.visuals?.roleInfo?.title || "전술 분석 결과"}
                </h3>
                <p className="text-xs md:text-sm text-indigo-300/80 font-bold leading-relaxed max-w-md break-words">
                  {debateData?.visuals?.roleInfo?.description || "데이터를 분석하여 당신의 플레이 스타일을 정의했습니다."}
                </p>
              </div>
            </div>

            {/* Right: Tier Badge */}
            <div className="flex items-center justify-center bg-white/5 border border-white/10 rounded-2xl p-4 md:px-8 md:py-6 shadow-xl backdrop-blur-sm self-center md:self-auto min-w-[140px]">
              <div className="flex flex-col items-center">
                <span className="text-[10px] text-white/30 font-black uppercase tracking-[0.2em] mb-1">종합 티어</span>
                <div className="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-white/40 drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]">
                  {debateData?.visuals?.overallTier || "N/A"}
                </div>
              </div>
            </div>
          </div>

          {/* Bottom: Quick Verdict & Action */}
          <div className="pt-6 border-t border-white/5 flex flex-col md:flex-row items-center gap-6">
            <div className="flex-1 text-center md:text-left min-w-0">
              <p className="text-sm md:text-base text-gray-300/90 font-medium leading-relaxed italic whitespace-pre-wrap break-words">
                &quot;{debateData?.finalVerdict || "분석 결과를 생성 중입니다..."}&quot;
              </p>
            </div>

            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={`group relative flex items-center justify-center gap-3 px-8 py-4 rounded-2xl font-black text-sm transition-all active:scale-95 whitespace-nowrap overflow-hidden ${isExpanded
                ? "bg-white/5 border border-white/10 text-white/70 hover:bg-white/10"
                : "bg-indigo-500 text-white shadow-[0_0_30px_rgba(99,102,241,0.4)] hover:shadow-[0_0_40px_rgba(99,102,241,0.6)]"
                }`}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
              {isExpanded ? (
                <>
                  <ChevronUp size={18} className="animate-bounce" />
                  간략히 보기
                </>
              ) : (
                <>
                  <ChevronDown size={18} className="animate-bounce" />
                  상세 분석 리포트 펼치기
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Detailed Stats Content (Collapsible) */}
      <div className={`flex flex-col gap-8 transition-all duration-500 origin-top ${isExpanded ? "opacity-100 max-h-[10000px] visible" : "opacity-0 max-h-0 invisible overflow-hidden"}`}>
        {/* [V6.2] 공간 분석 레이더 및 CLS 방지 Skeleton */}
        {(debateData?.visuals?.tactical?.isolation || (loading && !debateData)) && (
          <div className="min-h-[380px] w-full">
            {debateData?.visuals?.tactical?.isolation ? (
              <IsolationRadar
                data={debateData?.visuals?.tactical?.isolation}
                loading={loading}
                isMobile={isMobile}
              />
            ) : (
              <div className="w-full h-[380px] bg-white/5 rounded-[32px] border border-white/10 flex flex-col items-center justify-center gap-4 animate-pulse">
                <div className="w-20 h-20 border-4 border-emerald-500/10 border-t-emerald-500/40 rounded-full animate-spin" />
                <div className="h-4 w-48 bg-white/10 rounded-full" />
              </div>
            )}
          </div>
        )}


        {/* [V8.2 FIX] JSON 노출 방지 및 세련된 상태 메시지 제공 */}
        {!debateData?.debateIssues && (loading || streamingText) && (
          <div className="p-10 bg-indigo-500/5 border border-indigo-500/20 rounded-[40px] animate-in fade-in zoom-in duration-700 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-8 opacity-10">
              <TrendingUp size={80} className="text-indigo-400 animate-pulse" />
            </div>

            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="relative">
                  <div className="w-4 h-4 bg-emerald-500 rounded-full animate-ping" />
                  <div className="absolute inset-0 w-4 h-4 bg-emerald-500 rounded-full" />
                </div>
                <span className="text-[12px] text-emerald-400 font-black uppercase tracking-[0.3em]">AI 전술 분석 엔진</span>
              </div>

              <div className="space-y-4">
                <h3 className="text-2xl font-black text-white tracking-tight">
                  {(() => {
                    const len = streamingText.length;
                    if (len < 500) return "최근 10경기의 전투 로그를 복기하는 중...";
                    if (len < 1500) return "플레이어님의 교전 시그니처를 파악하고 있습니다...";
                    if (len < 3000) return "코치진의 끝장 토론이 격렬하게 진행 중입니다...";
                    return "마지막 전술 처방전을 작성하고 있습니다...";
                  })()}
                </h3>

                {/* 로딩 바 애니메이션 */}
                <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 via-indigo-500 to-purple-500 transition-all duration-500"
                    style={{ width: `${Math.min(100, (streamingText.length / 4500) * 100)}%` }}
                  />
                </div>

                <p className="text-[11px] text-gray-500 font-bold leading-relaxed max-w-md">
                  BGMS의 고성능 전술 분석 엔진이 텔레메트리 데이터를 기반으로 고립 지수, 교전 거리,
                  백업 속도 등 32가지 핵심 지표를 정밀 검토하고 있습니다. 잠시만 기다려 주세요.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* [V2.1] LOL PS 스타일 레이더 차트 */}
        {debateData && (
          <SpiderChart
            nickname={nickname}
            data={{
              combat: Math.min(100, (parseRate(debateData?.visuals?.initiativeSuccess || "0%") * 0.8) + (debateData?.visuals?.killContrib?.solo || 0) * 5),
              survival: Math.min(100, (parseRate(String(debateData?.visuals?.goldenTime?.late || "0")) / 10) + 50),
              growth: 75,
              vision: 60,
              teamwork: Math.min(100,
                debateData?.visuals?.tactical
                  ? (parseRate(debateData.visuals.tactical.suppRate) + parseRate(debateData.visuals.tactical.smokeRate) + parseRate(debateData.visuals.tactical.reviveRate)) / 3 + 40
                  : (debateData?.visuals?.counterLatency !== "N/A" ? 85 : 40)
              ),
            }}
          />
        )}

        {/* [V16.0] 성장 트렌드 섹션 */}
        {debateData?.visuals?.trends && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-in fade-in slide-in-from-top-4 duration-700">
            {[
              { label: "딜량 트렌드", current: debateData.visuals.trends.recent.damage, diff: debateData.visuals.trends.dmgTrend, unit: "", icon: Flame },
              { label: "교전 승률", current: debateData.visuals.trends.recent.winRate, diff: debateData.visuals.trends.winTrend, unit: "%", icon: Zap },
            ].map((item, idx) => (
              <div key={idx} className="bg-white/5 border border-white/10 rounded-2xl p-5 flex flex-col gap-3 relative overflow-hidden group">
                <div className="flex justify-between items-start">
                  <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">{item.label}</span>
                  <item.icon size={16} className="text-white/20 group-hover:text-indigo-400 transition-colors" />
                </div>
                <div className="flex items-end justify-between">
                  <div className="text-2xl font-black text-white">{item.current}{item.unit}</div>
                  <div className={`flex items-center gap-1 text-[11px] font-black ${item.diff > 0 ? 'text-emerald-400' : item.diff < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {item.diff > 0 ? <TrendingUp size={12} /> : item.diff < 0 ? <TrendingDown size={12} /> : <Minus size={12} />}
                    {item.diff > 0 ? '+' : ''}{item.diff}{item.unit}
                  </div>
                </div>
                <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-1000 ${item.diff > 0 ? 'bg-emerald-500' : item.diff < 0 ? 'bg-red-500' : 'bg-gray-500'}`}
                    style={{ width: `${Math.min(100, 50 + (item.diff / (item.current || 1)) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="md:col-span-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl px-4 py-2 flex items-center justify-between">
              <span className="text-[11px] text-indigo-300 font-bold">최근 5판 vs 이전 5판 성장 추세 분석 결과</span>
              <span className="text-[11px] text-white font-black">{debateData.visuals.trends.status}</span>
            </div>
          </div>
        )}


        <div className="flex justify-around items-center p-6 bg-black/40 rounded-3xl border border-white/10 backdrop-blur-md shadow-2xl">
          <div className="text-center group">
            <div className="text-3xl font-black text-green-400 mb-1">{score.kind}</div>
            <div className="text-[10px] text-green-400/60 font-bold uppercase tracking-wider group-hover:scale-110 transition-transform">
              <InlineIconLabel icon="shield" iconSize={11}>착한맛 승</InlineIconLabel>
            </div>
          </div>
          <div className="h-12 w-px bg-white/10" />
          <div className="text-center group">
            <div className="text-3xl font-black text-red-400 mb-1">{score.spicy}</div>
            <div className="text-[10px] text-red-400/60 font-bold uppercase tracking-wider group-hover:scale-110 transition-transform">
              <InlineIconLabel icon="zap" iconSize={11}>매운맛 승</InlineIconLabel>
            </div>
          </div>
          <div className="h-12 w-px bg-white/10" />
          <div className="text-center group">
            <div className="text-3xl font-black text-yellow-400 mb-1">{score.draw}</div>
            <div className="text-[10px] text-yellow-400/60 font-bold uppercase tracking-wider group-hover:scale-110 transition-transform">
              <InlineIconLabel icon="team" iconSize={11}>무승부</InlineIconLabel>
            </div>
          </div>
        </div>

        {debateData?.visuals?.roleInfo && (
          <div className="relative z-20 group rounded-[32px] border border-white/10 bg-black/60 backdrop-blur-xl shadow-2xl animate-in fade-in slide-in-from-bottom-8 duration-1000">
            {/* [V38.2.8] 배경 장식용 별도 overflow-hidden 레이어 */}
            <div className="absolute inset-0 overflow-hidden rounded-[32px] pointer-events-none">
              <div className="absolute -top-24 -left-24 w-64 h-64 bg-indigo-500/10 blur-[100px] rounded-full group-hover:bg-indigo-500/20 transition-colors" />
              <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-emerald-500/10 blur-[100px] rounded-full group-hover:bg-emerald-500/20 transition-colors" />
            </div>

            <div className="relative z-10 flex flex-col md:flex-row items-center gap-8 p-8 md:p-10">
              {/* 왼쪽: 티어 및 역할 아이콘 */}
              <div className="flex flex-col items-center gap-4">
                <div className={`w-24 h-24 rounded-[32px] flex items-center justify-center text-4xl shadow-2xl transition-transform group-hover:scale-110 duration-500 ${debateData.visuals.overallTier === 'S' ? 'bg-gradient-to-br from-amber-600 to-amber-400 shadow-amber-500/40' :
                  debateData.visuals.overallTier?.startsWith('A') ? 'bg-gradient-to-br from-indigo-600 to-indigo-400 shadow-indigo-500/40' :
                    debateData.visuals.overallTier?.startsWith('B') ? 'bg-gradient-to-br from-emerald-600 to-emerald-400 shadow-emerald-500/40' :
                      debateData.visuals.overallTier?.startsWith('C') ? 'bg-gradient-to-br from-blue-600 to-blue-400 shadow-blue-500/40' :
                        debateData.visuals.overallTier?.startsWith('D') ? 'bg-gradient-to-br from-slate-600 to-slate-400 shadow-slate-500/40' :
                          'bg-gradient-to-br from-gray-600 to-gray-400 shadow-gray-500/40'
                  }`}>
                  <BgmsIcon name={getAiTierIconName(debateData.visuals.overallTier)} size={42} />
                </div>
                <div className="flex items-center gap-2">
                  <div className="px-4 py-1.5 bg-white/10 rounded-full border border-white/10">
                    <span className="text-[12px] font-black text-white tracking-widest uppercase">{(debateData.visuals.overallTier || 'B')} 티어</span>
                  </div>

                  {/* [V38.2] 티어 세부 점수 툴팁 */}
                  {debateData.visuals.tierBreakdown && (
                    <div className="relative" ref={tooltipRef}>
                      <button
                        onClick={() => isMobile && setShowTierTooltip(!showTierTooltip)}
                        onMouseEnter={() => !isMobile && setShowTierTooltip(true)}
                        onMouseLeave={() => !isMobile && setShowTierTooltip(false)}
                        className="flex items-center justify-center p-1 focus:outline-none"
                      >
                        <HelpCircle size={16} className={`${showTierTooltip ? 'text-white' : 'text-white/30'} hover:text-white/60 cursor-help transition-colors`} />
                      </button>

                      {showTierTooltip && (
                        <div
                          ref={tooltipRef}
                          className={`${isMobile
                            ? 'fixed inset-x-4 bottom-20 animate-in slide-in-from-bottom-5'
                            : 'absolute left-full ml-3 top-1/2 -translate-y-1/2 w-48 animate-in fade-in zoom-in-95'
                            } p-4 bg-black/95 border border-white/20 rounded-2xl backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.8)] z-[100] duration-200`}
                        >
                          <div className="flex justify-between items-center mb-3 pb-2 border-b border-white/10">
                            <div className="text-[11px] text-white/50 font-black uppercase tracking-wider">티어 분석 결과</div>
                            {isMobile && (
                              <button onClick={() => setShowTierTooltip(false)} className="text-white/40">
                                <X size={14} />
                              </button>
                            )}
                          </div>
                          <div className="space-y-2.5">
                            <div className="flex justify-between items-center">
                              <span className="text-[11px] text-gray-400 font-bold">교전 점수</span>
                              <span className="text-[12px] text-indigo-400 font-black">{debateData.visuals.tierBreakdown.combat}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="text-[11px] text-gray-400 font-bold">전술 점수</span>
                              <span className="text-[12px] text-emerald-400 font-black">{debateData.visuals.tierBreakdown.tactical}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="text-[11px] text-gray-400 font-bold">생존 점수</span>
                              <span className="text-[12px] text-yellow-400 font-black">{debateData.visuals.tierBreakdown.survival}</span>
                            </div>
                            <div className="pt-2 mt-2 border-t border-white/10 flex justify-between items-center">
                              <span className="text-[11px] text-white font-black uppercase">종합 점수</span>
                              <span className="text-[14px] text-white font-black">{debateData.visuals.tierBreakdown.total}</span>
                            </div>
                          </div>

                          {/* [V38.2.6] 다음 티어 안내 (13단계 세부 티어 반영) */}
                          <div className="mt-4 px-3 py-2 bg-white/5 rounded-xl border border-white/10">
                            <div className="text-[10px] text-gray-400 font-bold mb-1">Next Goal</div>
                            <div className="text-[11px] text-white leading-relaxed">
                              {(() => {
                                const nextInfo = getNextTierInfo(debateData.visuals.tierBreakdown.total);
                                if (!nextInfo) {
                                  return <span className="text-yellow-400 font-bold">최상위 S 티어 달성! 현재 실력을 유지하세요.</span>;
                                }
                                return (
                                  <>
                                    <span className="text-indigo-400 font-bold">
                                      {nextInfo.tier} TIER
                                    </span>
                                    {" "}까지 {" "}
                                    <span className="text-white font-black">
                                      {nextInfo.needed}점
                                    </span>
                                    {" "}더 필요합니다.
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          <div className="mt-3 text-[9px] text-gray-500 leading-tight">
                            * S(85), A+(78), A(71), B+(56), B(48) 등 13단계 세분화
                          </div>
                          {!isMobile && <div className="absolute left-[-6px] top-1/2 -translate-y-1/2 w-0 h-0 border-t-[6px] border-t-transparent border-r-[6px] border-r-white/20 border-b-[6px] border-b-transparent" />}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 중간: 직업군 설명 */}
              <div className="flex-1 text-center md:text-left space-y-3">
                <div className="space-y-1">
                  <span className="text-[12px] text-indigo-400 font-black uppercase tracking-[0.3em]">전술적 정체성</span>
                  <h2 className="text-3xl md:text-4xl font-black text-white tracking-tight leading-none italic">
                    {debateData.visuals.roleInfo.title}
                  </h2>
                </div>
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-500/20 rounded-lg border border-indigo-500/30">
                  <Target size={14} className="text-indigo-400" />
                  <span className="text-xs font-black text-indigo-300 uppercase tracking-wider">{debateData.visuals.roleInfo.roleLabel}</span>
                </div>
                <p className="text-[13px] text-gray-400 font-bold leading-relaxed max-w-xl">
                  {debateData.visuals.roleInfo.description}
                </p>
              </div>

              {/* 오른쪽: 무기 스탯 카드 (유저가 원한 '총 보여주기') */}
              <div className="w-full md:w-64 p-6 bg-white/5 rounded-3xl border border-white/10 shadow-inner group/weapon relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover/weapon:scale-125 transition-transform duration-700">
                  <Skull size={80} className="text-white" />
                </div>

                <div className="relative z-10 space-y-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">시그니처 무기</span>
                    <div className="text-xl font-black text-white flex items-center gap-2">
                      <Flame size={18} className="text-orange-500 animate-pulse" />
                      {debateData.visuals.roleInfo.signatureWeapon}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/10">
                    <div className="flex flex-col">
                      <span className="text-[18px] font-black text-white">{debateData.visuals.roleInfo.signatureWeaponStats?.kills || 0}</span>
                      <span className="text-[9px] text-gray-500 font-black uppercase tracking-tighter">킬 수 (Kills)</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[18px] font-black text-indigo-400">{debateData.visuals.roleInfo.signatureWeaponStats?.dbnos || 0}</span>
                      <span className="text-[9px] text-gray-500 font-black uppercase tracking-tighter">기절 횟수 (DBNO)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}




        {debateData?.visuals?.goldenTime && (
          <div className="relative z-10 p-10 bg-black/80 rounded-[40px] border border-white/10 backdrop-blur-2xl shadow-2xl overflow-hidden">
            <div className="absolute -top-24 -right-24 w-48 h-48 bg-yellow-500/10 blur-[80px] rounded-full" />

            <div className="flex items-center justify-between mb-10 relative z-10">
              <div className="flex flex-col gap-2">
                <div className="text-[12px] text-yellow-400 font-black uppercase tracking-[0.3em] flex items-center gap-2">
                  <InlineIconLabel icon="flame" iconSize={18}>골든타임 분석 (Golden Time)</InlineIconLabel>
                </div>
                <div className="text-xl font-black text-white">생존 구간별 화력 집중도</div>
              </div>
              <div className="group relative px-4 py-2 bg-red-500/20 border border-red-500/30 rounded-2xl text-[12px] text-red-400 font-black flex items-center gap-3 shadow-lg shadow-red-500/10 cursor-help">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-ping" />
                자기장 누적 피해: {Math.floor(debateData?.visuals?.bluezoneWaste || 0)} HP
                <div className="w-3 h-3 rounded-full bg-red-500/30 flex items-center justify-center text-[8px] text-red-400 border border-red-500/40">?</div>

                {/* Tooltip Content */}
                <div className="absolute top-full right-0 mt-2 p-3 bg-[#111] border border-red-500/20 rounded-xl shadow-2xl z-50 w-64 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  <div className="text-[10px] font-black uppercase mb-1 text-red-400">데이터 정의</div>
                  <div className="text-[11px] text-red-200/70 font-medium leading-relaxed">
                    자기장 밖에서 입은 <span className="text-red-400 font-bold">총 누적 피해량(HP)</span>입니다. 높은 수치는 서클 진입 타이밍(Rotation)이나 외곽 교전 시 유지력 관리에 결함이 있음을 시사합니다.
                  </div>
                  <div className="absolute -top-1 right-6 w-2 h-2 bg-[#111] border-l border-t border-red-500/20 rotate-45" />
                </div>
              </div>
            </div>

            <div className="space-y-12 relative z-10">
              <div className="relative pt-6 md:pt-12">
                <div className="grid grid-cols-4 gap-2 md:gap-6 h-40 md:h-48 items-end relative">
                  {[
                    { label: "0-5분", val: debateData?.visuals?.goldenTime?.early || 0, color: "from-blue-400 to-blue-600", desc: "초반교전" },
                    { label: "5-15분", val: debateData?.visuals?.goldenTime?.mid1 || 0, color: "from-indigo-400 to-indigo-600", desc: "중반대치" },
                    { label: "15-25분", val: debateData?.visuals?.goldenTime?.mid2 || 0, color: "from-purple-400 to-purple-600", desc: "후반운영" },
                    { label: "25분+", val: debateData?.visuals?.goldenTime?.late || 0, color: "from-pink-400 to-pink-600", desc: "엔딩싸움" },
                  ].map((item, idx) => {
                    const maxVal = Math.max(
                      debateData.visuals?.goldenTime?.early || 0,
                      debateData.visuals?.goldenTime?.mid1 || 0,
                      debateData.visuals?.goldenTime?.mid2 || 0,
                      debateData.visuals?.goldenTime?.late || 0,
                      1
                    );
                    const barHeight = Math.max(5, (item.val / maxVal) * 100);
                    return (
                      <div key={idx} className="flex flex-col items-center gap-3 md:gap-5 group cursor-default h-full">
                        <div className="relative w-full flex-1 flex items-end justify-center bg-white/10 rounded-xl md:rounded-2xl overflow-hidden border border-white/10 shadow-inner">
                          <div className="absolute top-2 md:top-4 inset-x-0 text-center z-20">
                            <div className="text-[10px] md:text-[14px] font-black text-white drop-shadow-md group-hover:scale-110 transition-transform">
                              {Math.round(item.val).toLocaleString()}
                            </div>
                            <div className="text-[7px] md:text-[9px] font-black text-white/40 uppercase">피해량</div>
                          </div>
                          <div
                            className={`w-full bg-gradient-to-t ${item.color} transition-all duration-1000 ease-out shadow-[0_-4px_20px_rgba(0,0,0,0.5)] relative z-10`}
                            style={{ height: `${barHeight}%` }}
                          >
                            <div className="absolute top-0 left-0 right-0 h-0.5 md:h-1 bg-white/30" />
                          </div>
                        </div>
                        <div className="flex flex-col items-center gap-0.5 md:gap-1">
                          <div className="text-[10px] md:text-[14px] text-white font-black tracking-tighter md:tracking-tight whitespace-nowrap">{item.label}</div>
                          <div className="text-[8px] md:text-[10px] text-white/40 font-black uppercase tracking-tighter whitespace-nowrap">{item.desc}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 pt-10 border-t border-white/10">
                <div className="flex flex-col gap-4 md:gap-5">
                  <div className="flex items-center justify-between">
                    <div className="text-[12px] md:text-[13px] text-white/50 font-black tracking-widest uppercase">솔로 교전력</div>
                    <div className="px-3 py-1 bg-yellow-400/10 rounded-lg text-[13px] md:text-[14px] text-yellow-400 font-black tracking-tighter">
                      {debateData?.visuals?.killContrib?.solo || 0} / {(debateData?.visuals?.killContrib?.solo || 0) + (debateData?.visuals?.killContrib?.cleanup || 0)} 킬
                    </div>
                  </div>
                  <div className="h-4 bg-white/5 rounded-full overflow-hidden p-1 border border-white/5">
                    <div
                      className="h-full bg-gradient-to-r from-yellow-500 to-yellow-300 rounded-full transition-all duration-1000 shadow-[0_0_15px_rgba(234,179,8,0.4)]"
                      style={{
                        width: `${(() => {
                          const solo = debateData?.visuals?.killContrib?.solo || 0;
                          const cleanup = debateData?.visuals?.killContrib?.cleanup || 0;
                          const total = solo + cleanup;
                          return total > 0 ? (solo / total) * 100 : 0;
                        })()}%`
                      }}
                    />
                  </div>
                  <div className="text-[10px] md:text-[11px] text-white/40 font-bold leading-relaxed">
                    내 딜 비중 70% 이상의 <span className="text-white/70">순수 무력 솔로 킬</span>
                  </div>
                </div>

                <div className="flex flex-col gap-4 md:gap-5">
                  <div className="flex items-center justify-between">
                    <div className="text-[12px] md:text-[13px] text-white/50 font-black tracking-widest uppercase">팀 백업 마무리</div>
                    <div className="px-3 py-1 bg-green-400/10 rounded-lg text-[13px] md:text-[14px] text-green-400 font-black tracking-tighter">
                      {debateData?.visuals?.killContrib?.cleanup || 0} / {(debateData?.visuals?.killContrib?.solo || 0) + (debateData?.visuals?.killContrib?.cleanup || 0)} 킬
                    </div>
                  </div>
                  <div className="h-4 bg-white/5 rounded-full overflow-hidden p-1 border border-white/5">
                    <div
                      className="h-full bg-gradient-to-r from-green-500 to-green-300 rounded-full transition-all duration-1000 shadow-[0_0_15px_rgba(34,197,94,0.4)]"
                      style={{
                        width: `${(() => {
                          const solo = debateData?.visuals?.killContrib?.solo || 0;
                          const cleanup = debateData?.visuals?.killContrib?.cleanup || 0;
                          const total = solo + cleanup;
                          return total > 0 ? (cleanup / total) * 100 : 0;
                        })()}%`
                      }}
                    />
                  </div>
                  <div className="text-[10px] md:text-[11px] text-white/40 font-bold leading-relaxed">
                    팀원이 깎아둔 적을 <span className="text-white/70">확실히 마무리한 해결사 킬</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}



        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">

          <div className="relative group p-6 bg-indigo-500/10 border border-indigo-500/20 rounded-[28px] text-center transition-all hover:bg-indigo-500/15">
            <div className="text-[10px] text-indigo-400 font-black uppercase mb-1 tracking-widest">선제 타격 효율</div>
            <div className="text-3xl font-black text-white mb-1">
              {debateData?.visuals?.initiativeSuccess || "0%"}
            </div>
            {debateData?.visuals?.tactical?.counts?.initiative && (
              <div className="text-[10px] text-indigo-300/60 font-bold mb-1">
                (성공 {debateData.visuals.tactical.counts.initiative.success} / 시도 {debateData.visuals.tactical.counts.initiative.attempts})
              </div>
            )}
            <div className="text-[9px] text-gray-500 font-medium">먼저 쐈을 때 킬 성공 비율</div>
          </div>

          <div className="relative group p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-[28px] text-center transition-all hover:bg-emerald-500/15">
            <div className="text-[10px] text-emerald-400 font-black uppercase mb-1 tracking-widest">교전 결정력</div>
            <div className="text-3xl font-black text-white mb-1">{debateData?.visuals?.duelStats?.winRate || "0%"}</div>
            <div className="text-[9px] text-gray-500 font-medium">1:1 교전 최종 승리 확률</div>
          </div>

          <div className="relative group p-6 bg-pink-500/10 border border-pink-500/20 rounded-[28px] text-center transition-all hover:bg-pink-500/15">
            <div className="text-[10px] text-pink-400 font-black uppercase mb-1 tracking-widest">역전의 명수</div>
            <div className="text-3xl font-black text-white mb-1">{debateData?.visuals?.duelStats?.reversals || 0}회</div>
            <div className="text-[9px] text-gray-500 font-medium">총 {debateData?.visuals?.duelStats?.reversalAttempts || 0}회 기습 중 승리</div>
          </div>

          <div className="relative group p-6 bg-orange-500/10 border border-orange-500/20 rounded-[28px] text-center transition-all hover:bg-orange-500/15">
            <div className="text-[10px] text-orange-400 font-black uppercase mb-1 tracking-widest">대응 사격 속도</div>
            <div className="text-3xl font-black text-white mb-1 flex items-center justify-center gap-2">
              {debateData?.visuals?.reactionLatency || "0.00s"}
              {debateData?.visuals?.reactionLatency === "측정 불가" && (
                <div className="relative" ref={activeStatTooltip === 'reaction' ? statTooltipRef : null}>
                  <button
                    onMouseEnter={() => !isMobile && setActiveStatTooltip('reaction')}
                    onMouseLeave={() => !isMobile && setActiveStatTooltip(null)}
                    onClick={() => isMobile && setActiveStatTooltip(activeStatTooltip === 'reaction' ? null : 'reaction')}
                    className="w-4 h-4 rounded-full border border-orange-400/30 flex items-center justify-center text-[10px] font-black text-orange-400/50 hover:text-orange-400 transition-colors"
                  >
                    ?
                  </button>

                  {/* Tooltip Content */}
                  {activeStatTooltip === 'reaction' && (
                    <div className={`${isMobile ? 'fixed inset-x-4 bottom-20' : 'absolute bottom-full left-1/2 -translate-x-1/2 mb-3'} p-4 bg-[#111] border border-orange-500/20 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] z-[100] w-64 animate-in fade-in zoom-in-95 duration-200`}>
                      <div className="flex justify-between items-start mb-2">
                        <div className="text-[10px] font-black uppercase text-orange-400 text-left">측정 불가 사유</div>
                        {isMobile && <button onClick={() => setActiveStatTooltip(null)} className="text-white/40"><X size={14} /></button>}
                      </div>
                      <div className="text-[11px] text-orange-200/70 font-medium leading-relaxed text-left">
                        피격 후 반격에 성공한 교전이 없을 때 표시됩니다. <span className="text-orange-400 font-bold">일방적으로 적을 제압했거나, 기습 당했을 때 반격 없이 즉사 또는 도주한 경우</span> 측정 조건에서 제외됩니다.
                      </div>
                      {!isMobile && <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#111] border-r border-b border-orange-500/20 rotate-45" />}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="text-[9px] text-gray-500 font-medium">피격 시 교전 대응(반응) 시간</div>
          </div>

          <div className="relative p-6 bg-cyan-500/10 border border-cyan-500/20 rounded-[28px] text-center transition-all hover:bg-cyan-500/15">
            <div className="text-[10px] text-cyan-400 font-black uppercase mb-1 tracking-widest">아군 백업 속도</div>
            <div className="text-3xl font-black text-white mb-1 flex items-center justify-center gap-2">
              {debateData?.visuals?.counterLatency || "0.00s"}
              {debateData?.visuals?.counterLatency === "측정 불가" && (
                <div className="relative" ref={activeStatTooltip === 'counter' ? statTooltipRef : null}>
                  <button
                    onMouseEnter={() => !isMobile && setActiveStatTooltip('counter')}
                    onMouseLeave={() => !isMobile && setActiveStatTooltip(null)}
                    onClick={() => isMobile && setActiveStatTooltip(activeStatTooltip === 'counter' ? null : 'counter')}
                    className="w-4 h-4 rounded-full border border-cyan-400/30 flex items-center justify-center text-[10px] font-black text-cyan-400/50 hover:text-cyan-400 transition-colors"
                  >
                    ?
                  </button>

                  {/* Tooltip Content */}
                  {activeStatTooltip === 'counter' && (
                    <div className={`${isMobile ? 'fixed inset-x-4 bottom-20' : 'absolute bottom-full left-1/2 -translate-x-1/2 mb-3'} p-4 bg-[#111] border border-cyan-500/20 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] z-[100] w-64 animate-in fade-in zoom-in-95 duration-200`}>
                      <div className="flex justify-between items-start mb-2">
                        <div className="text-[10px] font-black uppercase text-cyan-400 text-left">측정 불가 사유</div>
                        {isMobile && <button onClick={() => setActiveStatTooltip(null)} className="text-white/40"><X size={14} /></button>}
                      </div>
                      <div className="text-[11px] text-cyan-200/70 font-medium leading-relaxed text-left">
                        최근 분석된 경기 중 <span className="text-cyan-400 font-bold">아군이 기절(DBNO)하거나 교전에 참여하여 백업이 필요한 상황</span>이 발생하지 않았습니다. 샘플 데이터가 부족하여 지표 산출이 불가능합니다.
                      </div>
                      {!isMobile && <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#111] border-r border-bottom border-cyan-500/20 rotate-45" />}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="text-[9px] text-gray-500 font-medium">아군 피격 시 커버 소요 시간</div>
          </div>

          <div className="relative group p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-[28px] text-center transition-all hover:bg-emerald-500/15">
            <div className="text-[10px] text-emerald-400 font-black uppercase mb-1 tracking-widest">평균 생존 페이즈</div>
            <div className="text-3xl font-black text-white mb-1">{debateData?.visuals?.deathPhase || 0} Ph</div>
            <div className="text-[9px] text-gray-500 font-medium">최근 10경기 평균 생존 구간</div>
          </div>
        </div>

        {/* [V3.0] Tactical Mastery Summary */}
        {debateData?.visuals?.tactical && (
          <div className="p-8 bg-black/60 rounded-[32px] border border-white/10 shadow-xl overflow-hidden relative">
            <div className="absolute top-0 right-0 p-6 opacity-5">
              <ShieldAlert size={120} className="text-emerald-500" />
            </div>
            <div className="relative z-10 flex flex-col gap-6">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-emerald-500/20 rounded-lg flex items-center justify-center">
                  <ShieldAlert size={16} className="text-emerald-400" />
                </div>
                <span className="text-white font-black">10경기 전술 마스터리</span>
                {debateData?.visuals?.latestMatchTime && (
                  <div className="flex items-center gap-1.5 ml-2">
                    <div className="w-1 h-1 bg-white/20 rounded-full" />
                    <span className="text-[10px] text-white/40 font-bold">{getRelativeTime(debateData?.visuals?.latestMatchTime || "")}</span>
                  </div>
                )}
                {debateData?.visuals?.modeDistribution && (
                  <div className="flex items-center gap-1.5 ml-2">
                    <span className="px-2 py-0.5 bg-indigo-500/20 border border-indigo-500/30 rounded text-[9px] text-indigo-300 font-black tracking-tighter uppercase">
                      경쟁전 {debateData?.visuals?.modeDistribution?.ranked || 0}회
                    </span>
                    <span className="px-2 py-0.5 bg-white/5 border border-white/10 rounded text-[9px] text-white/40 font-black tracking-tighter uppercase">
                      일반전 {debateData?.visuals?.modeDistribution?.normal || 0}회
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-orange-400 font-black uppercase">견제 사격 성공률</span>
                  <span className="text-2xl font-black text-white">
                    {debateData?.visuals?.tactical?.suppRate || "0%"}
                  </span>
                  {debateData?.visuals?.tactical?.counts && (
                    <span className="text-[10px] text-orange-300/60 font-bold">
                      (지원 {debateData.visuals.tactical.counts.supps} / 기절 {debateData.visuals.tactical.counts.knocks})
                    </span>
                  )}
                  <div className="w-full h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                    <div className="h-full bg-orange-400" style={{ width: `${parseRate(debateData?.visuals?.tactical?.suppRate || "0%")}%` }} />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-blue-400 font-black uppercase">연막 구출 성공률</span>
                  <span className="text-2xl font-black text-white">
                    {debateData?.visuals?.tactical?.smokeRate || "0%"}
                  </span>
                  {debateData?.visuals?.tactical?.counts && (
                    <span className="text-[10px] text-blue-300/60 font-bold">
                      (시도 {debateData.visuals.tactical.counts.rescueSmokes ?? 0} / 성공 {debateData.visuals.tactical.counts.smokeRescues} / 전체 연막 {debateData.visuals.tactical.counts.smokes})
                    </span>
                  )}
                  <div className="w-full h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                    <div className="h-full bg-blue-400" style={{ width: `${parseRate(debateData?.visuals?.tactical?.smokeRate || "0%")}%` }} />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-pink-400 font-black uppercase">부활 성공률</span>
                  <span className="text-2xl font-black text-white">
                    {debateData?.visuals?.tactical?.reviveRate || "0%"}
                  </span>
                  {debateData?.visuals?.tactical?.counts && (
                    <span className="text-[10px] text-pink-300/60 font-bold">
                      (성공 {debateData.visuals.tactical.counts.revives} / 기절 {debateData.visuals.tactical.counts.knocks})
                    </span>
                  )}
                  <div className="w-full h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                    <div className="h-full bg-pink-400" style={{ width: `${parseRate(debateData?.visuals?.tactical?.reviveRate || "0%")}%` }} />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-emerald-400 font-black uppercase">팀 전멸 (Wipes)</span>
                  <span className="text-2xl font-black text-white">{debateData?.visuals?.tactical?.counts?.enemyTeamWipes || 0}회</span>
                  <div className="text-[9px] text-gray-500 font-bold mt-1">교전 중 적 스쿼드 전멸 기여</div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-purple-400 font-black uppercase">전술 대응력 (복수)</span>
                  <span className="text-2xl font-black text-white">{debateData?.visuals?.tactical?.baitCount || 0}회</span>
                  <div className="text-[9px] text-gray-500 font-bold mt-1">10경기 합계</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* [V38.1] 맵의 왕 카드 */}
        {debateData?.visuals?.mapStats && (
          <MapKingCard mapStats={debateData.visuals.mapStats} />
        )}

        <div className="flex flex-col gap-4">
          {debateData?.debateIssues?.map((issue: any, idx: number) => (
            <div key={idx} className="bg-white/5 border border-white/10 rounded-3xl overflow-hidden transition-all hover:border-white/20">
              <button
                onClick={() => setOpenIssueIdx(openIssueIdx === idx ? null : idx)}
                className="w-full p-6 flex justify-between items-center text-left group"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-indigo-400 font-black uppercase tracking-widest">{issue?.topic || "분석 항목"}</span>
                  <h4 className="text-lg font-black text-white group-hover:text-indigo-300 transition-colors">{issue?.question || "분석 내용 로드 중..."}</h4>
                </div>
                <div className="flex items-center gap-4">
                  {(() => {
                    const w = issue?.winner?.toLowerCase() || "";
                    const isSpicy = w.includes("spicy");
                    const isKind = w.includes("kind");

                    return (
                      <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter ${isSpicy ? "bg-red-500/20 text-red-400 border border-red-500/30" :
                        isKind ? "bg-green-500/20 text-green-400 border border-green-500/30" :
                          "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                        }`}>
                        {isSpicy ? "매운맛 승" : isKind ? "착한맛 승" : "무승부"}
                      </div>
                    );
                  })()}
                  <svg className={`w-6 h-6 text-white/50 transition-transform ${openIssueIdx === idx ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                </div>
              </button>

              {openIssueIdx === idx && (
                <div className="px-6 pb-6 animate-in slide-in-from-top-4 duration-300">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={`p-5 rounded-2xl border transition-all ${(issue?.winner?.toLowerCase() || "").includes("kind") ? "bg-green-500/5 border-green-500/30 ring-1 ring-green-500/20" : "bg-black/30 border-white/10"}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <BgmsIcon name="shield" size={18} className="text-green-400" />
                        <span className="text-xs font-black text-green-400 uppercase">착한맛 코치</span>
                      </div>
                      <p className="text-sm text-gray-300 leading-relaxed font-medium">&quot;{issue?.kindOpinion || "의견을 가져오는 중..."}&quot;</p>
                    </div>

                    <div className={`p-5 rounded-2xl border transition-all ${(issue?.winner?.toLowerCase() || "").includes("spicy") ? "bg-red-500/5 border-red-500/30 ring-1 ring-red-500/20" : "bg-black/30 border-white/10"}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <BgmsIcon name="zap" size={18} className="text-red-400" />
                        <span className="text-xs font-black text-red-400 uppercase">매운맛 폭격기</span>
                      </div>
                      <p className="text-sm text-gray-300 leading-relaxed font-medium">&quot;{issue?.spicyOpinion || "의견을 가져오는 중..."}&quot;</p>
                    </div>
                  </div>

                  <div className="mt-8 p-6 bg-black/40 rounded-2xl border border-white/5">
                    <div className="flex flex-col gap-1 text-center md:text-left mb-8">
                      <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">데이터 증거 (전술적 증거)</span>
                      <span className="text-lg font-black text-white">{issue?.topic || "데이터"} 상세 비교</span>
                    </div>

                    <div className="space-y-4">
                      {issue.userStats?.map((uStat: { label: string; value: string }, sIdx: number) => {
                        const bStat = issue.benchmarkStats?.[sIdx];
                        return (
                          <div key={sIdx} className="grid grid-cols-11 items-center gap-2 p-4 bg-white/5 rounded-xl border border-white/5 group hover:bg-white/10 transition-colors">
                            <div className="col-span-4 text-right">
                              <div className="text-lg md:text-xl font-black text-indigo-400">{uStat.value}</div>
                              <div className="text-[9px] text-gray-500 font-bold uppercase">{uStat.label}</div>
                            </div>

                            <div className="col-span-3 flex flex-col items-center justify-center gap-1">
                              <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-[10px] font-black text-white/20 group-hover:text-white/40 border border-white/10">VS</div>
                            </div>

                            <div className="col-span-4 text-left">
                              <div className="text-lg md:text-xl font-black text-gray-400">{bStat?.value || "N/A"}</div>
                              <div className="text-[9px] text-gray-500 font-bold uppercase">{bStat?.label || uStat.label}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

      </div>
    </div>
  );
};
