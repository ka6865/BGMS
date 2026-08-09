"use client";

// 펼친 매치의 request/state/AI/telemetry와 기존 상세 UI를 소유한다.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Target,
  Zap,
  Shield,
  Crosshair,
  BarChart2,
  Trophy,
  Flame,
  MousePointer2,
  Clock,
  Swords,
  User,
  PlayCircle,
  X,
  Car,
  Video,
  Map as MapIcon,
  Info
} from "lucide-react";
import { useRouter } from "next/navigation";
import { BgmsIcon, type BgmsIconName } from "@/components/common/BgmsIcon";
import { MatchTimeline } from "@/components/stat/MatchTimeline";
import dynamic from "next/dynamic";
import type { MatchData, MatchTeamMember } from "@/types/stat";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { getTranslatedWeaponName } from "@/lib/pubg-analysis/constants";
import { estimateUserTier, getNextTierInfo } from "@/lib/pubg-analysis/benchmarkScore";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { useAIStatus, aiManager } from "@/lib/ai-management";
import { useAuth } from "@/components/AuthProvider";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics";
import { resolve3DMapCapability } from "@/lib/replay/mapCapabilities";
import { isMatchTelemetryExpired, isMatchOlderThan14Days } from "@/components/stat/matchExpiryHelper";
import type { StatsPlatform } from "@/types/stats-page";

const TimelineMiniMap = dynamic(
  () => import("@/components/stat/TimelineMiniMap").then((mod) => mod.TimelineMiniMap),
  { ssr: false, loading: () => <div className="w-full h-full bg-white/5 animate-pulse rounded-[2.5rem]" /> }
);

const ScoreBar = ({ label, score, max, color, compact = false }: { label: string, score: number, max: number, color: string, compact?: boolean }) => (
  <div className={`flex flex-col ${compact ? "gap-1" : "gap-1.5"}`}>
    <div className={`flex justify-between items-center ${compact ? "text-[10px]" : "text-[11px]"}`}>
      <span className="text-gray-400 font-bold tracking-tight">{label}</span>
      <span className="text-white font-black">{score} <span className="text-white/20 font-medium">/ {max}</span></span>
    </div>
    <div className={`w-full ${compact ? "h-1.5" : "h-2"} bg-white/5 rounded-full overflow-hidden border border-white/10 relative`}>
      <div
        className={`h-full ${color} transition-all duration-1000 ease-out shadow-[0_0_12px_rgba(255,255,255,0.15)] relative z-10`}
        style={{ width: `${Math.min(100, (score / max) * 100)}%` }}
      />
      {/* 배경 가이드라인 */}
      <div className="absolute inset-0 flex justify-between px-1 pointer-events-none opacity-10">
        <div className="w-px h-full bg-white" />
        <div className="w-px h-full bg-white" />
        <div className="w-px h-full bg-white" />
      </div>
    </div>
  </div>
);

interface TierEvidenceItem {
  label: string;
  value: string;
  note?: string;
}

interface TierEvidenceSummaryItem {
  label: string;
  value: string;
  accent: string;
}

interface TierEvidenceSection {
  title: string;
  accent: string;
  items: TierEvidenceItem[];
}

