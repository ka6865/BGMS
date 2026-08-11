"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { classifyMatchMode } from "@/lib/stats/statsPageModel";
import { estimateUserTier } from "@/lib/pubg-analysis/benchmarkScore";
import { MatchPerformancePanel } from "@/components/stat/matches/ExpandedMatchDetails";

export interface CompactMatchRowProps {
  summary: MatchSummaryData;
  isExpanded: boolean;
  isMobile: boolean;
  onToggle(): void;
}

interface TierPopoverLayout {
  placement: "top" | "bottom";
  maxHeight: number;
}

const MAP_NAMES: Record<string, string> = {
  Baltic_Main: "에란겔",
  Desert_Main: "미라마",
  Savage_Main: "사녹",
  Summerland_Main: "카라킨",
  Chimera_Main: "파라모",
  Tiger_Main: "태이고",
  Kiki_Main: "데스턴",
  Neon_Main: "론도",
  DihorOtok_Main: "비켄디",
  PillarCompound_Main: "필라 기지 (TDM)",
  Italy_TDM_Main: "리틀 이탈리아 (TDM)",
};

const MODE_LABELS = {
  ranked: "경쟁전",
  normal: "일반전",
  casual: "캐주얼",
  tdm: "팀 데스매치",
} as const;

function getStatus(summary: MatchSummaryData): { label: string; border: string } {
  const mode = classifyMatchMode(summary);
  if (mode === "tdm") {
    return summary.stats.winPlace === 1
      ? { label: "승리", border: "border-l-rose-400" }
      : { label: "패배", border: "border-l-red-400" };
  }
  if (summary.stats.winPlace === 1) return { label: "승리", border: "border-l-amber-400" };
  if (summary.stats.winPlace <= 10) return { label: "상위권", border: "border-l-teal-400" };
  if (summary.stats.kills === 0 && summary.stats.damageDealt < 100) {
    return { label: "저성과", border: "border-l-red-400" };
  }
  return { label: "일반", border: "border-l-white/20" };
}


function formatRelativeTime(dateString?: string): string {
  if (!dateString) return "";
  const time = Date.parse(dateString);
  if (!Number.isFinite(time)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 60) return "방금 전";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}일 전`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}달 전`;
  return `${Math.floor(diffMonth / 12)}년 전`;
}

function formatMode(gameMode: string) {
  const mode = gameMode.toLowerCase();
  const perspective = mode.includes("fpp") ? "1인칭" : "3인칭";
  const party = mode.includes("solo") ? "솔로" : mode.includes("duo") ? "듀오" : "스쿼드";
  return `${perspective} ${party}`;
}