interface TierTooltipLayout {
  placement: "top" | "bottom";
  maxHeight: number;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const formatPercent = (value: number, digits = 0) => `${Number(value.toFixed(digits))}%`;

const formatSeconds = (ms?: number) => {
  if (!isFiniteNumber(ms) || ms <= 0) return "측정 불가";
  return `${(ms / 1000).toFixed(2)}초`;
};

const getImpactGradeLabel = (grade?: string) => {
  if (grade === "LEGEND") return "레전드";
  if (grade === "HARD_CARRY") return "하드캐리";
  if (grade === "CARRY") return "캐리";
  if (grade === "GOOD") return "좋은 판";
  return "일반";
};

const isDisplayValueAvailable = (value: string) => value !== "응답 필드 없음" && value !== "측정 불가";

const joinEvidenceSummary = (parts: Array<string | false | undefined>, fallback = "측정 불가") => {
  const cleanParts = parts.filter((part): part is string => Boolean(part));
  return cleanParts.length > 0 ? cleanParts.join(", ") : fallback;
};

const getOpportunityRate = (success?: number, total?: number) => {
  if (!isFiniteNumber(total)) {
    return { value: "응답 필드 없음", note: "아군 기절 샘플 필드 없음", isOpportunityMissing: false, isFieldMissing: true };
  }
  if (total <= 0) {
    return { value: "기회 없음 보정", note: "아군 기절 샘플 없음", isOpportunityMissing: true, isFieldMissing: false };
  }
  const safeSuccess = isFiniteNumber(success) ? success : 0;
  const cappedSuccess = Math.min(safeSuccess, total);
  const cappedNote = safeSuccess > total ? `점수 반영 ${cappedSuccess} / ${total}회, 실제 ${safeSuccess}회` : `${safeSuccess} / ${total}회`;
  return {
    value: formatPercent((cappedSuccess / total) * 100),
    note: cappedNote,
    isOpportunityMissing: false,
    isFieldMissing: false
  };
};

const buildTierEvidence = (matchData: MatchData) => {
  const stats = matchData.stats;
  const tradeStats = matchData.tradeStats;
  const totalTeammateKnocks = tradeStats?.teammateKnocks;
  const nextTier = getNextTierInfo(matchData.benchmark?.score || 0);
  const damageRankPct = matchData.matchInfo?.rankPct;
  const survivalBase = matchData.totalTeams || matchData.totalPlayers;
  const survivalRankPct = survivalBase && survivalBase > 0 ? stats.winPlace / survivalBase : null;
  const isActualDeath = Boolean(stats.deathType && stats.deathType !== "alive");
  const isEarlyDeath = (stats.timeSurvived || 0) < 600 || (isActualDeath && (matchData.deathPhase ?? 99) <= 3);
  const isHardEarlyDeath = (stats.timeSurvived || 0) < 300;
  const smokeRate = getOpportunityRate(tradeStats?.smokeRescues, totalTeammateKnocks);
  const reviveRate = getOpportunityRate(tradeStats?.revCount, totalTeammateKnocks);
  const tradeRate = getOpportunityRate(tradeStats?.tradeKills, totalTeammateKnocks);
  const initiativeSamples = matchData.initiativeSampleCount;
  const initiativeValue = isFiniteNumber(initiativeSamples) && initiativeSamples <= 0
    ? "측정 불가"
    : isFiniteNumber(matchData.initiative_rate)
      ? formatPercent(matchData.initiative_rate)
      : "응답 필드 없음";
  const damageValue = isFiniteNumber(damageRankPct)
    ? `상위 ${formatPercent(Math.min(1, Math.max(0, damageRankPct)) * 100)}`
    : matchData.myRank?.damageRank
      ? `#${matchData.myRank.damageRank}`
      : "응답 필드 없음";
  const reactionSpeedValue = formatSeconds(tradeStats?.reactionLatencyMs);
  const pressureValue = isFiniteNumber(matchData.combatPressure?.pressureIndex)
    ? matchData.combatPressure.pressureIndex.toFixed(2)
    : "응답 필드 없음";
  const supportValue = isFiniteNumber(tradeStats?.suppCount) ? `${tradeStats.suppCount}회` : "응답 필드 없음";
  const supportNote = isFiniteNumber(tradeStats?.suppRate)
    ? `지원율 ${formatPercent(tradeStats.suppRate)}`
    : totalTeammateKnocks && totalTeammateKnocks > 0
      ? `아군 기절 ${totalTeammateKnocks}회 기준`
      : undefined;
  const teamWipeValue = isFiniteNumber(tradeStats?.enemyTeamWipes) ? `${tradeStats.enemyTeamWipes}회` : "응답 필드 없음";
  const reversalValue = isFiniteNumber(matchData.duelStats?.reversalRate)
    ? formatPercent(matchData.duelStats.reversalRate)
    : "응답 필드 없음";
  const reversalNote = isFiniteNumber(matchData.duelStats?.reversals) && isFiniteNumber(matchData.duelStats?.reversalAttempts)
    ? `${matchData.duelStats.reversals} / ${matchData.duelStats.reversalAttempts}회`
    : undefined;
  const survivalRankValue = survivalBase ? `#${stats.winPlace} / ${survivalBase}` : `#${stats.winPlace}`;
  const survivalRankNote = survivalRankPct !== null
    ? `순위 비율 ${formatPercent(Math.min(1, Math.max(0, survivalRankPct)) * 100)}`
    : undefined;
  const allTeamOpportunityMissing = smokeRate.isOpportunityMissing && reviveRate.isOpportunityMissing && tradeRate.isOpportunityMissing;
  const allTeamOpportunityFieldMissing = smokeRate.isFieldMissing && reviveRate.isFieldMissing && tradeRate.isFieldMissing;
  const tacticalOpportunityItems: TierEvidenceItem[] = allTeamOpportunityFieldMissing
    ? [
        {
          label: "팀 구출 지표",
          value: "응답 필드 없음",
          note: "아군 기절/구출/트레이드 입력값 없음"
        }
      ]
    : allTeamOpportunityMissing
    ? [
        {
          label: "팀 구출 기회",
          value: "기회 없음 보정",
          note: "연막/소생/트레이드 샘플 없음"
        }
      ]
    : [
        {
          label: "연막 구출률",
          value: smokeRate.value,
          note: smokeRate.note
        },
        {
          label: "소생률",
          value: reviveRate.value,
          note: reviveRate.note
        },
        {
          label: "트레이드 성공률",
          value: tradeRate.value,
          note: tradeRate.note
        }
      ];
  const tacticalOpportunitySummary = allTeamOpportunityMissing
    ? "팀 구출 기회 없음 보정"
    : allTeamOpportunityFieldMissing
      ? undefined
      : joinEvidenceSummary([
        !smokeRate.isOpportunityMissing && `구출 ${smokeRate.value}`,
        !reviveRate.isOpportunityMissing && `소생 ${reviveRate.value}`,
        !tradeRate.isOpportunityMissing && `트레이드 ${tradeRate.value}`
      ]);
  const summaryItems: TierEvidenceSummaryItem[] = [
    {
      label: "전투",
      accent: "bg-red-500",
      value: joinEvidenceSummary([
        isDisplayValueAvailable(damageValue) && `딜량 ${damageValue}`,
        isDisplayValueAvailable(initiativeValue)
          ? `선공 ${initiativeValue}`
          : isDisplayValueAvailable(reactionSpeedValue) && `반응 ${reactionSpeedValue}`
      ], "전투 샘플 측정 불가")
    },
    {
      label: "전술",
      accent: "bg-indigo-500",
      value: joinEvidenceSummary([
        isDisplayValueAvailable(pressureValue) && `압박 ${pressureValue}`,
        tacticalOpportunitySummary
      ], "전술 샘플 측정 불가")
    },
    {
      label: "생존",
      accent: "bg-emerald-500",
      value: joinEvidenceSummary([
        `순위 ${survivalRankValue}`,
        isHardEarlyDeath ? "5분 미만 0점 룰" : isEarlyDeath ? "조기 탈락 보정" : "보정 없음"
      ], "생존 샘플 측정 불가")
    }
  ];

  const sections: TierEvidenceSection[] = [
    {
      title: "전투 근거",
      accent: "bg-red-500",
      items: [
        {
          label: "딜량 순위",
          value: damageValue
        },
        {
          label: "선제공격률",
          value: initiativeValue,
          note: isFiniteNumber(initiativeSamples) ? `샘플 ${initiativeSamples}회` : undefined
        },
        {
          label: "대응 사격 속도",
          value: reactionSpeedValue,
          note: !tradeStats?.reactionLatencyMs ? "피격 후 반격 샘플 없음" : undefined
        }
      ]
    },
    {
      title: "전술 근거",
      accent: "bg-indigo-500",
      items: [
        {
          label: "압박 지수",
          value: pressureValue
        },
        ...tacticalOpportunityItems,
        {
          label: "견제 지원",
          value: supportValue,
          note: supportNote
        },
        {
          label: "적 팀 전멸 기여",
          value: teamWipeValue
        },
        {
          label: "역전 승률",
          value: reversalValue,
          note: reversalNote
        },
        {
          label: "고립 페널티",
          value: (matchData.isolationData?.isolationIndex ?? 0) >= 3.5 ? "적용 가능" : "미적용",
          note: isFiniteNumber(matchData.isolationData?.isolationIndex)
            ? `고립 지수 ${matchData.isolationData.isolationIndex.toFixed(1)}`
            : "응답 필드 없음"
        }
      ]
    },
    {
      title: "생존 근거",
      accent: "bg-emerald-500",
      items: [
        {
          label: "생존 순위",
          value: survivalRankValue,
          note: survivalRankNote
        },
        {
          label: "기절 후 생존 관리력",
          value: "응답 필드 없음",
          note: "현재 매치 응답에 피기절 횟수 미포함"
        },
        {
          label: "조기 탈락 보정",
          value: isEarlyDeath ? "적용" : "미적용",
          note: isEarlyDeath ? "10분 미만 또는 3페이즈 이하 사망" : "정상 생존 구간"
        },
        {
          label: "5분 미만 0점 룰",
          value: isHardEarlyDeath ? "적용" : "미적용",
          note: `${Math.floor((stats.timeSurvived || 0) / 60)}분 생존`
        }
      ]
    }
  ];

  return {
    summaryItems,
    sections,
    nextTierText: nextTier ? `다음 ${nextTier.tier} 티어까지 ${nextTier.needed}점` : "최고 티어",
    nextTierNote: nextTier ? "현재 산식 기준" : "S+ 구간 도달"
  };
};

const TierEvidenceSummary = ({ items }: { items: TierEvidenceSummaryItem[] }) => (
  <div className="mt-3 border-t border-white/10 pt-3 md:mt-4 md:pt-4">
    <div className="mb-1.5 text-[10px] font-black text-white/70 md:mb-2">핵심 근거</div>
    <div className="space-y-1 md:space-y-1.5">
      {items.map((item) => (
        <div key={item.label} className="flex items-start gap-2 text-[10px] leading-snug">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${item.accent}`} />
          <span className="w-8 shrink-0 font-black text-white/80">{item.label}</span>
          <span className="min-w-0 flex-1 text-right font-bold text-white">{item.value}</span>
        </div>
      ))}
    </div>
  </div>
);

const TierEvidenceList = ({ section }: { section: TierEvidenceSection }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2">
      <span className={`h-3 w-1 rounded-full ${section.accent}`} />
      <span className="text-[10px] font-black text-white/80">{section.title}</span>
    </div>
    <div className="space-y-1.5">
      {section.items.map((item) => (
        <div key={`${section.title}-${item.label}`} className="flex items-start justify-between gap-3 text-[10px] leading-snug">
          <span className="text-gray-500 font-bold shrink-0">{item.label}</span>
          <span className="text-right">
            <span className="block text-white font-black">{item.value}</span>
            {item.note && <span className="block text-[9px] text-gray-500 font-medium mt-0.5">{item.note}</span>}
          </span>
        </div>
      ))}
    </div>
  </div>
);

const CollapsibleDetailSection = ({
  title,
  eyebrow,
  icon,
  isOpen,
  onToggle,
  summary,
  children
}: {
  title: string;
  eyebrow: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  summary?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="mt-5 overflow-hidden rounded-[1.75rem] border border-white/5 bg-white/[0.015] md:mt-6 md:rounded-[2rem]">
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-expanded={isOpen}
      className="flex w-full items-center justify-between gap-4 p-4 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] md:p-5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-white/70">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-black text-white">{title}</div>
          <div className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-widest text-gray-500">{eyebrow}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {summary && (
          <div className="hidden max-w-[12rem] truncate text-right text-[10px] font-black text-white/40 sm:block">
            {summary}
          </div>
        )}
        <div className="rounded-lg border border-white/5 bg-white/5 p-1.5">
          <ChevronDown size={14} className={`text-gray-400 transition-transform duration-300 ${isOpen ? "rotate-180 text-white" : ""}`} />
        </div>
      </div>
    </button>
    {isOpen && (
      <div className="border-t border-white/5 p-4 pt-4 animate-in slide-in-from-top-2 duration-300 md:p-5">
        {children}
      </div>
    )}
  </section>
);

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

/**
 * 간단한 마크다운 파서를 통해 AI 응답을 시각적으로 예쁘게 렌더링합니다.
 */
const renderMarkdown = (text: string) => {
  if (!text) return null;
  const lines = text.split('\n');

  return lines.map((line, idx) => {
    if (!line.trim()) return <div key={idx} className="h-2" />;

    let isHeader = false;
    let headerLevel = 0;
    if (line.startsWith('### ')) { isHeader = true; headerLevel = 3; }
    else if (line.startsWith('## ')) { isHeader = true; headerLevel = 2; }
    else if (line.startsWith('# ')) { isHeader = true; headerLevel = 1; }

    let content = line;
    if (isHeader) content = line.replace(/^#+\s/, '');

    const isList = /^[*\-]\s/.test(content.trim());
    const isBold = /\*\*(.*?)\*\*/g.test(content);

    let elements: React.ReactNode = content;
    if (isBold) {
      const parts = content.split(/(\*\*.*?\*\*)/g);
      elements = parts.map((part, pIdx) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={pIdx} className="text-white font-bold">{part.slice(2, -2)}</strong>;
        }
        return part;
      });
    }

    if (isHeader) {
      return (
        <div key={idx} className="flex items-center gap-2 mt-5 mb-3">
          <div className="w-1 h-4 bg-indigo-500 rounded-full shrink-0" />
          <h3 className={`font-black text-white ${headerLevel === 1 ? 'text-lg' : 'text-md'} break-keep`}>
            {elements}
          </h3>
        </div>
      );
    }

    if (isList) {
      return (
        <div key={idx} className="flex gap-2 mb-2 pl-2">
          <span className="text-indigo-400 shrink-0 mt-1">•</span>
          <span className="text-gray-300 text-sm leading-relaxed break-keep">{elements}</span>
        </div>
      );
    }

    return (
      <p key={idx} className="text-gray-400 text-sm leading-relaxed mb-3.5 pl-1 break-keep">
        {elements}
      </p>
    );
  });
};

export interface ExpandedMatchDetailsProps {
  matchId: string;
  nickname: string;
  platform: StatsPlatform;
  isMobile: boolean;
  summary?: MatchSummaryData;
  onNicknameClick?: (nickname: string) => void;
  onModeDetected?: (matchId: string, gameMode: string, matchType?: string, mapName?: string) => void;
  onFailure?: (reason: "detail_failed" | "analysis_failed") => void;
  onRecovery?: (reason: "detail_failed" | "analysis_failed") => void;
}

type MatchDetailState =
  | { status: "summary" }
  | { status: "loading" }
  | { status: "ready"; data: MatchData }
  | { status: "error"; message: string };

function matchOwnerIdentity(platform: StatsPlatform, nickname: string, matchId: string) {
  return `${platform}:${normalizeName(nickname)}:${matchId}`;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

export const ExpandedMatchDetails = ({
  matchId,
  nickname,
  platform,
  isMobile,
  summary: initialMatchData,
  onNicknameClick,
  onModeDetected,
  onFailure,
  onRecovery,
}: ExpandedMatchDetailsProps) => {
  const detailsOnly = true;
  const ownerIdentity = matchOwnerIdentity(platform, nickname, matchId);
  const [matchData, setMatchData] = useState<MatchData | null>(initialMatchData || null);
  const [loading, setLoading] = useState(false);
  const [detailState, setDetailState] = useState<MatchDetailState>({ status: "summary" });
  const [isExpanded, setIsExpanded] = useState(detailsOnly);
  const [openDetailSections, setOpenDetailSections] = useState({
    weapons: false,
    tactical: false,
    ai: false,
    team: false
  });
  const [showReplayModal, setShowReplayModal] = useState(false);
  const [mounted, setMounted] = useState(false);

  const matchDate = (matchData as any)?.playedAt || matchData?.createdAt || matchData?.matchInfo?.date || (initialMatchData as any)?.playedAt || initialMatchData?.createdAt || "";
  const isTelemetryExpired = isMatchTelemetryExpired(matchDate);
  const is14DaysExpired = isMatchOlderThan14Days(matchDate);

  // ref로 감싸서 useCallback 내부에서도 최신 값을 참조할 수 있게 한다
  const is14DaysExpiredRef = useRef(is14DaysExpired);
  useEffect(() => {
    is14DaysExpiredRef.current = is14DaysExpired;
  }, [is14DaysExpired]);

  useEffect(() => {
    setMounted(true);
  }, []);
  const [coachingStyle, setCoachingStyle] = useState<"mild" | "spicy">("spicy");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null);
  const [showTierTooltip, setShowTierTooltip] = useState(false);
  const [showTierDetails, setShowTierDetails] = useState(false);
  const [tierTooltipLayout, setTierTooltipLayout] = useState<TierTooltipLayout>({ placement: "top", maxHeight: 504 });
  const tierRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isAnalyzingRef = useRef(false); // [V46.0] 클로저 세이프 로딩 추적
  const detailRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const detailRequestIdRef = useRef(0);
  const aiGenerationRef = useRef(0);
  const callbacksRef = useRef({ onModeDetected, onFailure, onRecovery });
  useEffect(() => {
    callbacksRef.current = { onModeDetected, onFailure, onRecovery };
  }, [onFailure, onModeDetected, onRecovery]);
  const { isAnalyzing: isGlobalAnalyzing } = useAIStatus();
  const { user } = useAuth();
  const router = useRouter();

  const leadKills = matchData ? (matchData.stats?.leadShotKills ?? matchData.leadShotKills ?? 0) : 0;
  const leadKnocks = matchData ? (matchData.stats?.leadShotKnocks ?? matchData.leadShotKnocks ?? 0) : 0;
  const ridingKills = matchData ? (matchData.stats?.ridingShotKills ?? matchData.ridingShotKills ?? 0) : 0;
  const ridingKnocks = matchData ? (matchData.stats?.ridingShotKnocks ?? matchData.ridingShotKnocks ?? 0) : 0;
  const roadKills = matchData ? (matchData.stats?.roadKills ?? matchData.roadKills ?? 0) : 0;
  const roadKnocks = matchData ? (matchData.stats?.roadKnocks ?? matchData.roadKnocks ?? 0) : 0;
  const vehicleCombatTotal = leadKills + leadKnocks + ridingKills + ridingKnocks + roadKills + roadKnocks;
  const hasVehicleCombat = vehicleCombatTotal > 0;
  const normalizedNickname = normalizeName(nickname);
  const normalizedTeamMembers = useMemo(() => {
    const memberMap = new Map<string, MatchTeamMember>();
    (matchData?.team || []).forEach((member) => {
      const key = normalizeName(member.name);
      if (!key) return;
      const existing = memberMap.get(key);
      if (!existing) {
        memberMap.set(key, { ...member });
        return;
      }
      memberMap.set(key, {
        ...existing,
        kills: (existing.kills || 0) + (member.kills || 0),
        assists: (existing.assists || 0) + (member.assists || 0),
        damageDealt: (existing.damageDealt || 0) + (member.damageDealt || 0),
        DBNOs: (existing.DBNOs || 0) + (member.DBNOs || 0),
        revives: (existing.revives || 0) + (member.revives || 0),
        deaths: (existing.deaths || 0) + (member.deaths || 0),
        deathType: existing.deathType || member.deathType
      });
    });
    return Array.from(memberMap.values());
  }, [matchData]);
  const normalizedSquadWeaponStats = useMemo(() => {
    type SquadWeaponStat = NonNullable<MatchData["squadWeaponStats"]>[string][number];
    const playerMap = new Map<string, { displayName: string; weapons: Map<string, SquadWeaponStat> }>();

    Object.entries(matchData?.squadWeaponStats || {}).forEach(([playerName, weapons]) => {
      const playerKey = normalizeName(playerName);
      if (!playerKey || !Array.isArray(weapons)) return;
      const playerEntry = playerMap.get(playerKey) || { displayName: playerName, weapons: new Map<string, SquadWeaponStat>() };

      weapons.forEach((weaponStat) => {
        const weaponKey = weaponStat.weapon || "unknown";
        const existing = playerEntry.weapons.get(weaponKey);
        if (!existing) {
          playerEntry.weapons.set(weaponKey, { ...weaponStat });
          return;
        }
        const shots = (existing.shots || 0) + (weaponStat.shots || 0);
        const hits = (existing.hits || 0) + (weaponStat.hits || 0);
        playerEntry.weapons.set(weaponKey, {
          ...existing,
          damage: (existing.damage || 0) + (weaponStat.damage || 0),
          dBNODamage: (existing.dBNODamage || 0) + (weaponStat.dBNODamage || 0),
          shots,
          hits,
          dBNOHits: (existing.dBNOHits || 0) + (weaponStat.dBNOHits || 0),
          holdingTime: (existing.holdingTime || 0) + (weaponStat.holdingTime || 0),
          accuracy: shots > 0 ? Math.round((hits / shots) * 100) : 0,
          hitDetails: [...(existing.hitDetails || []), ...(weaponStat.hitDetails || [])]
        });
      });

      playerMap.set(playerKey, playerEntry);
    });

    return Array.from(playerMap.values()).reduce<Record<string, SquadWeaponStat[]>>((acc, entry) => {
      acc[entry.displayName] = Array.from(entry.weapons.values());
      return acc;
    }, {});
  }, [matchData]);
  const toggleDetailSection = (section: keyof typeof openDetailSections) => {
    setOpenDetailSections((current) => ({
      ...current,
      [section]: !current[section]
    }));
  };

  const updateTierTooltipLayout = useCallback(() => {
    if (isMobile || !tierRef.current) return;

    const rect = tierRef.current.getBoundingClientRect();
    const gap = 12;
    const viewportPadding = 16;
    const preferredMaxHeight = Math.min(504, Math.max(240, window.innerHeight - viewportPadding * 2));
    const spaceAbove = Math.max(0, rect.top - gap - viewportPadding);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
    const placement = spaceAbove >= preferredMaxHeight || spaceAbove >= spaceBelow ? "top" : "bottom";
    const availableSpace = placement === "top" ? spaceAbove : spaceBelow;

    setTierTooltipLayout({
      placement,
      maxHeight: Math.max(220, Math.min(preferredMaxHeight, availableSpace))
    });
  }, [isMobile]);

  // 상세·AI 요청은 platform+nickname+matchId 전체 identity가 소유한다.
  useEffect(() => {
    return () => {
      detailRequestIdRef.current += 1;
      detailRequestRef.current?.controller.abort();
      detailRequestRef.current = null;
      aiGenerationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      aiManager.stopAnalysis(ownerIdentity);
      isAnalyzingRef.current = false;
    };
  }, [ownerIdentity]);

  // 리플레이 모달과 모바일 티어 tooltip 오픈 시 배경 스크롤 방지
  useEffect(() => {
    const shouldLockScroll = showReplayModal || (showTierTooltip && isMobile);
    if (!shouldLockScroll) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, [showReplayModal, showTierTooltip, isMobile]);

  useEffect(() => {
    if (!showTierTooltip) {
      setShowTierDetails(false);
    }
  }, [showTierTooltip]);

  useEffect(() => {
    if (!showTierTooltip || isMobile) return;

    updateTierTooltipLayout();
    window.addEventListener("resize", updateTierTooltipLayout);
    window.addEventListener("scroll", updateTierTooltipLayout, true);

    return () => {
      window.removeEventListener("resize", updateTierTooltipLayout);
      window.removeEventListener("scroll", updateTierTooltipLayout, true);
    };
  }, [showTierTooltip, isMobile, updateTierTooltipLayout]);

  useEffect(() => {
    if (!showTierTooltip || !isMobile) return;

    const handleClickOutside = (event: PointerEvent) => {
      if (tierRef.current && !tierRef.current.contains(event.target as Node)) {
        setShowTierTooltip(false);
      }
    };

    document.addEventListener("pointerdown", handleClickOutside);

    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
    };
  }, [showTierTooltip, isMobile]);

  const openTierTooltip = () => {
    if (isMobile) return;
    updateTierTooltipLayout();
    setShowTierTooltip(true);
  };

  const renderTierBadge = () => {
    if (isTdmMatch) {
      return (
        <div className="px-2.5 py-1 md:px-4 md:py-1.5 rounded-xl border border-rose-500/30 bg-rose-500/20 text-rose-400 font-black text-xs md:text-sm tracking-tight flex items-center gap-1">
          <Zap size={10} className="text-rose-400 shrink-0 animate-pulse" />
          <span>TDM</span>
        </div>
      );
    }

    const score = matchData?.benchmark?.score || 0;
    const tier = estimateUserTier(score);

    // 티어별 색상/스타일 정의
    const getTierStyle = (t: string) => {
      const tier = t.toUpperCase();
      if (tier.startsWith('S')) return "bg-amber-500/20 border-amber-500/50 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.3)] font-black";
      if (tier.startsWith('A')) return "bg-indigo-500/20 border-indigo-500/50 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.15)]";
      if (tier.startsWith('B')) return "bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.15)]";
      if (tier.startsWith('C')) return "bg-blue-500/20 border-blue-500/50 text-blue-400";
      if (tier.startsWith('D')) return "bg-slate-500/20 border-slate-500/50 text-slate-400";
      return "bg-white/5 border-white/10 text-gray-400";
    };

    return (
      <button
        onMouseEnter={openTierTooltip}
        onClick={(e) => {
          e.stopPropagation();
          if (isMobile) setShowTierTooltip(!showTierTooltip);
        }}
        aria-expanded={showTierTooltip}
        className={`px-2.5 py-1 md:px-4 md:py-1.5 rounded-xl border flex items-center gap-1.5 md:gap-2 transition-all cursor-help hover:scale-105 active:scale-95 ${getTierStyle(tier)}`}
      >
        <span className="text-xs md:text-sm font-black italic tracking-tighter">{tier} Tier</span>
        <div className="w-px h-2.5 md:h-3 bg-current opacity-20" />
        <span className="text-[10px] md:text-[11px] font-black">{score}pt</span>
      </button>
    );
  };

  // 맵 이름 한글 번역 매핑
  const getTranslatedMapName = (name: string) => {
    const mapping: Record<string, string> = {
      "Baltic_Main": "에란겔",
      "Desert_Main": "미라마",
      "Savage_Main": "사녹",
      "Summerland_Main": "카라킨",
      "Chimera_Main": "파라모",
      "Tiger_Main": "태이고",
      "Kiki_Main": "데스턴",
      "Neon_Main": "론도",
      "DihorOtok_Main": "비켄디",
      "PillarCompound_Main": "필라 기지 (TDM)",
      "Italy_TDM_Main": "리틀 이탈리아 (TDM)",
      "Baltic_TDM_Main": "에란겔 (TDM)",
      "Range_Main": "훈련장",
      "SafeHouse": "세이프하우스"
    };
    return mapping[name] || name;
  };

  // 맵 이름 매핑 (한글/영문 -> 내부 mapId)
  const getMapId = (name: string) => {
    const mapping: Record<string, string> = {
      "에란겔": "Erangel",
      "미라마": "Miramar",
      "사녹": "Sanhok",
      "태이고": "Taego",
      "데스턴": "Deston",
      "론도": "Rondo",
      "비켄디": "Vikendi",
      "카라킨": "Karakin",
      "파라모": "Paramo",
      "헤이븐": "Haven",
      "Baltic_Main": "Erangel",
      "Desert_Main": "Miramar",
      "Savage_Main": "Sanhok",
      "Tiger_Main": "Taego",
      "Kiki_Main": "Deston",
      "Neon_Main": "Rondo",
      "Chimera_Main": "Vikendi"
    };
    const mapped = mapping[name];
    if (mapped) return mapped;

    // 폴백 로직: 첫 글자 대문자화 (예: erangel -> Erangel)
    const fallback = name.toLowerCase().replace(/_main/i, "");
    return fallback.charAt(0).toUpperCase() + fallback.slice(1);
  };

  const mapId = getMapId(matchData?.mapName || "");

  const handleInternalReplay = (e: React.MouseEvent) => {
    e.stopPropagation();
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "2d-replay",
        status: "start"
      }
    });
    router.push(`/maps/${mapId}?playback=${matchId}&nickname=${nickname}&platform=${encodeURIComponent(platform)}`);
  };


  const fetchFullMatch = useCallback(async () => {
    if (detailRequestRef.current || is14DaysExpiredRef.current) return;
    const controller = new AbortController();
    const requestId = ++detailRequestIdRef.current;
    detailRequestRef.current = { id: requestId, controller };
    setLoading(true);
    setDetailState({ status: "loading" });
    const stale = () => requestId !== detailRequestIdRef.current
      || detailRequestRef.current?.controller !== controller
      || controller.signal.aborted;
    try {
      const res = await fetch(`/api/pubg/match?matchId=${matchId}&nickname=${nickname}&platform=${platform}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json() as MatchData & { error?: string };
      if (stale()) return;
      if (!res.ok || data.error) throw new Error(data.error || "상세 정보를 불러오지 못했습니다");

      callbacksRef.current.onModeDetected?.(
        matchId,
        data.gameMode || "",
        data.matchType,
        data.mapName,
      );
      const mode = (data.gameMode || "").toLowerCase();
      const map = data.mapName || "";
      const isExcluded =
        mode.includes("event") ||
        mode.includes("flare") ||
        mode.includes("ai-match") ||
        map.includes("SafeHouse") ||
        (map.includes("Range_Main") && !mode.includes("tdm"));
      if (isExcluded) throw new Error("상세 정보를 불러오지 못했습니다");

      if (stale()) return;
      setMatchData(data);
      setDetailState({ status: "ready", data });
      callbacksRef.current.onRecovery?.("detail_failed");
    } catch (caught) {
      if (stale() || isAbortError(caught)) return;
      setDetailState({ status: "error", message: "상세 정보를 불러오지 못했습니다" });
      callbacksRef.current.onFailure?.("detail_failed");
    } finally {
      if (!stale()) {
        detailRequestRef.current = null;
        setLoading(false);
      }
    }
  }, [matchId, nickname, platform]);

  const detailIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (detailIdentityRef.current === ownerIdentity) return;
    detailIdentityRef.current = ownerIdentity;
    detailRequestIdRef.current += 1;
    detailRequestRef.current?.controller.abort();
    detailRequestRef.current = null;

    if (initialMatchData) {
      setMatchData(initialMatchData);
      setLoading(false);
      setDetailState({ status: "summary" });
      callbacksRef.current.onModeDetected?.(
        matchId,
        initialMatchData.gameMode || initialMatchData.matchInfo?.mode || "",
        initialMatchData.matchType,
        initialMatchData.mapName,
      );
      return;
    }

    setMatchData(null);
    setLoading(false);
    setDetailState({ status: "summary" });
  }, [initialMatchData, matchId, ownerIdentity]);

  useEffect(() => {
    if ((detailsOnly || isExpanded) && detailState.status === "summary" && !is14DaysExpiredRef.current) {
      void fetchFullMatch();
    }
  }, [detailState.status, detailsOnly, fetchFullMatch, isExpanded]);

  const handleAnalyze = async (e: React.MouseEvent) => {
    e.stopPropagation();

    //  [보안] 비로그인 유저 AI 분석 차단 — 로그인 유도 토스트
    if (!user) {
      toast.error("AI 전술 분석은 로그인 후 이용할 수 있습니다.", {
        action: {
          label: "로그인",
          onClick: () => router.push("/login"),
        },
      });
      return;
    }

    // [V45.9] 전역 락 체크: 내가 분석 중인 게 아니면 다른 분석 시작 금지
    if (isGlobalAnalyzing || isAnalyzing || analysis) return;

    if (!aiManager.startAnalysis(ownerIdentity)) return;

    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
    setAnalysis("");

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const generation = ++aiGenerationRef.current;
    const isCurrentAiRequest = () => generation === aiGenerationRef.current
      && abortControllerRef.current === abortController
      && !abortController.signal.aborted;

    // [V46.1] 클라이언트 측 세이프티 타임아웃 (45초)
    const safetyTimeout = setTimeout(() => {
      if (isCurrentAiRequest() && isAnalyzingRef.current) {
        abortController.abort();
        setIsAnalyzing(false);
        isAnalyzingRef.current = false;
        aiManager.stopAnalysis(ownerIdentity);
      }
    }, 45000);

    let lineBuffer = "";

    // GA4 이벤트 트래킹: AI 코칭 시작
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "ai-coaching",
        status: "start"
      }
    });

    try {
      const res = await fetch("/api/pubg/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ matchData, nickname, platform, coachingStyle })
      });

      if (!res.ok) throw new Error("분석 요청 실패");

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedAnalysis = "";

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === "chunk" && isCurrentAiRequest()) {
                  accumulatedAnalysis += parsed.data;
                  setAnalysis(accumulatedAnalysis);
                }
              } catch {
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      // GA4 이벤트 트래킹: AI 코칭 성공
      trackEvent({
        name: "feature_consumption",
        params: {
          feature_name: "ai-coaching",
          status: "success"
        }
      });
      if (isCurrentAiRequest()) callbacksRef.current.onRecovery?.("analysis_failed");
    } catch (err: any) {
      // GA4 이벤트 트래킹: AI 코칭 실패
      trackEvent({
        name: "feature_consumption",
        params: {
          feature_name: "ai-coaching",
          status: "fail",
          error_type: err.name === 'AbortError' ? 'user_abort' : (err.message || 'unknown')
        }
      });
      if (isCurrentAiRequest() && !isAbortError(err)) {
        callbacksRef.current.onFailure?.("analysis_failed");
      }
    } finally {
      clearTimeout(safetyTimeout);
      if (generation === aiGenerationRef.current && abortControllerRef.current === abortController) {
        setIsAnalyzing(false);
        isAnalyzingRef.current = false;
        aiManager.stopAnalysis(ownerIdentity);
        abortControllerRef.current = null;
      }
    }
  };

  if (detailState.status === "error") {
    return (
      <div className="rounded-b-2xl border border-t-0 border-red-500/20 bg-red-500/10 p-4" role="alert">
        <p className="text-sm font-black text-red-200">상세 정보를 불러오지 못했습니다</p>
        <p className="mt-1 text-xs text-red-100/60">접힌 매치 요약은 그대로 유지됩니다.</p>
        <button
          type="button"
          onClick={() => void fetchFullMatch()}
          className="mt-3 min-h-11 rounded-lg border border-red-400/20 px-3 text-xs font-black text-red-100"
        >
          상세 다시 시도
        </button>
      </div>
    );
  }

  if (loading) {
    return <div className="h-24 bg-white/5 border border-white/10 rounded-2xl animate-pulse mb-3" />;
  }

  if (!matchData) {
    // initialMatchData 없이 렌더된 카드: 자동으로 PUBG API에서 기본 스탯 로드
    return (
      <div
        className="mb-3 flex min-h-24 items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 cursor-pointer hover:bg-white/[0.07] transition-colors"
        onClick={() => void fetchFullMatch()}
      >
        <div className="min-w-0 flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 rounded-2xl bg-white/5 animate-pulse" />
          <div className="flex flex-col gap-1.5">
            <div className="h-4 w-32 bg-white/10 rounded animate-pulse" />
            <div className="h-3 w-20 bg-white/5 rounded animate-pulse" />
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="hidden sm:flex flex-col items-center gap-1">
            <div className="h-3 w-8 bg-white/5 rounded animate-pulse" />
            <div className="h-5 w-6 bg-white/10 rounded animate-pulse" />
          </div>
          <div className="hidden sm:flex flex-col items-center gap-1">
            <div className="h-3 w-8 bg-white/5 rounded animate-pulse" />
            <div className="h-5 w-12 bg-white/10 rounded animate-pulse" />
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void fetchFullMatch(); }}
            className="min-h-9 shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white/40 transition-colors hover:bg-white/10"
          >
            매치 상세 불러오기
          </button>
        </div>
      </div>
    );
  }

  const is3DReplaySupported = resolve3DMapCapability(matchData.mapName || "") !== null;



  // TDM 판정 규칙
  const isTdmMatch = (matchData.gameMode || "").toLowerCase().includes("tdm") ||
                     (matchData.mapName || "").toLowerCase().includes("tdm") ||
                     (matchData.mapName || "") === "PillarCompound_Main" ||
                     (matchData.mapName || "") === "Italy_TDM_Main";

  // 커스텀 매치 판정 규칙
  const isCustomMatch = (matchData.matchType || "").toLowerCase().includes("custom");

  const isRanked = !isTdmMatch && (
                   matchData.matchType === 'competitive' ||
                   (matchData.gameMode || "").includes("competitive") ||
                   (matchData.gameMode || "").includes("ranked") ||
                   // [V11.9] 경쟁전 판정 정밀화: 16위 이내 + 전체 16팀 규격 + 경쟁전 가능 맵인 경우만 인정
                   (
                     matchData.stats.winPlace <= 16 &&
                     matchData.totalTeams === 16 &&
                     !["사녹", "카라킨", "파라모", "헤이븐"].includes(matchData.mapName || "") &&
                     (matchData.gameMode || "").includes("squad") &&
                     !(matchData.gameMode || "").includes("ai-match")
                   ));
  const isSoloScoring = !isTdmMatch && (matchData.gameMode || "").includes("solo");
  const scoreMax = isSoloScoring
    ? { combat: 50, tactical: 15, survival: 35 }
    : { combat: 40, tactical: 35, survival: 25 };
  const isWin = matchData.stats.winPlace === 1;
  const isTop10 = isTdmMatch ? false : matchData.stats.winPlace <= 10;
  const tierEvidence = isTdmMatch ? null : buildTierEvidence(matchData);

  const totalScale = matchData.totalTeams || 0;

  return (
    <div className={`mb-4 rounded-[2rem] border transition-all duration-300 shadow-2xl relative
      ${showTierTooltip ? 'overflow-visible' : 'overflow-hidden'}
      ${isWin ? 'border-amber-500/50' : isRanked ? 'border-amber-500/20 hover:border-amber-500/40' : 'border-white/10 hover:border-white/20'}
      ${isWin ? 'bg-gradient-to-br from-[#1a1200] via-black to-[#0d0d0d]' : isRanked ? 'bg-gradient-to-br from-black/80 via-black/60 to-[#1a1508]' : 'bg-black/40 hover:bg-black/50'}
      ${(isExpanded || showTierTooltip) ? 'ring-1 ring-white/20 z-[999] isolation-isolate' : 'z-10'} hover:z-[70]`}>

      {/* 승리 shimmer 효과 */}
      {isWin && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -right-20 w-64 h-64 bg-amber-500/10 rounded-full blur-[60px]" />
          <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-amber-600/8 rounded-full blur-[40px]" />
        </div>
      )}

      {/* 과거 전적 보존 안내 바 */}
      {isExpanded && is14DaysExpired && (
        <div className="mx-3 md:mx-5 mt-3.5 p-3 bg-sky-500/10 border border-sky-500/20 rounded-xl flex items-center gap-2 text-xs text-sky-300">
          <Info size={14} className="shrink-0 text-sky-400" />
          <span>14일이 경과된 과거 전적입니다. 순위, 킬, 딜량, 맵 정보가 영구 보존되어 있습니다.</span>
        </div>
      )}

      {/* ── 스코어카드 헤더 ─────────────────────────────── */}
      {!detailsOnly && (
        <div
          onClick={() => setIsExpanded(!isExpanded)}
          className="relative p-3.5 md:p-5 cursor-pointer group"
        >
        {/* 상단 행: 순위 + 맵/모드/시간 + 티어 + 펼치기 */}
        <div className="flex items-center gap-3 md:gap-4">

          {/* 순위 박스 */}
          <div className={`shrink-0 w-13 h-13 md:w-18 md:h-18 rounded-2xl flex flex-col items-center justify-center font-black transition-transform group-hover:scale-105 relative overflow-hidden
            ${isWin
              ? 'bg-amber-500 text-black shadow-[0_0_30px_rgba(245,158,11,0.5)]'
              : isTop10
              ? 'bg-green-500/15 text-green-400 border border-green-500/30'
              : 'bg-white/5 text-white/50 border border-white/10'}`}>
            {isWin && <div className="absolute inset-0 bg-gradient-to-b from-white/20 to-transparent" />}
            <span className="text-[8px] md:text-[9px] uppercase tracking-widest opacity-60 relative z-10">
              {isTdmMatch ? 'RESULT' : isWin ? <Trophy className="mx-auto h-3 w-3" /> : 'RANK'}
            </span>
            <span className={`leading-none relative z-10 ${isTdmMatch ? 'text-xs md:text-sm font-black' : 'text-lg md:text-2xl'}`}>
              {isTdmMatch ? (isWin ? 'WIN' : 'LOSE') : `#${matchData.stats.winPlace}`}
            </span>
            {!isTdmMatch && (
              <span className="text-[7px] md:text-[8px] opacity-40 relative z-10">/ {totalScale}</span>
            )}
          </div>

          {/* 맵명 + 모드 + 시간 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white font-black text-base md:text-lg tracking-tight truncate">
                {getTranslatedMapName(matchData.mapName)}
              </span>
              <span className="text-[10px] text-white/25 font-bold shrink-0">
                {getRelativeTime(matchData.createdAt)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider flex items-center gap-1
                ${isRanked ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                  isTdmMatch ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' :
                  isCustomMatch ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' :
                  'bg-white/8 text-white/40 border border-white/10'}`}>
                {isRanked && <Swords size={9} />}
                {isTdmMatch && <Zap size={9} className="animate-pulse" />}
                {isRanked ? '경쟁전' : isTdmMatch ? '아케이드' : isCustomMatch ? '커스텀' : '일반전'}
              </span>
              <span className="px-2 py-0.5 bg-white/5 rounded-md text-[10px] text-white/30 font-bold border border-white/8">
                {(() => {
                  if (isTdmMatch) return '팀 데스매치';
                  const mode = (matchData.gameMode || '').toLowerCase();
                  const isFpp = mode.includes('fpp');
                  const type = mode.includes('solo') ? '솔로' : mode.includes('duo') ? '듀오' : '스쿼드';
                  return `${isFpp ? '1인칭' : '3인칭'} ${type}`;
                })()}
              </span>
              {!isTdmMatch && matchData.myRank && (
                <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded-md text-[10px] text-amber-400 font-black flex items-center gap-1 hidden md:flex">
                  <Trophy size={9} />킬 순위 #{matchData.myRank.killRank || 1}
                </span>
              )}
              {is14DaysExpired && (
                <span className="px-2 py-0.5 bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-md text-[10px] font-bold flex items-center gap-1">
                  <Info size={9} />과거 전적 보존
                </span>
              )}
            </div>
          </div>

          {/* 티어 배지 + 펼치기 */}
          <div className="flex items-center gap-2 shrink-0">
            {matchData.benchmark && (
              <div
                className="relative"
                ref={tierRef}
                onMouseEnter={openTierTooltip}
                onMouseLeave={() => !isMobile && setShowTierTooltip(false)}
              >
                {renderTierBadge()}
                {showTierTooltip && (
                  <>
                    {!isMobile && (
                      <div
                        aria-hidden="true"
                        className={`absolute right-0 h-3 w-[24rem] ${
                          tierTooltipLayout.placement === "top" ? "bottom-full" : "top-full"
                        }`}
                      />
                    )}
                    <div
                      ref={tooltipRef}
                      onClick={(e) => e.stopPropagation()}
                      data-testid="match-tier-tooltip"
                      style={!isMobile ? { maxHeight: `${tierTooltipLayout.maxHeight}px` } : undefined}
                      className={`${isMobile
                        ? 'fixed inset-x-4 bottom-20 max-h-[58vh] overflow-y-auto overscroll-contain animate-in slide-in-from-bottom-5'
                        : `absolute right-0 w-[24rem] overflow-y-auto overscroll-contain animate-in fade-in zoom-in-95 ${
                          tierTooltipLayout.placement === "top" ? "bottom-full mb-3" : "top-full mt-3"
                        }`
                      } bg-[#0a0a0a] border border-white/20 p-3.5 md:p-5 rounded-[1.35rem] md:rounded-[2rem] shadow-[0_20px_50px_rgba(0,0,0,0.9)] z-[1001]`}
                    >
                    <div className="flex justify-between items-center border-b border-white/10 pb-2 mb-3 md:mb-4">
                      <div className="text-[12px] font-black text-indigo-400 uppercase tracking-widest">매치 상세 분석</div>
                      <div className="flex items-center gap-2">
                        <span className="text-white bg-indigo-500 px-2 py-0.5 rounded-full text-[10px] tabular-nums">
                          안정도 {matchData.benchmark.score} / 100
                        </span>
                        {isMobile && (
                          <button
                            type="button"
                            aria-label="티어 상세 닫기"
                            onClick={() => setShowTierTooltip(false)}
                            className="-mr-1 rounded-lg p-1.5 text-white/50 active:bg-white/10"
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className={isMobile ? "space-y-2.5" : "space-y-4"}>
                      <ScoreBar compact={isMobile} label="전투" score={matchData.benchmark.breakdown.combat} max={scoreMax.combat} color="bg-gradient-to-r from-red-600 to-red-400" />
                      <ScoreBar compact={isMobile} label="전술" score={matchData.benchmark.breakdown.tactical} max={scoreMax.tactical} color="bg-gradient-to-r from-indigo-600 to-indigo-400" />
                      <ScoreBar compact={isMobile} label="생존" score={matchData.benchmark.breakdown.survival} max={scoreMax.survival} color="bg-gradient-to-r from-emerald-600 to-emerald-400" />
                    </div>
                    {isFiniteNumber(matchData.benchmark.impactScore) && (
                      <div className="mt-3 rounded-xl border border-yellow-400/20 bg-yellow-400/10 p-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[10px] font-black text-yellow-200">매치 임팩트</span>
                          <span className="text-[11px] font-black text-yellow-100 tabular-nums">
                            {matchData.benchmark.impactScore} · {getImpactGradeLabel(matchData.benchmark.impactGrade)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-3 text-[9px] font-bold text-yellow-100/60">
                          <span>전술 안정도 대비</span>
                          <span className="tabular-nums">+{matchData.benchmark.impactBonus || 0}</span>
                        </div>
                        {matchData.benchmark.impactReasons && matchData.benchmark.impactReasons.length > 0 && (
                          <p className="mt-1 text-[9px] font-semibold leading-relaxed text-yellow-100/60">
                            {matchData.benchmark.impactReasons.slice(0, 3).join(", ")}
                          </p>
                        )}
                      </div>
                    )}
                    <TierEvidenceSummary items={tierEvidence?.summaryItems || []} />
                    <div className="mt-3 md:mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-2.5 md:p-3">
                      <div className="flex flex-col">
                        <span className="text-[9px] font-black text-amber-300/70">다음 티어</span>
                        <span className="text-[11px] font-black text-amber-200">{tierEvidence?.nextTierText}</span>
                      </div>
                      <span className="text-right text-[9px] font-bold text-amber-200/50">{tierEvidence?.nextTierNote}</span>
                    </div>
                    {isMobile ? (
                      <div className="mt-4 border-t border-white/10 pt-3">
                        <button
                          type="button"
                          data-testid="match-tier-detail-toggle"
                          aria-expanded={showTierDetails}
                          onClick={() => setShowTierDetails((current) => !current)}
                          className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-black text-white/75 active:scale-[0.99]"
                        >
                          <span>{showTierDetails ? "상세 근거 접기" : "상세 근거 보기"}</span>
                          <ChevronDown size={14} className={`transition-transform ${showTierDetails ? "rotate-180" : ""}`} />
                        </button>
                        {showTierDetails && (
                          <div className="mt-4 space-y-4">
                            {tierEvidence?.sections.map((section) => (
                              <TierEvidenceList key={section.title} section={section} />
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-5 space-y-4 border-t border-white/10 pt-4">
                        {tierEvidence?.sections.map((section) => (
                          <TierEvidenceList key={section.title} section={section} />
                        ))}
                      </div>
                    )}
                    <div className="mt-4 hidden text-[9px] text-gray-400 leading-relaxed font-medium bg-white/5 p-2 rounded-lg border border-white/5 italic md:block">
                      * 기존 점수 산식은 그대로 유지하며, 현재 매치 응답에 포함된 필드만 근거로 표시합니다.
                    </div>
                  </div>
                  </>
                )}
              </div>
            )}
            <div className="p-2 hover:bg-white/5 rounded-full transition-colors">
              <ChevronDown className={`text-gray-500 transition-transform duration-500 ${isExpanded ? 'rotate-180' : ''}`} />
            </div>
          </div>
        </div>

        {/* ── 수평 스탯 배지 행 ── */}
        <div className="mt-2.5 pt-2.5 border-t border-white/5 flex items-center gap-1.5 md:gap-4 flex-wrap">
          {/* Kills */}
          <div className="flex items-baseline gap-0.5 md:gap-1">
            <span className={`font-black text-base md:text-xl leading-none ${matchData.stats.kills >= 10 ? 'text-red-400' : matchData.stats.kills >= 5 ? 'text-orange-400' : 'text-white/70'}`}>
              {matchData.stats.kills}
            </span>
            <span className="text-[9px] md:text-[10px] text-white/25 font-black uppercase">Kills</span>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* Dmg */}
          <div className="flex items-baseline gap-0.5 md:gap-1">
            <span className={`font-black text-base md:text-xl leading-none ${Number(matchData.stats.damageDealt) >= 500 ? 'text-indigo-300' : 'text-indigo-400/70'}`}>
              {Math.floor(Number(matchData.stats.damageDealt) || 0)}
            </span>
            <span className="text-[9px] md:text-[10px] text-white/25 font-black uppercase">Dmg</span>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* DBNO */}
          <div className="flex items-baseline gap-0.5 md:gap-1">
            <span className="text-yellow-400/80 font-black text-sm md:text-base leading-none">
              {Number(matchData.stats.DBNOs) || 0}
            </span>
            <span className="text-[9px] md:text-[10px] text-white/25 font-black uppercase">DBNO</span>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* 헤드샷율 */}
          {matchData.stats.kills > 0 && (
            <>
              <div className="flex items-baseline gap-0.5 md:gap-1">
                <span className="text-rose-400/80 font-black text-sm md:text-base leading-none">
                  {((Number(matchData.stats.headshotKills) / matchData.stats.kills) * 100).toFixed(0)}%
                </span>
                <span className="text-[9px] md:text-[10px] text-white/25 font-black uppercase">헤드샷 킬</span>
              </div>
              <div className="w-px h-3 bg-white/10" />
            </>
          )}

          {/* 생존시간 */}
          <div className="flex items-baseline gap-0.5 md:gap-1">
            <span className="text-emerald-400/70 font-black text-sm md:text-base leading-none">
              {Math.floor((Number(matchData.stats.timeSurvived) || 0) / 60)}분
            </span>
            <span className="text-[9px] md:text-[10px] text-white/25 font-black uppercase">생존</span>
          </div>

          {/* 팀딜 비중 */}
          {(matchData.teamImpact?.teamDamageShare ?? 0) > 0 && (
            <>
              <div className="w-px h-3 bg-white/10" />
              <div className="flex items-center gap-1 bg-orange-500/10 px-1.5 py-0.5 md:px-2 md:py-0.5 rounded-full border border-orange-500/20">
                <Flame size={9} className="text-orange-400" />
                <span className="text-[9px] md:text-[10px] text-orange-400 font-black">
                  팀 {Number(matchData.teamImpact?.teamDamageShare || 0).toFixed(1)}%
                </span>
              </div>
            </>
          )}
        </div>

        {/* ── 전술 배지 행 ── */}
        {matchData.badges && matchData.badges.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {matchData.badges.map((badge: any, i: number) => {
              let badgeIcon: BgmsIconName = 'award';
              if (badge.id === 'smoke_master') badgeIcon = 'shield';
              else if (badge.id === 'sharpshooter') badgeIcon = 'crosshair';
              else if (badge.id === 'zone_wizard') badgeIcon = 'zap';
              else if (badge.id === 'last_survivor') badgeIcon = 'shield';
              else if (badge.id === 'damage_carry') badgeIcon = 'flame';
              return (
                <div key={i} className="flex items-center gap-1.5 bg-white/5 border border-white/10 hover:border-white/20 px-2.5 py-1 rounded-full text-[11px] font-bold text-white/60 transition-colors">
                  <BgmsIcon name={badgeIcon} size={13} />
                  <span>{badge.name}</span>
                </div>
              );
            })}
          </div>
        )}
        </div>
      )}

      {/* Quick Action Bar (Floating) */}
      {!isTdmMatch && (
        <div className="px-3.5 pb-3.5 md:px-5 md:pb-4 flex flex-wrap gap-2 md:gap-3">
          <button
            type="button"
            aria-label="리플레이 분석"
            onClick={(e) => {
              e.stopPropagation();
              setShowReplayModal(true);
            }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[10px] md:text-[11px] font-black uppercase tracking-tighter transition-all hover:scale-105 active:scale-95 bg-[#ff9f0a] hover:bg-[#e08b00] text-[#0d1117] shadow-[0_0_20px_rgba(255,159,10,0.25)] border border-[#ff9f0a]/30 cursor-pointer`}
          >
            <PlayCircle size={13} className="md:w-4 md:h-4 shrink-0" />
            리플레이 분석
          </button>
        </div>
      )}

      {/* Expanded Content */}
      {isExpanded && (
        <div className="p-3 md:p-6 pt-0 border-t border-white/5 animate-in slide-in-from-top-4 duration-500 bg-[#0c0c0c] rounded-b-[2rem] isolation-isolate relative z-10">
          {tierEvidence && (
            <section aria-label="티어 산정 근거" className="mt-6 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4">
              <h4 className="text-sm font-black text-indigo-200">티어 산정 근거</h4>
              <TierEvidenceSummary items={tierEvidence.summaryItems} />
            </section>
          )}

          {/* Detailed Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <StatBox icon={<Crosshair size={16} />} label="헤드샷" value={Number(matchData!.stats.headshotKills) || 0} color="text-red-400" />
            <StatBox icon={<Zap size={16} />} label="어시스트" value={Number(matchData!.stats.assists) || 0} color="text-indigo-400" />
            <StatBox icon={<Shield size={16} />} label="기절시킴" value={Number(matchData!.stats.DBNOs) || 0} color="text-yellow-400" />
            <StatBox icon={<Clock size={16} />} label="생존시간" value={`${Math.floor((Number(matchData!.stats.timeSurvived) || 0) / 60)}분`} color="text-green-400" />
          </div>

          {/* Premium Vehicle Combat Banner */}
          {hasVehicleCombat && (() => {
            const isMaster = vehicleCombatTotal >= 2;
            const badgeTitle = isMaster ? "차량 전술 교전 마스터" : "차량 기동 교전";
            const badgeDesc = isMaster
              ? "차량 위에서 적을 격추하거나, 차량 내부의 적을 제압하거나, 차량 충돌로 적을 제압한 고급 플레이어 업적입니다."
              : "차량 위에서 적을 사격하거나, 차량 내부의 적을 제압하거나, 차량 충돌로 적을 제압하는 기동 전술의 시작입니다.";

            // 등급에 따른 그라데이션 및 광채 스타일 분기
            const containerStyle = isMaster
              ? "mt-6 relative overflow-hidden bg-gradient-to-r from-amber-500/5 via-orange-600/5 to-indigo-500/5 border border-white/10 rounded-[2rem] p-6 shadow-2xl transition-all duration-300 hover:border-amber-500/30"
              : "mt-6 relative overflow-hidden bg-gradient-to-r from-slate-600/5 via-slate-700/5 to-slate-800/5 border border-white/5 rounded-[2rem] p-6 shadow-xl transition-all duration-300 hover:border-slate-500/20";

            const iconBgStyle = isMaster
              ? "w-12 h-12 bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-500/20 shrink-0"
              : "w-12 h-12 bg-gradient-to-br from-slate-500 to-slate-600 rounded-2xl flex items-center justify-center shadow-md shadow-slate-500/10 shrink-0";

            const tagColorStyle = isMaster
              ? "text-[10px] font-black text-amber-400 uppercase tracking-widest bg-amber-500/10 px-2 py-0.5 rounded-full"
              : "text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-500/10 px-2 py-0.5 rounded-full";

            return (
              <div className={containerStyle}>
                {/* 백그라운드 발광 효과 */}
                {isMaster ? (
                  <>
                    <div className="absolute top-0 right-0 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
                  </>
                ) : (
                  <>
                    <div className="absolute top-0 right-0 w-48 h-48 bg-slate-500/5 rounded-full blur-3xl pointer-events-none" />
                  </>
                )}

                <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                  <div className="flex items-center gap-4">
                    <div className={iconBgStyle}>
                      <Car size={24} className="text-white" />
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className={tagColorStyle}>
                          전술 업적
                        </span>
                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                          {badgeTitle}
                        </span>
                      </div>
                      <h4 className="text-white font-black text-lg mt-1 tracking-tight">{badgeTitle}</h4>
                      <p className="text-xs text-gray-400 mt-0.5 font-medium">
                        {badgeDesc}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:flex gap-3 w-full md:w-auto">
                    {Number(leadKills || leadKnocks) > 0 && (
                      <div className="flex items-center gap-3 bg-black/40 border border-white/10 px-4 py-3 rounded-2xl flex-1 md:flex-none">
                        <div className="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-500 shrink-0">
                          <Crosshair size={16} />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] text-gray-500 font-bold uppercase">리드샷 (표적 사격)</span>
                          <span className="text-[13px] text-white font-black leading-tight mt-0.5">
                            기절 <span className="text-amber-400">{leadKnocks}</span> · 킬 <span className="text-red-400">{leadKills}</span>
                          </span>
                        </div>
                      </div>
                    )}

                    {Number(ridingKills || ridingKnocks) > 0 && (
                      <div className="flex items-center gap-3 bg-black/40 border border-white/10 px-4 py-3 rounded-2xl flex-1 md:flex-none">
                        <div className="w-8 h-8 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0">
                          <Swords size={16} />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] text-gray-500 font-bold uppercase">라이딩샷 (탑승 사격)</span>
                          <span className="text-[13px] text-white font-black leading-tight mt-0.5">
                            기절 <span className="text-indigo-400">{ridingKnocks}</span> · 킬 <span className="text-red-400">{ridingKills}</span>
                          </span>
                        </div>
                      </div>
                    )}

                    {Number(roadKills || roadKnocks) > 0 && (
                      <div className="flex items-center gap-3 bg-black/40 border border-white/10 px-4 py-3 rounded-2xl flex-1 md:flex-none">
                        <div className="w-8 h-8 rounded-xl bg-rose-500/10 flex items-center justify-center text-rose-400 shrink-0">
                          <Car size={16} />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] text-gray-500 font-bold uppercase">로드킬 (차량 충돌)</span>
                          <span className="text-[13px] text-white font-black leading-tight mt-0.5">
                            기절 <span className="text-rose-400">{roadKnocks}</span> · 킬 <span className="text-rose-400">{roadKills}</span>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* [V58.4] 무기 세부 분석 및 아군 기여도 (Weapon & Squad Armory) */}
          {((matchData.weaponStats && Object.keys(matchData.weaponStats).length > 0) ||
            (Object.keys(normalizedSquadWeaponStats).length > 0)) && (
            <CollapsibleDetailSection
              title="무기 사용 및 고정밀 교전 분석"
              eyebrow="무기 숙련도 및 아군 화력 기여"
              icon={<Flame size={16} className="text-amber-400" />}
              isOpen={openDetailSections.weapons}
              onToggle={() => toggleDetailSection("weapons")}
              summary={`${Object.keys(matchData.weaponStats || {}).length}개 무기`}
            >
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left: 나의 무기 스탯 (7/12) */}
                {matchData.weaponStats && Object.keys(matchData.weaponStats).length > 0 ? (
                  <div className="lg:col-span-7 bg-white/2 border border-white/5 rounded-[2.5rem] p-6 flex flex-col gap-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">내 무기 상세 스탯</span>
                      <span className="text-[10px] text-amber-400 font-bold bg-amber-500/10 px-2 py-0.5 rounded-full">공식 PUBG 통계 보정</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {Object.entries(matchData.weaponStats).map(([wName, wStat]) => {
                        const hasAccuracy = wStat.accuracy !== undefined;
                        // Hit Area Precision Logic
                        const hitDetails = wStat.hitDetails || [];
                        let headHits = 0, torsoHits = 0, limbHits = 0;

                        hitDetails.forEach(d => {
                          if (d.bodyPart === "HeadShot" || d.bodyPart === "Head") headHits += d.hits;
                          else if (d.bodyPart === "TorsoShot" || d.bodyPart === "PelvisShot") torsoHits += d.hits;
                          else if (d.bodyPart === "ArmShot" || d.bodyPart === "LegShot") limbHits += d.hits;
                        });

                        const totalPrecisionHits = headHits + torsoHits + limbHits;
                        const headPct = totalPrecisionHits > 0 ? (headHits / totalPrecisionHits) * 100 : 0;
                        const torsoPct = totalPrecisionHits > 0 ? (torsoHits / totalPrecisionHits) * 100 : 0;
                        const limbPct = totalPrecisionHits > 0 ? (limbHits / totalPrecisionHits) * 100 : 0;

                        return (
                          <div
                            key={wName}
                            className="bg-black/40 border border-white/10 p-5 rounded-3xl relative overflow-hidden group/wcard hover:border-amber-500/30 transition-all duration-300"
                          >
                            <div className="absolute top-0 right-0 w-24 h-24 bg-white/2 rounded-full blur-2xl group-hover/wcard:bg-amber-500/5 transition-all duration-500" />

                            <div className="flex justify-between items-start mb-3 relative z-10">
                              <div>
                                <h5 className="text-white font-black text-[15px] tracking-tight">{getTranslatedWeaponName(wName)}</h5>
                                <span className="text-[9px] text-gray-500 font-bold uppercase">
                                  {wStat.holdingTime ? `파지 ${Math.round(wStat.holdingTime)}초` : '주무기'}
                                </span>
                              </div>
                              <div className="flex flex-col items-end">
                                <span className="text-white font-black text-[14px]">
                                  {Math.round(wStat.damage)} <span className="text-[10px] text-gray-500 font-medium">딜</span>
                                </span>
                                <span className="text-[10px] text-gray-400 font-bold">
                                  기절 {wStat.dbnos} · {wStat.kills}킬
                                </span>
                              </div>
                            </div>

                            {/* 명중률 (Accuracy) 프로그레스바 */}
                            {hasAccuracy && (
                              <div className="mt-4 flex flex-col gap-1 relative z-10">
                                <div className="flex justify-between items-center text-[10px]">
                                  <span className="text-gray-400 font-bold">명중률</span>
                                  <span className="text-amber-400 font-black">
                                    {wStat.accuracy}% <span className="text-gray-500 font-medium">({wStat.hits}/{wStat.shots}발)</span>
                                  </span>
                                </div>
                                <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden border border-white/10">
                                  <div
                                    className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-1000"
                                    style={{ width: `${wStat.accuracy}%` }}
                                  />
                                </div>
                              </div>
                            )}

                            {/* 부위별 정밀 타격률 (Hit Area Precision) */}
                            {totalPrecisionHits > 0 && (
                              <div className="mt-3 pt-3 border-t border-white/5 flex flex-col gap-2 relative z-10">
                                <div className="flex justify-between items-center text-[10px]">
                                  <span className="text-gray-400 font-bold">정밀 타격률</span>
                                  <span className="text-gray-500 font-medium">{totalPrecisionHits} Hit</span>
                                </div>

                                {/* Stacked Bar */}
                                <div className="w-full h-1.5 flex rounded-full overflow-hidden border border-white/10 gap-[1px] bg-black/50">
                                  {headPct > 0 && <div className="h-full bg-red-500 transition-all duration-1000" style={{ width: `${headPct}%` }} />}
                                  {torsoPct > 0 && <div className="h-full bg-amber-500 transition-all duration-1000" style={{ width: `${torsoPct}%` }} />}
                                  {limbPct > 0 && <div className="h-full bg-white/20 transition-all duration-1000" style={{ width: `${limbPct}%` }} />}
                                </div>

                                {/* Legend & Count */}
                                <div className="flex justify-between items-center text-[9px] font-bold mt-0.5">
                                  <div className="flex items-center gap-2">
                                    {headHits > 0 && <span className="text-red-400 flex items-center gap-0.5"><span className="w-1 h-1 rounded-full bg-red-500"/> 헤드 {headHits}</span>}
                                    {torsoHits > 0 && <span className="text-amber-400 flex items-center gap-0.5"><span className="w-1 h-1 rounded-full bg-amber-500"/> 몸통 {torsoHits}</span>}
                                    {limbHits > 0 && <span className="text-gray-400 flex items-center gap-0.5"><span className="w-1 h-1 rounded-full bg-white/20"/> 팔다리 {limbHits}</span>}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="lg:col-span-7 bg-white/2 border border-white/5 rounded-[2.5rem] p-8 flex flex-col items-center justify-center text-center">
                    <Target size={32} className="text-gray-600 mb-2" />
                    <span className="text-xs text-gray-400 font-bold">본인 공식 무기 통계 기록 없음</span>
                  </div>
                )}

                {/* Right: 아군 무기 기여도 (5/12) */}
                {Object.keys(normalizedSquadWeaponStats).length > 0 ? (
                  <div className="lg:col-span-5 bg-white/2 border border-white/5 rounded-[2.5rem] p-6 flex flex-col gap-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">아군 무기 상세 스탯</span>
                      <span className="text-[10px] text-indigo-400 font-bold bg-indigo-500/10 px-2 py-0.5 rounded-full">팀원 화력 기여</span>
                    </div>

                    <div className="flex flex-col gap-4 max-h-[350px] overflow-y-auto pr-1 custom-scrollbar">
                      {Object.entries(normalizedSquadWeaponStats).map(([sName, sWeapons]) => {
                        if (!Array.isArray(sWeapons)) return null;
                        const totalSDeamage = sWeapons.reduce((sum, w) => sum + w.damage, 0);

                        return (
                          <div
                            key={sName}
                            className="bg-black/30 border border-white/5 p-4 rounded-2xl flex flex-col gap-2.5"
                          >
                            <div className="flex justify-between items-center">
                              <span className="text-white font-black text-[12px] tracking-tight truncate max-w-[150px]">
                                {sName}
                              </span>
                              <span className="text-[11px] text-indigo-400 font-black">
                                총 {Math.round(totalSDeamage)} 딜
                              </span>
                            </div>

                            <div className="flex flex-col gap-2">
                              {sWeapons.map((sw, sIdx) => (
                                <div key={sIdx} className="flex flex-col gap-1 text-[10px]">
                                  <div className="flex justify-between items-center text-gray-400">
                                    <span className="font-bold">{getTranslatedWeaponName(sw.weapon)}</span>
                                    <span className="font-black text-white/80">
                                      {Math.round(sw.damage)}딜 <span className="text-gray-500 font-medium">({sw.accuracy}%)</span>
                                    </span>
                                  </div>
                                  <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-indigo-500 rounded-full transition-all duration-1000"
                                      style={{ width: `${Math.min(100, (sw.damage / Math.max(1, totalSDeamage)) * 100)}%` }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="lg:col-span-5 bg-white/2 border border-white/5 rounded-[2.5rem] p-8 flex flex-col items-center justify-center text-center">
                    <User size={32} className="text-gray-600 mb-2" />
                    <span className="text-xs text-gray-400 font-bold">아군 화력 통계 기록 없음</span>
                  </div>
                )}
              </div>
            </CollapsibleDetailSection>
          )}

          {/* [V12.5] New Tactical Dashboard (Radar + Timeline) */}
          {!isTdmMatch && (
            <CollapsibleDetailSection
              title="전술 위치 분석 및 타임라인"
              eyebrow="전술 위치 및 매치 타임라인"
              icon={<Target size={18} className="text-indigo-400" />}
              isOpen={openDetailSections.tactical}
              onToggle={() => toggleDetailSection("tactical")}
              summary={`이벤트 ${matchData!.timeline?.filter((e: any) => e.type !== 'PHASE_START').length || 0}개`}
            >
                <div className="p-4 md:p-6 pt-0 grid grid-cols-1 lg:grid-cols-12 gap-3 md:gap-6 animate-in slide-in-from-top-2 duration-300">
                  {/* Left: Mini Map */}
                  <div data-testid="match-tactical-map" className="lg:col-span-5 xl:col-span-4 bg-white/2 border border-white/5 rounded-[2rem] overflow-hidden min-h-[300px] lg:min-h-0 lg:h-[500px] relative group/map">
                    <div className="absolute top-4 left-4 z-10 px-3 py-1 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-[9px] text-gray-400 font-black uppercase tracking-widest opacity-0 group-hover/map:opacity-100 transition-opacity">
                      인터랙티브 전술 지도
                    </div>
                    <TimelineMiniMap
                      selectedEvent={selectedEvent}
                      mapId={mapId}
                    />
                    {!selectedEvent && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] pointer-events-none z-20">
                        <div className="bg-black/80 backdrop-blur-xl px-5 py-3 rounded-2xl border border-white/10 flex flex-col items-center gap-2 shadow-2xl scale-90 md:scale-100">
                          <div className="w-10 h-10 bg-blue-500/20 rounded-full flex items-center justify-center mb-1">
                            <MousePointer2 size={20} className="text-blue-400 animate-bounce" />
                          </div>
                          <span className="text-[11px] text-white font-black tracking-tight">이벤트를 클릭하여 위치 확인</span>
                          <span className="text-[9px] text-gray-500 font-bold">지도에 교전 지점이 표시됩니다</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Right: Timeline */}
                  <div className="lg:col-span-7 xl:col-span-8 bg-white/2 border border-white/5 rounded-[2rem] p-4 md:p-6 lg:h-[500px] flex flex-col">
                    <div className="flex items-center justify-between mb-6 shrink-0">
                      <div className="text-[10px] text-gray-500 font-black uppercase tracking-widest">매치 타임라인</div>
                      <div className="flex items-center gap-1.5 px-3 py-1 bg-white/5 rounded-full border border-white/10 text-[10px] text-gray-400 font-bold">
                        <Clock size={10} />
                        <span>{Math.floor(matchData!.stats.timeSurvived / 60)}분 {matchData!.stats.timeSurvived % 60}초 생존</span>
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                      <MatchTimeline
                        events={matchData!.timeline || []}
                        nickname={nickname}
                        onEventClick={(event: any) => {
                          setSelectedEvent(event);
                        }}
                      />
                    </div>
                  </div>
                </div>
            </CollapsibleDetailSection>
          )}

          {/* AI Analysis Section */}
          {!isTdmMatch && (
            <CollapsibleDetailSection
              title="AI 전술 코칭"
              eyebrow="Tactical Analysis"
              icon={<BarChart2 size={20} className={isRanked ? 'text-amber-500' : 'text-indigo-400'} />}
              isOpen={openDetailSections.ai}
              onToggle={() => toggleDetailSection("ai")}
              summary={analysis ? "분석 완료" : coachingStyle === 'mild' ? "다정한 맛" : "매운맛"}
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-end gap-4 mb-6">
                <div className="flex items-center gap-2">
                  <div className="flex gap-2 bg-black/40 p-1 rounded-2xl border border-white/10">
                  <button
                    onClick={(e) => { e.stopPropagation(); setCoachingStyle("mild"); setAnalysis(null); }}
                    className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
                      coachingStyle === 'mild'
                        ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <BgmsIcon name="shield" size={14} /> 다정한 맛
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setCoachingStyle("spicy"); setAnalysis(null); }}
                    className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
                      coachingStyle === 'spicy'
                        ? 'bg-red-500 text-white shadow-lg shadow-red-500/20'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <BgmsIcon name="flame" size={14} /> 매운맛
                  </button>
                  </div>
                </div>
              </div>

              {analysis ? (
                <div className="flex flex-col gap-6 animate-in fade-in zoom-in duration-500">
                  {(() => {
                    try {
                      const cleanAnalysis = analysis!.trim();
                      const isJson = cleanAnalysis.startsWith('{') || cleanAnalysis.startsWith('```json');
                      if (!isJson) return (
                        <div className="p-8 bg-black/40 rounded-[2.5rem] border border-white/10 prose prose-invert max-w-none">
                          {renderMarkdown(analysis!)}
                        </div>
                      );

                      let data;
                      try {
                        const jsonString = cleanAnalysis.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
                        data = JSON.parse(jsonString);
                      } catch (err) {
                        if (isAnalyzing) {
                          return (
                            <div className="p-10 bg-black/40 rounded-[2.5rem] border border-white/10 flex flex-col items-center justify-center gap-4">
                              <div className={`w-10 h-10 border-4 border-white/10 border-t-${coachingStyle === 'mild' ? 'emerald' : 'red'}-500 rounded-full animate-spin`} />
                              <p className="text-gray-400 font-bold animate-pulse tracking-widest text-sm">AI 전술 데이터를 수신하고 있습니다...</p>
                            </div>
                          );
                        }
                        throw err;
                      }

                      const isMildTheme = coachingStyle === "mild";
                      const accentColor = isMildTheme ? "emerald" : "red";

                      return (
                        <div className="flex flex-col gap-6">
                          {/* Style Header */}
                          <div className={`relative p-8 bg-gradient-to-br from-${accentColor}-500/10 to-transparent border border-${accentColor}-500/20 rounded-[2.5rem] overflow-hidden`}>
                            <div className="absolute top-0 right-0 p-6 opacity-10">
                              <BgmsIcon name={isMildTheme ? "shield" : "flame"} size={88} />
                            </div>
                            <div className="relative z-10">
                              <div className="flex items-center gap-2 mb-4">
                                <span className={`px-3 py-1 bg-${accentColor}-500/20 text-${accentColor}-400 rounded-full text-[10px] font-black uppercase tracking-widest`}>
                                  {data.coach || (isMildTheme ? "KIND COACH" : "SPICY BOMBER")}
                                </span>
                                <div className={`h-1 w-1 rounded-full bg-${accentColor}-500`} />
                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">전술 매치 보고서</span>
                              </div>
                              <h3 className="text-3xl font-black text-white mb-2 leading-tight">{data.signature}</h3>
                              <p className="text-gray-400 text-sm font-medium">{data.signatureSub}</p>
                            </div>
                          </div>

                          {/* Analysis Content (3 Lines) */}
                          <div className="flex flex-col gap-4">
                            <div className="grid grid-cols-1 gap-3">
                              {data.briefFeedback?.map((point: string, idx: number) => (
                                <div key={idx} className="flex gap-4 p-4 bg-white/5 border border-white/10 rounded-2xl items-center group/point hover:bg-white/10 transition-colors">
                                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                                    idx === 0 ? 'bg-amber-500/20 text-amber-500' :
                                    idx === 1 ? 'bg-indigo-500/20 text-indigo-400' :
                                    'bg-emerald-500/20 text-emerald-400'
                                  }`}>
                                    <span className="text-xs font-black">{idx + 1}</span>
                                  </div>
                                  <p className="text-gray-200 text-sm font-medium leading-relaxed">
                                    {point}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Final Verdict & Action Items */}
                          <div className={`p-8 bg-black/60 border border-${accentColor}-500/30 rounded-[2.5rem] relative overflow-hidden shadow-2xl`}>
                             <div className={`absolute inset-0 bg-${accentColor}-500/5 pointer-events-none`} />
                             <div className="relative z-10">
                               <div className="flex items-center gap-2 mb-4">
                                 <span className={`text-[10px] font-black text-${accentColor}-400 uppercase tracking-[0.2em]`}>종합 코칭 진단</span>
                                 <div className="flex-1 h-px bg-white/5" />
                               </div>
                               <p className="text-xl font-black text-white leading-tight mb-8">&quot;{data.finalVerdict}&quot;</p>

                               <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                 {data.actionItems?.map((item: any, idx: number) => (
                                   <div key={idx} className="flex items-start gap-4 p-5 bg-white/5 rounded-[1.5rem] border border-white/10 hover:bg-white/10 transition-colors group/item">
                                     <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-2xl group-hover/item:scale-110 transition-transform">
                                       {item.icon}
                                     </div>
                                     <div className="flex flex-col gap-1">
                                       <span className="text-sm font-black text-white">{item.title}</span>
                                       <span className="text-xs text-gray-400 leading-normal font-medium">{item.desc}</span>
                                     </div>
                                   </div>
                                 ))}
                               </div>
                             </div>
                          </div>
                        </div>
                      );
                  } catch {
                    return (
                      <div className="p-8 bg-black/40 rounded-[2.5rem] border border-white/10 prose prose-invert max-w-none">
                        {renderMarkdown(analysis!)}
                      </div>
                    );
                  }
                })()}
              </div>
            ) : (
              <button
                type="button"
                aria-label="이 매치 정밀 분석 시작하기"
                onClick={handleAnalyze}
                disabled={isGlobalAnalyzing || isAnalyzing}
                className={`w-full py-16 ${isRanked ? 'bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20' : 'bg-indigo-500/10 border-indigo-500/20 hover:bg-indigo-500/20'} border-2 border-dashed rounded-[2.5rem] flex flex-col items-center gap-4 group transition-all relative overflow-hidden ${
                  (isGlobalAnalyzing || isAnalyzing) && !isAnalyzing ? 'opacity-50 cursor-not-allowed grayscale' : ''
                }`}
              >
                <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                {isAnalyzing ? (
                  <div className={`w-8 h-8 border-3 border-white/10 ${isRanked ? 'border-t-amber-500' : 'border-t-indigo-500'} rounded-full animate-spin`} />
                ) : isGlobalAnalyzing ? (
                  <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center">
                    <Clock size={28} className="text-gray-500" />
                  </div>
                ) : (
                  <div className={`w-14 h-14 rounded-2xl ${isRanked ? 'bg-amber-500/20' : 'bg-indigo-500/20'} flex items-center justify-center group-hover:scale-110 transition-transform`}>
                    <MousePointer2 className={isRanked ? 'text-amber-500' : 'text-indigo-400'} size={28} />
                  </div>
                )}
                <div className="flex flex-col items-center gap-1 relative z-10">
                  <span className={`${isRanked ? 'text-amber-500' : 'text-indigo-400'} font-black text-lg tracking-tight`}>
                    {isAnalyzing ? "전장 데이터를 복기하는 중..." : "이 매치 정밀 분석 시작하기"}
                  </span>
                  <span className="text-gray-500 text-xs font-medium uppercase tracking-widest">
                    {coachingStyle === 'mild' ? "KIND COACH 모드로 분석" : "SPICY BOMBER 모드로 분석"}
                  </span>
                </div>
              </button>
            )}
            </CollapsibleDetailSection>
          )}

          {/* 팀원 리스트 및 개인 교전 성적 */}
          <CollapsibleDetailSection
            title="팀원 교전 성적"
            eyebrow="Squad combat stats"
            icon={<User size={18} className="text-gray-400" />}
            isOpen={openDetailSections.team}
            onToggle={() => toggleDetailSection("team")}
            summary={`${normalizedTeamMembers.length}명`}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {normalizedTeamMembers.map((member, idx) => {
                const isMe = normalizeName(member.name) === normalizedNickname;
                return (
                  <div
                    key={idx}
                    onClick={() => !isMe && onNicknameClick?.(member.name)}
                    className={`relative p-4 rounded-3xl border transition-all group/member
                    ${isMe
                      ? (isRanked ? 'bg-amber-500/10 border-amber-500/30' : 'bg-indigo-500/10 border-indigo-500/30')
                      : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/20 cursor-pointer active:scale-95'
                    }`}>

                    {isMe && (
                      <div className={`absolute -top-2 -right-2 px-2 py-0.5 rounded-lg text-[8px] font-black uppercase tracking-tighter
                        ${isRanked ? 'bg-amber-500 text-black' : 'bg-indigo-500 text-white'}`}>
                        나
                      </div>
                    )}

                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center
                        ${isMe
                          ? (isRanked ? 'bg-amber-500/20 text-amber-500' : 'bg-indigo-500/20 text-indigo-400')
                          : 'bg-white/5 text-gray-500'
                        }`}>
                        <User size={18} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className={`text-sm font-black truncate ${isMe ? 'text-white' : 'text-gray-300'}`}>
                          {member.name}
                        </span>
                        <span className="text-[10px] text-gray-500 font-bold">Player No.{idx + 1}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-500 font-bold uppercase">Kills</span>
                        <span className="text-sm font-black text-red-400">{Number(member.kills) || 0}</span>
                      </div>
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-500 font-bold uppercase">Assists</span>
                        <span className="text-sm font-black text-indigo-400">{Number(member.assists) || 0}</span>
                      </div>
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-500 font-bold uppercase">DBNOs</span>
                        <span className="text-sm font-black text-yellow-500">{Number(member.DBNOs) || 0}</span>
                      </div>
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-500 font-bold uppercase">Damage</span>
                        <span className="text-sm font-black text-white">{Math.floor(Number(member.damageDealt) || 0)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CollapsibleDetailSection>
        </div>
      )}

      {/* ── 리플레이 분석 모드 선택 모달 ── */}
      {showReplayModal && mounted && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200"
          onClick={(e) => {
            e.stopPropagation();
            setShowReplayModal(false);
          }}
        >
          <div
            className="w-full max-w-lg bg-[#0e1116] border border-white/10 sm:rounded-[2.5rem] rounded-[2rem] sm:p-6 p-5 shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col gap-5 sm:gap-6 relative overflow-hidden max-h-[calc(100dvh-2rem)] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 배경 광채 데코 */}
            <div className="absolute -top-20 -right-20 w-48 h-48 bg-amber-500/10 rounded-full blur-[80px] pointer-events-none" />
            <div className="absolute -bottom-20 -left-20 w-48 h-48 bg-indigo-500/10 rounded-full blur-[80px] pointer-events-none" />

            {/* 헤더 */}
            <div className="flex justify-between items-start border-b border-white/5 pb-4">
              <div>
                <h3 className="text-white text-lg font-black tracking-tight">리플레이 분석 모드 선택</h3>
                <p className="text-[11px] text-gray-500 font-bold mt-1 uppercase tracking-wider font-sans">전술적 상황을 다각도로 복기할 분석 환경을 선택하세요.</p>
              </div>
              <button
                onClick={() => setShowReplayModal(false)}
                className="p-1.5 hover:bg-white/5 rounded-full text-gray-400 hover:text-white transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* 카드 선택 리스트 */}
            <div className="flex flex-col gap-3">
              {/* 1) 3D 입체 리플레이 (NEW & RECOMMENDED) */}
              <button
                type="button"
                aria-label="3D 전술 리플레이"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!is3DReplaySupported) return;
                  setShowReplayModal(false);
                  trackEvent({
                    name: "feature_consumption",
                    params: {
                      feature_name: "3d-replay",
                      status: "start"
                    }
                  });
                  router.push(`/replay/3d?matchId=${matchId}&nickname=${nickname}&platform=${platform}`);
                }}
                disabled={!is3DReplaySupported}
                title={!is3DReplaySupported ? "이 맵은 현재 3D 리플레이를 지원하지 않습니다." : isTelemetryExpired ? "90일이 경과하여 3D 동선 데이터가 만료되었습니다." : undefined}
                className="w-full text-left p-4 bg-gradient-to-r from-amber-500/10 via-amber-500/[0.03] to-transparent hover:from-amber-500/15 border border-amber-500/30 hover:border-amber-500/50 rounded-2xl transition-all flex gap-3.5 items-center cursor-pointer group hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100 disabled:hover:from-amber-500/10 disabled:hover:border-amber-500/30"
              >
                <div className="w-10 h-10 bg-amber-500/20 rounded-xl flex items-center justify-center text-amber-500 shrink-0">
                  <Video size={20} className="group-hover:scale-110 transition-transform" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-black text-sm font-sans">3D 전술 리플레이</span>
                    <span className="text-[8px] font-black tracking-wider bg-amber-500 text-black px-1.5 py-0.5 rounded-md scale-90">BETA</span>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1 leading-normal font-medium font-sans">
                    {is3DReplaySupported
                      ? "3D 홀로그램 전술 작전판에서 실시간 킬로그 피드, 총탄 궤적, 입체 고도 및 카메라 추적으로 정밀 분석합니다."
                      : isTelemetryExpired ? "90일이 경과하여 3D 동선 데이터가 만료되었습니다. 기본 전적 요약 통계는 정상 조회 가능합니다." : "이 맵은 3D 지형 자산 준비 전입니다. 2D 미니 리플레이를 이용해 주세요."}
                  </p>
                </div>
              </button>

              {/* 2) 2D 미니 리플레이 */}
              <button
                type="button"
                aria-label="2D 맵 리플레이"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowReplayModal(false);
                  handleInternalReplay(e);
                }}
                className="w-full text-left p-4 bg-white/3 hover:bg-white/5 border border-white/5 hover:border-white/10 rounded-2xl transition-all flex gap-3.5 items-center cursor-pointer group hover:scale-[1.01]"
              >
                <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center text-indigo-400 shrink-0">
                  <MapIcon size={20} className="group-hover:scale-110 transition-transform" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-white font-black text-sm font-sans">2D 맵 리플레이 (간이)</span>
                  <p className="text-[10px] text-gray-400 mt-1 leading-normal font-medium font-sans">
                    지도가 아래로 확장되며 타임라인을 통해 가볍고 빠르게 이동 경로와 안전구역 수축을 요약 복기합니다.
                  </p>
                </div>
              </button>

              {/* 3) 고정밀 리플레이 (원본) */}
              <button
                type="button"
                aria-label="고정밀 리플레이"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowReplayModal(false);
                  trackEvent({
                    name: "feature_consumption",
                    params: {
                      feature_name: "2d-replay",
                      status: "start"
                    }
                  });
                  router.push(`/maps/${mapId}?playback=${matchId}&nickname=${nickname}&platform=${encodeURIComponent(platform)}&mode=full`);
                }}
                className="w-full text-left p-4 bg-white/3 hover:bg-white/5 border border-white/5 hover:border-white/10 rounded-2xl transition-all flex gap-3.5 items-center cursor-pointer group hover:scale-[1.01]"
              >
                <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-400 shrink-0">
                  <PlayCircle size={20} className="group-hover:scale-110 transition-transform" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-white font-black text-sm font-sans">고정밀 리플레이 (원본 데이터)</span>
                  <p className="text-[10px] text-gray-400 mt-1 leading-normal font-medium font-sans">
                    전체 맵 스케일에서 모든 플레이어들의 원본 동선 데이터와 세부 교전 상황을 풀스크린으로 세밀하게 관전합니다.
                  </p>
                </div>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const StatBox = ({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: string | number, color: string }) => (
  <div className="bg-black/40 p-4 rounded-2xl border border-white/5 flex flex-col items-center gap-1 group hover:border-white/10 transition-colors">
    <div className={`${color} mb-1 opacity-70 group-hover:scale-110 transition-transform`}>{icon}</div>
    <span className="text-[10px] text-gray-500 font-black uppercase tracking-tighter">{label}</span>
    <span className="text-lg font-black text-white">{value}</span>
  </div>
);