export function CompactMatchRow({ summary, isExpanded, isMobile, onToggle }: CompactMatchRowProps) {
  const mode = classifyMatchMode(summary);
  const status = getStatus(summary);
  const tier = summary.benchmark ? estimateUserTier(summary.benchmark.score) : null;
  const total = summary.totalTeams || summary.totalPlayers || 0;
  const matchDate = (summary as any).playedAt || summary.createdAt || summary.matchInfo?.date || "";
  const playedAtAgo = formatRelativeTime(matchDate);
  const tierRef = useRef<HTMLDivElement>(null);
  const [showTierPopover, setShowTierPopover] = useState(false);
  const [tierPopoverPinned, setTierPopoverPinned] = useState(false);
  const [showTierDetails, setShowTierDetails] = useState(false);
  const [popoverLayout, setPopoverLayout] = useState<TierPopoverLayout>({
    placement: "top",
    maxHeight: 504,
  });
  const tierPopoverId = `match-tier-popover-${summary.matchId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const closeTierPopover = useCallback(() => {
    setShowTierPopover(false);
    setTierPopoverPinned(false);
    setShowTierDetails(false);
  }, []);

  const updatePopoverLayout = useCallback(() => {
    if (isMobile || !tierRef.current) return;

    const rect = tierRef.current.getBoundingClientRect();
    const gap = 12;
    const viewportPadding = 16;
    const preferredMaxHeight = Math.min(504, Math.max(240, window.innerHeight - viewportPadding * 2));
    const spaceAbove = Math.max(0, rect.top - gap - viewportPadding);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
    const placement = spaceAbove >= preferredMaxHeight || spaceAbove >= spaceBelow ? "top" : "bottom";
    const availableSpace = placement === "top" ? spaceAbove : spaceBelow;

    setPopoverLayout({
      placement,
      maxHeight: Math.max(220, Math.min(preferredMaxHeight, availableSpace)),
    });
  }, [isMobile]);

  useEffect(() => {
    if (!showTierPopover) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!tierRef.current?.contains(event.target as Node)) closeTierPopover();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTierPopover();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeTierPopover, showTierPopover]);

  useEffect(() => {
    if (!showTierPopover || !isMobile) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.documentElement.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, [isMobile, showTierPopover]);

  useEffect(() => {
    if (!showTierPopover || isMobile) return;

    updatePopoverLayout();
    window.addEventListener("resize", updatePopoverLayout);
    window.addEventListener("scroll", updatePopoverLayout, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", updatePopoverLayout);
      window.removeEventListener("scroll", updatePopoverLayout, true);
    };
  }, [isMobile, showTierPopover, updatePopoverLayout]);

  const openTierPopover = () => {
    updatePopoverLayout();
    setShowTierPopover(true);
  };

  return (
    <article
      className={`relative border border-white/10 border-l-4 bg-[#161616] ${status.border} ${
        isExpanded ? "rounded-t-2xl rounded-b-none border-b-0" : "rounded-2xl"
      } ${showTierPopover ? "z-[1200] overflow-visible" : "overflow-hidden"}`}
      data-compact-match-id={summary.matchId}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "매치 상세 접기" : "매치 상세 펼치기"}
        onClick={onToggle}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
      />

      <div className="pointer-events-none relative z-10 flex min-h-11 w-full items-center gap-3 p-3 text-left md:gap-4 md:p-4">
        <div className="flex h-12 min-w-[3.5rem] shrink-0 flex-col items-center justify-center rounded-lg border border-white/5 bg-white/5 px-2.5">
          <span className="text-[9px] font-black text-white/40">{mode === "tdm" ? "결과" : "순위"}</span>
          <strong className="my-0.5 text-base font-black leading-none text-white md:text-lg">
            {mode === "tdm" ? status.label : `#${summary.stats.winPlace}`}
          </strong>
          {mode !== "tdm" && total > 0 && <span className="text-[9px] text-white/30">/ {total}</span>}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm text-white md:text-base">
              {MAP_NAMES[summary.mapName] ?? summary.mapName ?? "맵 정보 없음"}
            </strong>
            <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-black ${
              mode === "casual"
                ? "border-purple-500/30 bg-purple-500/15 text-purple-300"
                : mode === "ranked"
                ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                : "border-white/10 bg-white/5 text-white/60"
            }`}>
              {MODE_LABELS[mode]}
            </span>
            <span className="hidden text-[10px] font-bold text-white/35 sm:inline">{formatMode(summary.gameMode || "")}</span>
            {playedAtAgo && (
              <span className="text-[10px] font-bold text-white/40">
                · {playedAtAgo}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-white/55">
            <span><strong className="text-white">{summary.stats.kills}</strong> 킬</span>
            <span><strong className="text-white">{Math.floor(summary.stats.damageDealt || 0)}</strong> 피해</span>
            <span><strong className="text-white">{summary.stats.DBNOs || 0}</strong> DBNO</span>
            <span><strong className="text-white">{Math.floor((summary.stats.timeSurvived || 0) / 60)}</strong>분 생존</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] font-black text-white/50">{status.label}</span>
          {tier && (
            <div
              ref={tierRef}
              className="pointer-events-auto relative"
              onMouseEnter={() => {
                if (!isMobile) openTierPopover();
              }}
              onMouseLeave={() => {
                if (!isMobile && !tierPopoverPinned) closeTierPopover();
              }}
              onFocus={() => {
                if (!isMobile) openTierPopover();
              }}
              onBlur={(event) => {
                if (!isMobile && !tierPopoverPinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  closeTierPopover();
                }
              }}
            >
              <button
                type="button"
                aria-expanded={showTierPopover}
                aria-controls={tierPopoverId}
                aria-haspopup="dialog"
                aria-label={`AI ${tier} 티어 근거 ${showTierPopover ? "닫기" : "보기"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isMobile) {
                    if (showTierPopover) closeTierPopover();
                    else setShowTierPopover(true);
                  } else {
                    if (showTierPopover && tierPopoverPinned) {
                      closeTierPopover();
                    } else {
                      setTierPopoverPinned(true);
                      openTierPopover();
                    }
                  }
                }}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-indigo-500/15 px-2 text-[10px] font-black text-indigo-300 transition-colors hover:bg-indigo-500/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 md:min-h-8 md:min-w-0"
              >
                AI {tier}
              </button>

              {showTierPopover && (
                <div
                  id={tierPopoverId}
                  role="dialog"
                  aria-label="AI 티어 근거"
                  data-testid="match-tier-tooltip"
                  onClick={(event) => event.stopPropagation()}
                  style={!isMobile ? { maxHeight: `${popoverLayout.maxHeight}px` } : undefined}
                  className={`${isMobile
                    ? "fixed inset-x-4 bottom-20 max-h-[calc(100dvh-7rem)] overflow-y-auto overscroll-contain"
                    : `absolute right-0 w-[24rem] overflow-y-auto overscroll-contain ${popoverLayout.placement === "top" ? "bottom-full mb-3" : "top-full mt-3"}`
                  } z-[1100] rounded-[1.5rem] border border-white/20 bg-[#0a0a0a] p-2 shadow-[0_20px_50px_rgba(0,0,0,0.9)]`}
                >
                  {isMobile && (
                    <div className="mb-2 flex items-center justify-between px-2 pt-1">
                      <span className="text-xs font-black text-indigo-300">AI 티어 근거</span>
                      <button
                        type="button"
                        aria-label="티어 근거 닫기"
                        onClick={closeTierPopover}
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-white/60 active:bg-white/10"
                      >
                        <X size={18} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  <MatchPerformancePanel
                    matchData={summary}
                    isMobile={isMobile}
                    showTierDetails={showTierDetails}
                    onToggleTierDetails={() => setShowTierDetails((current) => !current)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <ChevronDown
          size={20}
          aria-hidden="true"
          className={`shrink-0 text-white/40 transition-transform ${isExpanded ? "rotate-180" : ""}`}
        />
      </div>
    </article>
  );
}
