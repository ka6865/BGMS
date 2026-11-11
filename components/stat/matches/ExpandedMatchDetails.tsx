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
  Flame,
  MousePointer2,
  Clock,
  Swords,
  Trophy,
  User,
  PlayCircle,
  X,
  Car,
  Video,
  Map as MapIcon,
  Activity,
  ListTree
} from "lucide-react";
import { useRouter } from "next/navigation";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { MatchTimeline } from "@/components/stat/MatchTimeline";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { MatchData, MatchTeamMember } from "@/types/stat";
import { getObservedBasicMatchStat, type MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { getWeaponDisplayName } from "@/lib/pubg-analysis/constants";
export { MatchPerformancePanel } from "./MatchPerformancePanel";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { BOT_SHARE_LEVEL_LABELS, buildBotShare } from "@/lib/pubg-analysis/botShare";
import { hasMatchFlow, hasMatchOverview, humanTeamPlace } from "@/lib/pubg-analysis/matchReportView";
import { MatchFlowContent, MatchOverviewContent, MatchPlayerRankingContent, playerRankSummary } from "./MatchReportSections";
import { normalizeSquadWeaponStats } from "@/lib/pubg-analysis/squadWeaponStats";
import { useAIStatus, aiManager } from "@/lib/ai-management";
import { useAuth } from "@/components/AuthProvider";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics";
import { get2DReplayUnsupportedMessage, resolve2DReplayMapId, resolve3DMapCapability } from "@/lib/replay/mapCapabilities";
import { isCanonicalMatchId } from "@/lib/pubg-analysis/telemetryIdentity";
import type { StatsPlatform } from "@/types/stats-page";
import {
  getMatchDetailRetention,
  MATCH_DETAIL_EXPIRED_CODE,
  MATCH_DETAIL_UNAVAILABLE_CODE,
  MATCH_DETAIL_EXPIRED_MESSAGE,
} from "@/lib/pubg-analysis/matchRetention";
import { MatchDetailExpiredNotice } from "./MatchDetailExpiredNotice";
import { MatchVerdictBlock } from "./MatchVerdictBlock";
import { MatchAiCoachingCard } from "./MatchAiCoachingCard";
import type { MatchAiScene } from "@/lib/pubg-analysis/matchAiScenes";

const TimelineMiniMap = dynamic(
  () => import("@/components/stat/TimelineMiniMap").then((mod) => mod.TimelineMiniMap),
  { ssr: false, loading: () => <div className="w-full h-full bg-white/5 animate-pulse rounded-[2.5rem]" /> }
);

const CollapsibleDetailSection = ({
  title,
  icon,
  isOpen,
  onToggle,
  summary,
  children
}: {
  title: string;
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
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {summary && (
          <div className="hidden max-w-[12rem] truncate text-right text-[10px] font-black text-white/50 sm:block">
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

export interface ExpandedMatchDetailsProps {
  matchId: string;
  nickname: string;
  platform: StatsPlatform;
  summary?: MatchSummaryData;
  onNicknameClick?: (nickname: string) => void;
  onModeDetected?: (matchId: string, gameMode: string, matchType?: string, mapName?: string) => void;
  onDetailReady?: (data: MatchData) => void;
  onFailure?: (reason: "detail_failed" | "analysis_failed") => void;
  onRecovery?: (reason: "detail_failed" | "analysis_failed") => void;
}

type MatchDetailState =
  | { status: "summary" }
  | { status: "loading" }
  | { status: "expired"; expiresAt: string | null }
  | { status: "ready"; data: MatchData }
  | { status: "error"; message: string; kind: MatchDetailErrorKind };

type MatchDetailErrorKind = "expired" | "unavailable" | "upgrade_pending" | "retryable" | "generic";

type AiAnalysisErrorDetails = {
  status?: number;
  errorCode?: string;
  retryable?: boolean;
};

class AiAnalysisRequestError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly retryable: boolean;

  constructor(message: string, details: AiAnalysisErrorDetails = {}) {
    super(message);
    this.name = "AiAnalysisRequestError";
    this.status = details.status ?? 0;
    this.errorCode = details.errorCode ?? null;
    this.retryable = details.retryable === true;
  }
}

class MatchDetailRequestError extends Error {
  readonly kind: MatchDetailErrorKind;

  constructor(message: string, kind: MatchDetailErrorKind) {
    super(message);
    this.name = "MatchDetailRequestError";
    this.kind = kind;
  }
}

const MATCH_NOT_FOUND_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const unavailableMatchCache = new Map<string, number>();

const MATCH_NOT_FOUND_MESSAGE = "PUBG에서 해당 매치 데이터를 더 이상 제공하지 않습니다. 저장된 기본 전적은 계속 확인할 수 있습니다.";
const MATCH_PARTICIPANT_NOT_FOUND_MESSAGE = "해당 매치에서 플레이어 정보를 찾을 수 없습니다. 저장된 기본 전적은 확인할 수 있습니다.";
const MATCH_CACHE_UNAVAILABLE_MESSAGE = "상세 분석 저장소가 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.";
const MATCH_RATE_LIMITED_MESSAGE = "PUBG API 호출 한도가 일시적으로 초과되었습니다. 잠시 후 다시 시도해 주세요.";
const MATCH_TIMEOUT_MESSAGE = "상세 분석 요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
const MATCH_CALCULATION_UPGRADE_MESSAGE = "새 계산 기준 확인이 필요한 전적입니다";
const MATCH_CALCULATION_UPGRADE_DETAIL = "기본 전적은 계속 확인할 수 있습니다. 이 화면에서는 원본 보관 여부나 갱신 진행 상태를 확인할 수 없습니다.";
const AI_ANALYSIS_CLIENT_SAFETY_TIMEOUT_MS = 45_000;

function classifyAiAnalysisError(
  status: number,
  errorCode?: string,
  retryable?: boolean,
  message?: string,
): AiAnalysisRequestError {
  const isCalculationUpgradePending = status === 409 && errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED";
  const isCanonicalNotReady = status === 409 && errorCode === "PUBG_AI_CANONICAL_NOT_READY";
  const isRouteTimeout = status === 504 && errorCode === "PUBG_AI_ROUTE_TIMEOUT";
  const isRetryable = !isCalculationUpgradePending && (retryable === true || isCanonicalNotReady || isRouteTimeout);
  return new AiAnalysisRequestError(
    isCalculationUpgradePending
      ? MATCH_CALCULATION_UPGRADE_MESSAGE
      : message || (isCanonicalNotReady
        ? "매치 분석 데이터가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요."
        : isRouteTimeout
          ? "AI 분석 요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요."
          : "AI 분석 요청에 실패했습니다."),
    { status, errorCode, retryable: isRetryable },
  );
}

function detailCacheKey(platform: StatsPlatform, nickname: string, matchId: string): string {
  return `${platform}:${normalizeName(nickname)}:${matchId}`;
}

function hasRecentlyUnavailableMatch(key: string): boolean {
  const expiresAt = unavailableMatchCache.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    unavailableMatchCache.delete(key);
    return false;
  }
  return true;
}

function rememberUnavailableMatch(key: string): void {
  unavailableMatchCache.set(key, Date.now() + MATCH_NOT_FOUND_CACHE_TTL_MS);
}

function classifyMatchDetailError(
  status: number,
  errorCode?: string,
  serverMessage?: string,
): MatchDetailRequestError {
  if (errorCode === MATCH_DETAIL_EXPIRED_CODE) {
    return new MatchDetailRequestError(serverMessage || MATCH_DETAIL_EXPIRED_MESSAGE, "expired");
  }
  if (errorCode === MATCH_DETAIL_UNAVAILABLE_CODE) {
    return new MatchDetailRequestError(serverMessage || "상세 분석 자료가 저장되어 있지 않습니다. 기본 전적은 계속 확인할 수 있습니다.", "unavailable");
  }
  if (errorCode === "PUBG_MATCH_PARTICIPANT_NOT_FOUND") {
    return new MatchDetailRequestError(serverMessage || MATCH_PARTICIPANT_NOT_FOUND_MESSAGE, "unavailable");
  }
  if (errorCode === "PUBG_MATCH_NOT_FOUND" || status === 404) {
    return new MatchDetailRequestError(serverMessage || MATCH_NOT_FOUND_MESSAGE, "unavailable");
  }
  if (errorCode === "PUBG_RATE_LIMITED" || status === 429) {
    return new MatchDetailRequestError(serverMessage || MATCH_RATE_LIMITED_MESSAGE, "retryable");
  }
  if (errorCode === "PUBG_MATCH_TIMEOUT" || status === 504) {
    return new MatchDetailRequestError(serverMessage || MATCH_TIMEOUT_MESSAGE, "retryable");
  }
  if (errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED") {
    return new MatchDetailRequestError(MATCH_CALCULATION_UPGRADE_MESSAGE, "upgrade_pending");
  }
  if (errorCode === "PUBG_MATCH_ANALYSIS_IN_PROGRESS" || status === 409) {
    return new MatchDetailRequestError(
      serverMessage || "다른 요청에서 상세 분석을 진행 중입니다. 잠시 후 다시 시도해 주세요.",
      "retryable",
    );
  }
  if (status === 503 || errorCode?.startsWith("PUBG_MATCH_ANALYSIS_")) {
    return new MatchDetailRequestError(MATCH_CACHE_UNAVAILABLE_MESSAGE, "retryable");
  }
  return new MatchDetailRequestError("상세 정보를 불러오지 못했습니다", "generic");
}

function matchOwnerIdentity(platform: StatsPlatform, nickname: string, matchId: string) {
  return `${platform}:${normalizeName(nickname)}:${matchId}`;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

const displayStat = (value: unknown, format: (value: number) => string | number = String) =>
  typeof value === "number" && Number.isFinite(value) ? format(value) : "—";

// 중복 팀원의 일부 기록이 없으면 합계도 미관측으로 남긴다.
const sumObservedStat = (left: number, right: number) =>
  Number.isFinite(left) && Number.isFinite(right) ? left + right : NaN;

function getMatchStatusBorder(summary?: MatchSummaryData | MatchData | null): string {
  if (!summary) return "border-l-white/20";
  const mode = (summary.gameMode || "").toLowerCase();
  const mapName = summary.mapName || "";
  const isTdm = mode.includes("tdm") || mapName.toLowerCase().includes("tdm") || mapName === "PillarCompound_Main" || mapName === "Italy_TDM_Main";
  const winPlace = summary.stats?.winPlace ?? 99;
  const kills = summary.stats?.kills ?? 0;
  const damageDealt = summary.stats?.damageDealt ?? 0;

  if (isTdm) {
    return winPlace === 1 ? "border-l-rose-400" : "border-l-red-400";
  }
  if (winPlace === 1) return "border-l-amber-400";
  if (winPlace <= 10) return "border-l-blue-400";
  if (kills === 0 && damageDealt < 100) return "border-l-red-400";
  return "border-l-white/20";
}


export const ExpandedMatchDetails = ({
  matchId,
  nickname,
  platform,
  summary: initialMatchData,
  onNicknameClick,
  onModeDetected,
  onDetailReady,
  onFailure,
  onRecovery,
}: ExpandedMatchDetailsProps) => {
  const ownerIdentity = matchOwnerIdentity(platform, nickname, matchId);
  const [matchData, setMatchData] = useState<MatchSummaryData | null>(initialMatchData || null);
  const [loading, setLoading] = useState(false);
  const [detailState, setDetailState] = useState<MatchDetailState>({ status: "summary" });
  const [openDetailSections, setOpenDetailSections] = useState({
    weapons: false,
    ai: false,
    ranking: false,
    team: false,
    flow: false
  });
  const [showFlowMap, setShowFlowMap] = useState(false);
  const [showReplayModal, setShowReplayModal] = useState(false);
  const [mounted, setMounted] = useState(false);

  const matchDate = (initialMatchData as any)?.playedAt || initialMatchData?.createdAt || initialMatchData?.matchInfo?.date
    || (matchData as any)?.playedAt || matchData?.createdAt || matchData?.matchInfo?.date || "";
  const matchRetention = getMatchDetailRetention(matchDate);

  useEffect(() => {
    if (matchRetention.status !== "available" || !matchRetention.expiresAt) return;
    const delay = Date.parse(matchRetention.expiresAt) - Date.now();
    if (delay <= 0) {
      setDetailState({ status: "expired", expiresAt: matchRetention.expiresAt });
      return;
    }
    const timer = window.setTimeout(() => {
      setDetailState({ status: "expired", expiresAt: matchRetention.expiresAt });
    }, Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [matchRetention.expiresAt, matchRetention.status]);

  useEffect(() => {
    setMounted(true);
  }, []);
  const [coachingStyle, setCoachingStyle] = useState<"mild" | "spicy">("spicy");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<AiAnalysisRequestError | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null);
  const [sceneFocusRequest, setSceneFocusRequest] = useState(0);
  const flowMapRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isAnalyzingRef = useRef(false); // [V46.0] 클로저 세이프 로딩 추적
  const detailRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const detailRequestIdRef = useRef(0);
  const aiGenerationRef = useRef(0);
  const callbacksRef = useRef({ onModeDetected, onDetailReady, onFailure, onRecovery });
  useEffect(() => {
    callbacksRef.current = { onModeDetected, onDetailReady, onFailure, onRecovery };
  }, [onDetailReady, onFailure, onModeDetected, onRecovery]);
  const { isAnalyzing: isGlobalAnalyzing } = useAIStatus();
  const { user } = useAuth();
  const router = useRouter();

  const statusBorder = getMatchStatusBorder(matchData || initialMatchData);

  const leadKills = matchData ? (matchData.stats?.leadShotKills ?? matchData.leadShotKills ?? 0) : 0;
  const leadKnocks = matchData ? (matchData.stats?.leadShotKnocks ?? matchData.leadShotKnocks ?? 0) : 0;
  const ridingKills = matchData ? (matchData.stats?.ridingShotKills ?? matchData.ridingShotKills ?? 0) : 0;
  const ridingKnocks = matchData ? (matchData.stats?.ridingShotKnocks ?? matchData.ridingShotKnocks ?? 0) : 0;
  const roadKills = matchData ? (matchData.stats?.roadKills ?? matchData.roadKills ?? 0) : 0;
  const roadKnocks = matchData ? (matchData.stats?.roadKnocks ?? matchData.roadKnocks ?? 0) : 0;
  const vehicleCombatTotal = leadKills + leadKnocks + ridingKills + ridingKnocks + roadKills + roadKnocks;
  const hasVehicleCombat = vehicleCombatTotal > 0;
  const botShare = matchData ? buildBotShare(matchData.totalPlayers, matchData.botCount) : null;
  const matchReport = matchData?.matchReport ?? null;
  const humanPlace = matchReport ? humanTeamPlace(matchReport) : null;
  const rankSummary = useMemo(() => (matchReport ? playerRankSummary(matchReport, nickname) : null), [matchReport, nickname]);
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
        kills: sumObservedStat(existing.kills, member.kills),
        assists: sumObservedStat(existing.assists, member.assists),
        damageDealt: sumObservedStat(existing.damageDealt, member.damageDealt),
        DBNOs: sumObservedStat(existing.DBNOs, member.DBNOs),
        revives: (existing.revives || 0) + (member.revives || 0),
        deaths: (existing.deaths || 0) + (member.deaths || 0),
        deathType: existing.deathType || member.deathType
      });
    });
    return Array.from(memberMap.values());
  }, [matchData]);
  const normalizedSquadWeaponStats = useMemo(
    () => normalizeSquadWeaponStats(matchData?.squadWeaponStats),
    [matchData?.squadWeaponStats],
  );
  // AI 코칭의 장면 칩: 경기 흐름과 미니맵을 열고 해당 이벤트를 선택한 뒤 지도로 스크롤한다.
  const handleAiSceneSelect = (scene: MatchAiScene) => {
    setOpenDetailSections((current) => ({ ...current, flow: true }));
    setShowFlowMap(true);
    setSelectedEvent(scene.event);
    setSceneFocusRequest((current) => current + 1);
  };
  useEffect(() => {
    if (sceneFocusRequest === 0) return;
    flowMapRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [sceneFocusRequest]);
  const toggleDetailSection = (section: keyof typeof openDetailSections) => {
    setOpenDetailSections((current) => ({
      ...current,
      [section]: !current[section]
    }));
  };

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

  // 리플레이 모달 오픈 시 배경 스크롤 방지
  useEffect(() => {
    if (!showReplayModal) return;

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
  }, [showReplayModal]);

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
      "Chimera_Main": "Paramo",
      "Heaven_Main": "Haven"
    };
    const mapped = mapping[name];
    if (mapped) return mapped;

    // 폴백 로직: 첫 글자 대문자화 (예: erangel -> Erangel)
    const fallback = name.toLowerCase().replace(/_main/i, "");
    return fallback.charAt(0).toUpperCase() + fallback.slice(1);
  };

  const mapId = getMapId(matchData?.mapName || "");
  // /maps/[mapId]가 열 수 있는 지도만 2D 리플레이로 이동한다(지원 밖 맵은 404).
  const replayMapId = resolve2DReplayMapId(matchData?.mapName || "");

  const handleInternalReplay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!replayMapId || getMatchDetailRetention(matchDate).status !== "available") return;
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "2d-replay",
        status: "start"
      }
    });
    const query = new URLSearchParams({ playback: matchId, nickname, platform, playedAt: matchDate });
    router.push(`/maps/${replayMapId}?${query.toString()}`);
  };

  // 경기 흐름의 교전 줄에서 그 교전 직전부터 2D 리플레이를 연다.
  const openReplayAt = (seconds: number) => {
    if (!replayMapId || getMatchDetailRetention(matchDate).status !== "available") return;
    trackEvent({ name: "feature_consumption", params: { feature_name: "2d-replay", status: "start" } });
    const query = new URLSearchParams({ playback: matchId, nickname, platform, playedAt: matchDate, t: String(seconds) });
    router.push(`/maps/${replayMapId}?${query.toString()}`);
  };


  const fetchFullMatch = useCallback(async () => {
    if (detailRequestRef.current) return;
    const retention = getMatchDetailRetention(
      (initialMatchData as any)?.playedAt || initialMatchData?.createdAt || initialMatchData?.matchInfo?.date || matchDate,
    );
    if (retention.status === "expired") {
      setDetailState({ status: "expired", expiresAt: retention.expiresAt });
      return;
    }
    if (!isCanonicalMatchId(matchId)) {
      setDetailState({ status: "error", message: "상세 정보를 불러오지 못했습니다", kind: "generic" });
      callbacksRef.current.onFailure?.("detail_failed");
      return;
    }
    const unavailableKey = detailCacheKey(platform, nickname, matchId);
    if (hasRecentlyUnavailableMatch(unavailableKey)) {
      setDetailState({ status: "error", message: MATCH_NOT_FOUND_MESSAGE, kind: "unavailable" });
      callbacksRef.current.onRecovery?.("detail_failed");
      return;
    }
    const controller = new AbortController();
    const requestId = ++detailRequestIdRef.current;
    detailRequestRef.current = { id: requestId, controller };
    setLoading(true);
    setDetailState({ status: "loading" });
    const stale = () => requestId !== detailRequestIdRef.current
      || detailRequestRef.current?.controller !== controller
      || controller.signal.aborted;
    try {
      const query = new URLSearchParams({ matchId, nickname, platform });
      const res = await fetch(`/api/pubg/match?${query.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json() as MatchData & { error?: string; errorCode?: string };
      if (stale()) return;
      if (!res.ok || data.error) {
        const detailError = classifyMatchDetailError(res.status, data.errorCode, data.error);
        if (detailError.kind === "expired") {
          setDetailState({ status: "expired", expiresAt: (data as { expiresAt?: string | null }).expiresAt || matchRetention.expiresAt });
          callbacksRef.current.onRecovery?.("detail_failed");
          return;
        }
        if (detailError.kind === "unavailable" && data.errorCode === "PUBG_MATCH_NOT_FOUND") {
          rememberUnavailableMatch(unavailableKey);
        }
        throw detailError;
      }

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
      callbacksRef.current.onDetailReady?.(data);
      setDetailState({ status: "ready", data });
      callbacksRef.current.onRecovery?.("detail_failed");
    } catch (caught) {
      if (stale() || isAbortError(caught)) return;
      const detailError = caught instanceof MatchDetailRequestError
        ? caught
        : new MatchDetailRequestError("상세 정보를 불러오지 못했습니다", "generic");
      setDetailState({ status: "error", message: detailError.message, kind: detailError.kind });
      if (detailError.kind === "unavailable" || detailError.kind === "upgrade_pending") callbacksRef.current.onRecovery?.("detail_failed");
      else callbacksRef.current.onFailure?.("detail_failed");
    } finally {
      if (!stale()) {
        detailRequestRef.current = null;
        setLoading(false);
      }
    }
  }, [initialMatchData, matchDate, matchRetention.expiresAt, matchId, nickname, platform]);

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
    if (detailState.status === "summary") {
      void fetchFullMatch();
    }
  }, [detailState.status, fetchFullMatch]);

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
    setAnalysisError(null);

    const generation = ++aiGenerationRef.current;
    let activeAbortController: AbortController | null = null;

    // GA4 이벤트 트래킹: AI 코칭 시작
    trackEvent({
      name: "feature_consumption",
      params: {
        feature_name: "ai-coaching",
        status: "start"
      }
    });

    const isCurrentOwner = () => generation === aiGenerationRef.current;
    const parseStreamResponse = async (res: Response, attemptSignal: AbortSignal): Promise<string> => {
      const reader = res.body?.getReader();
      if (!reader) {
        throw new AiAnalysisRequestError("AI 분석 응답이 비어 있습니다.", {
          status: res.status,
          errorCode: "PUBG_AI_STREAM_EMPTY",
          retryable: true,
        });
      }

      const decoder = new TextDecoder();
      let lineBuffer = "";
      let accumulatedAnalysis = "";
      let sawChunk = false;
      let sawDone = false;
      let malformedLine = false;
      let trailingEventAfterDone = false;
      let terminalDone = false;
      let streamedFailure: {
        error?: string;
        errorCode?: string;
        retryable?: boolean;
        valid?: boolean;
      } | null = null;

      const processLine = (line: string) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        let parsed: {
          type?: string;
          data?: unknown;
          valid?: boolean;
          error?: string;
          errorCode?: string;
          retryable?: boolean;
        };
        try {
          parsed = JSON.parse(trimmedLine);
        } catch {
          malformedLine = true;
          return;
        }

        if (terminalDone) {
          trailingEventAfterDone = true;
          if (parsed.type === "error" || (parsed.type === "done" && (parsed.valid === false || parsed.error || parsed.errorCode))) {
            streamedFailure = {
              ...(streamedFailure ?? {}),
              ...parsed,
            };
          }
          return;
        }

        if (parsed.type === "chunk") {
          if (typeof parsed.data !== "string") {
            malformedLine = true;
            return;
          }
          accumulatedAnalysis += parsed.data;
          if (parsed.data.trim()) sawChunk = true;
          if (isCurrentOwner() && !attemptSignal.aborted) setAnalysis(accumulatedAnalysis);
          return;
        }

        if (parsed.type === "error") {
          streamedFailure = parsed;
          return;
        }

        if (parsed.type === "done") {
          sawDone = true;
          terminalDone = true;
          if (parsed.valid === false || parsed.error || parsed.errorCode) {
            streamedFailure = {
              ...(streamedFailure ?? {}),
              ...parsed,
            };
          }
        }
      };

      try {
        while (true) {
          if (!isCurrentOwner() || attemptSignal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";
          lines.forEach(processLine);
        }

        lineBuffer += decoder.decode();
        if (lineBuffer.trim()) processLine(lineBuffer);
      } catch (streamError) {
        if (isAbortError(streamError)) throw streamError;
        throw new AiAnalysisRequestError("AI 분석 스트림이 중단되었습니다.", {
          status: res.status || 200,
          errorCode: "PUBG_AI_STREAM_READ_FAILED",
          retryable: true,
        });
      } finally {
        reader.releaseLock();
      }

      const parsedStreamFailure = streamedFailure as {
        error?: string;
        errorCode?: string;
        retryable?: boolean;
        valid?: boolean;
      } | null;
      if (parsedStreamFailure) {
        const status = parsedStreamFailure.errorCode === "PUBG_AI_CANONICAL_NOT_READY"
          || parsedStreamFailure.errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED"
          ? 409
          : parsedStreamFailure.errorCode === "PUBG_AI_ROUTE_TIMEOUT" ? 504 : res.status || 200;
        throw classifyAiAnalysisError(
          status,
          parsedStreamFailure.errorCode,
          parsedStreamFailure.retryable === true,
          parsedStreamFailure.error,
        );
      }

      if (!sawDone || trailingEventAfterDone || !sawChunk || !accumulatedAnalysis.trim()) {
        throw new AiAnalysisRequestError(
          malformedLine
            ? "AI 분석 응답을 완전히 읽지 못했습니다."
            : "AI 분석 응답이 완전하지 않습니다.",
          {
            status: res.status || 200,
            errorCode: "PUBG_AI_STREAM_INCOMPLETE",
            retryable: true,
          },
        );
      }

      return accumulatedAnalysis;
    };

    try {
      while (true) {
        if (!isCurrentOwner()) return;

        const abortController = new AbortController();
        activeAbortController = abortController;
        abortControllerRef.current = abortController;
        let safetyTimedOut = false;
        const safetyTimeout = setTimeout(() => {
          if (isCurrentOwner() && abortControllerRef.current === abortController && isAnalyzingRef.current) {
            safetyTimedOut = true;
            abortController.abort();
          }
        }, AI_ANALYSIS_CLIENT_SAFETY_TIMEOUT_MS);

        try {
          const res = await fetch("/api/pubg/ai-analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortController.signal,
            body: JSON.stringify({ matchData, nickname, platform, coachingStyle })
          });

          if (!isCurrentOwner()) return;
          if (abortController.signal.aborted) {
            if (safetyTimedOut) {
              throw classifyAiAnalysisError(504, "PUBG_AI_ROUTE_TIMEOUT", true, "AI 분석 요청 시간이 초과되었습니다.");
            }
            return;
          }
          if (!res.ok) {
            let errorData: {
              error?: unknown;
              errorCode?: unknown;
              retryable?: unknown;
            } = {};
            try {
              const parsed = await res.json();
              if (parsed && typeof parsed === "object") errorData = parsed;
            } catch {
              // The status itself is still preserved when the body is not JSON.
            }
            throw classifyAiAnalysisError(
              res.status,
              typeof errorData.errorCode === "string" ? errorData.errorCode : undefined,
              errorData.retryable === true,
              typeof errorData.error === "string" ? errorData.error : undefined,
            );
          }

          const responseText = await parseStreamResponse(res, abortController.signal);
          if (!isCurrentOwner()) return;
          if (abortController.signal.aborted) {
            if (safetyTimedOut) {
              throw classifyAiAnalysisError(504, "PUBG_AI_ROUTE_TIMEOUT", true, "AI 분석 요청 시간이 초과되었습니다.");
            }
            return;
          }

          setAnalysis(responseText);
          setAnalysisError(null);
          trackEvent({
            name: "feature_consumption",
            params: {
              feature_name: "ai-coaching",
              status: "success"
            }
          });
          callbacksRef.current.onRecovery?.("analysis_failed");
          return;
        } catch (caught) {
          if (!isCurrentOwner()) return;
          if (abortController.signal.aborted && !safetyTimedOut) return;

          const error = caught instanceof AiAnalysisRequestError
            ? caught
            : safetyTimedOut
              ? classifyAiAnalysisError(504, "PUBG_AI_ROUTE_TIMEOUT", true, "AI 분석 요청 시간이 초과되었습니다.")
              : new AiAnalysisRequestError("AI 분석 요청 중 네트워크 오류가 발생했습니다.", {
                errorCode: "PUBG_AI_NETWORK_ERROR",
                retryable: true,
              });

          setAnalysis("");
          setAnalysisError(error);
          trackEvent({
            name: "feature_consumption",
            params: {
              feature_name: "ai-coaching",
              status: "fail",
              error_type: error.errorCode || error.message || "unknown"
            }
          });
          callbacksRef.current.onFailure?.("analysis_failed");
          return;
        } finally {
          clearTimeout(safetyTimeout);
        }
      }
    } finally {
      if (generation === aiGenerationRef.current) {
        setIsAnalyzing(false);
        isAnalyzingRef.current = false;
        aiManager.stopAnalysis(ownerIdentity);
        if (abortControllerRef.current === activeAbortController) abortControllerRef.current = null;
      }
    }
  };

  const isCalculationUpgradePending = analysisError?.errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED";

  if (detailState.status === "expired" || matchRetention.status === "expired") {
    return <MatchDetailExpiredNotice summary={initialMatchData || matchData} expiresAt={detailState.status === "expired" ? detailState.expiresAt : matchRetention.expiresAt} />;
  }

  if (detailState.status === "error") {
    const isUnavailable = detailState.kind === "unavailable";
    const isUpgradePending = detailState.kind === "upgrade_pending";
    return (
      <div className={`rounded-b-2xl border border-t-0 border-l-4 ${statusBorder} p-4 ${isUnavailable || isUpgradePending ? "border-sky-500/20 bg-sky-500/10" : "border-red-500/20 bg-red-500/10"}`} role="alert">
        <p className={`text-sm font-black ${isUnavailable || isUpgradePending ? "text-sky-200" : "text-red-200"}`}>{detailState.message}</p>
        <p className="mt-1 text-xs text-white/55">{isUpgradePending ? MATCH_CALCULATION_UPGRADE_DETAIL : "접힌 매치 요약은 그대로 유지됩니다."}</p>
        {!isUnavailable && !isUpgradePending && (
          <button
            type="button"
            onClick={() => void fetchFullMatch()}
            className="mt-3 min-h-11 rounded-lg border border-red-400/20 px-3 text-xs font-black text-red-100"
          >
            상세 다시 시도
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-label="매치 상세 불러오는 중"
        className={`flex min-h-24 items-center justify-center gap-3 rounded-b-2xl border border-t-0 border-white/10 border-l-4 ${statusBorder} bg-[#141414] px-4 text-sm font-semibold text-white/60`}
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-indigo-400"
        />
        <span>매치 상세를 불러오는 중</span>
      </div>
    );
  }

  if (!matchData) {
    // initialMatchData 없이 렌더된 카드: 자동으로 PUBG API에서 기본 스탯 로드
    return (
      <div
        className={`flex min-h-24 items-center justify-between gap-3 rounded-b-2xl border border-t-0 border-white/10 border-l-4 ${statusBorder} bg-[#141414] px-4 py-3 cursor-pointer hover:bg-white/[0.07] transition-colors`}
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

  if (matchData.analysisAvailability === "basic_only") {
    const value = (input: unknown, unit = "") => typeof input === "number" && Number.isFinite(input)
      ? `${Math.round(input * 10) / 10}${unit}` : "기록 없음";
    return (
      <div data-testid="match-basic-only" className={`rounded-b-2xl border border-t-0 border-white/10 border-l-4 ${statusBorder} bg-[#141414] p-4`}>
        <p className="text-sm font-bold text-white">기본 경기 기록</p>
        <p className="mt-2 text-xs leading-relaxed text-white/60">전술 지표를 새 기준으로 다시 계산해야 하는 경기입니다. 킬·피해량·순위는 확인할 수 있으며, 전술 평가와 AI 코칭은 재계산 후 제공됩니다.</p>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ["순위", value(matchData.stats.winPlace, "위")],
            ["킬", value(matchData.stats.kills)],
            ["피해량", value(matchData.stats.damageDealt)],
            ["어시스트", value(matchData.stats.assists)],
            ["기절시킴", value(matchData.stats.DBNOs)],
            ["헤드샷", value(matchData.stats.headshotKills)],
          ].map(([label, record]) => <div key={label}><dt className="text-xs text-white/50">{label}</dt><dd className="mt-1 text-lg font-bold text-white">{record}</dd></div>)}
        </dl>
        <button type="button" onClick={handleInternalReplay} disabled={!replayMapId} title={!replayMapId ? get2DReplayUnsupportedMessage(matchData.mapName || "") : undefined} className="mt-4 min-h-11 rounded-lg border border-white/20 px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-45">2D 리플레이 열기</button>
        <Link className="inline-flex min-h-11 items-center rounded-xl border border-white/10 px-4 text-xs font-bold text-white/70" href={`/stats/${platform}/${encodeURIComponent(nickname)}/encounters?matchId=${encodeURIComponent(matchId)}`}>이 경기 상대 보기</Link>
      </div>
    );
  }

  const is3DReplaySupported = resolve3DMapCapability(matchData.mapName || "") !== null;



  // TDM 판정 규칙
  const isTdmMatch = (matchData.gameMode || "").toLowerCase().includes("tdm") ||
                     (matchData.mapName || "").toLowerCase().includes("tdm") ||
                     (matchData.mapName || "") === "PillarCompound_Main" ||
                     (matchData.mapName || "") === "Italy_TDM_Main";

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
  const isWin = matchData.stats.winPlace === 1;
  const isBasicSummary = matchData.summarySource === "pubg_player_matches" && matchData.isSummary !== false;

  return (
    <div className={`relative overflow-hidden rounded-b-2xl border border-t-0 border-l-4 ${statusBorder} transition-all duration-300 shadow-xl ${
      isWin
        ? "border-amber-500/40 bg-gradient-to-b from-[#181308] via-[#121212] to-[#0e0e0e]"
        : isRanked
        ? "border-amber-500/20 bg-gradient-to-b from-[#16140d] via-[#121212] to-[#0e0e0e]"
        : "border-white/10 bg-[#121212]"
    }`}>

      {/* 승리 shimmer 효과 */}
      {isWin && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -right-20 w-64 h-64 bg-amber-500/10 rounded-full blur-[60px]" />
          <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-amber-600/8 rounded-full blur-[40px]" />
        </div>
      )}


      {/* 리플레이·상대 보기 액션 */}
      <div
        data-testid="match-replay-action"
        className="px-3.5 pt-4 pb-3.5 md:px-5 md:pt-5 md:pb-4 flex flex-wrap items-center gap-2 md:gap-3"
      >
        {!isTdmMatch && (
          <button
            type="button"
            aria-label="리플레이 분석"
            onClick={(e) => {
              e.stopPropagation();
              setShowReplayModal(true);
            }}
            className={`flex min-h-11 items-center gap-1.5 px-4 rounded-xl text-[11px] font-black uppercase tracking-tighter transition-all hover:scale-105 active:scale-95 bg-[#ff9f0a] hover:bg-[#e08b00] text-[#0d1117] shadow-[0_0_20px_rgba(255,159,10,0.25)] border border-[#ff9f0a]/30 cursor-pointer`}
          >
            <PlayCircle size={14} className="shrink-0" />
            리플레이 분석
          </button>
        )}
        <Link
          onClick={(e) => e.stopPropagation()}
          className="flex min-h-11 items-center gap-1.5 px-4 rounded-xl text-[11px] font-black tracking-tighter text-white/80 bg-white/5 border border-white/10 transition-colors hover:bg-white/10 hover:text-white"
          href={`/stats/${platform}/${encodeURIComponent(nickname)}/encounters?matchId=${encodeURIComponent(matchId)}`}
        >
          <Swords size={14} className="shrink-0" aria-hidden="true" />
          이 경기 상대 보기
        </Link>
      </div>

      {/* Expanded Content */}
      <div className="p-3 md:p-6 pt-0 border-t border-white/10 animate-in slide-in-from-top-4 duration-500 bg-transparent rounded-b-2xl relative z-10">
          <MatchVerdictBlock matchData={matchData} report={matchReport} showScore={!isBasicSummary && !isTdmMatch} />

          {/* Detailed Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <StatBox icon={<Crosshair size={16} />} label="헤드샷" value={displayStat(isBasicSummary ? null : matchData.stats.headshotKills)} color="text-red-400" />
            <StatBox icon={<Zap size={16} />} label="어시스트" value={displayStat(isBasicSummary ? null : matchData.stats.assists)} color="text-indigo-400" />
            <StatBox icon={<Shield size={16} />} label="기절시킴" value={displayStat(isBasicSummary ? getObservedBasicMatchStat(matchData, "DBNOs") : matchData.stats.DBNOs)} color="text-yellow-400" />
            <StatBox icon={<Clock size={16} />} label="생존시간" value={displayStat(isBasicSummary ? getObservedBasicMatchStat(matchData, "timeSurvived") : matchData.stats.timeSurvived, value => `${Math.floor(value / 60)}분`)} color="text-green-400" />
          </div>

          {botShare && (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400" aria-label="참가자 구성">
              <span>참가자 {botShare.botCount + botShare.humanCount}명</span>
              <span className="text-gray-600">·</span>
              <span>사람 {botShare.humanCount}</span>
              <span className="text-gray-600">·</span>
              <span>봇 {botShare.botCount} ({botShare.percent}%)</span>
              {botShare.level !== "none" && (
                <span className="rounded bg-white/5 px-1.5 py-0.5 font-bold text-gray-300">{BOT_SHARE_LEVEL_LABELS[botShare.level]}</span>
              )}
              {humanPlace !== null && (
                <span className="text-gray-300" title="봇만 있는 팀을 빼고 센 순위">사람 팀 기준 #{humanPlace}</span>
              )}
            </p>
          )}

          {hasVehicleCombat && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400" aria-label="차량 교전">
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-bold text-amber-300">
                <Car size={11} aria-hidden="true" />
                차량 교전
              </span>
              {Number(leadKills || leadKnocks) > 0 && <span>리드샷 기절 {leadKnocks} · 킬 {leadKills}</span>}
              {Number(ridingKills || ridingKnocks) > 0 && <span>탑승 사격 기절 {ridingKnocks} · 킬 {ridingKills}</span>}
              {Number(roadKills || roadKnocks) > 0 && <span>로드킬 기절 {roadKnocks} · 킬 {roadKills}</span>}
            </p>
          )}

          {/* AI Analysis Section */}
          {!isTdmMatch && (
            <CollapsibleDetailSection
              title="AI 코칭"
              icon={<BarChart2 size={20} className={isRanked ? 'text-amber-500' : 'text-indigo-400'} />}
              isOpen={openDetailSections.ai}
              onToggle={() => toggleDetailSection("ai")}
              summary={analysis ? "분석 완료" : coachingStyle === 'mild' ? "다정한 맛" : "매운맛"}
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-end gap-4 mb-6">
                <div className="flex items-center gap-2">
                  <div className="flex gap-2 bg-black/40 p-1 rounded-2xl border border-white/10">
                  <button
                    // 분석 중 스타일을 바꾸면 이전 스타일 응답이 새 스타일 화면에 표시되므로 막는다.
                    disabled={isAnalyzing}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCoachingStyle("mild");
                      setAnalysis(null);
                      setAnalysisError(null);
                    }}
                    className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                      coachingStyle === 'mild'
                        ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <BgmsIcon name="shield" size={14} /> 다정한 맛
                  </button>
                  <button
                    // 분석 중 스타일을 바꾸면 이전 스타일 응답이 새 스타일 화면에 표시되므로 막는다.
                    disabled={isAnalyzing}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCoachingStyle("spicy");
                      setAnalysis(null);
                      setAnalysisError(null);
                    }}
                    className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${
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

              {analysisError && (
                <div
                  role="alert"
                  aria-label="AI 분석 실패"
                  className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-center"
                >
                  <p className="text-sm font-black text-red-100">{analysisError.message}</p>
                  <p className="mt-1 text-xs font-medium text-red-200/70">
                    {isCalculationUpgradePending
                      ? MATCH_CALCULATION_UPGRADE_DETAIL
                      : "잠시 후 같은 매치에서 다시 시도할 수 있습니다."}
                  </p>
                </div>
              )}

              {analysis ? (
                <div className="flex flex-col gap-6 animate-in fade-in zoom-in duration-500">
                  <MatchAiCoachingCard
                    analysis={analysis}
                    isAnalyzing={isAnalyzing}
                    coachingStyle={coachingStyle}
                    timeline={matchData.timeline}
                    onSceneSelect={handleAiSceneSelect}
                  />
              </div>
            ) : (
              <button
                type="button"
                aria-label="이 매치 정밀 분석 시작하기"
                onClick={handleAnalyze}
                disabled={isGlobalAnalyzing || isAnalyzing || isCalculationUpgradePending}
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
                    {isAnalyzing
                      ? "전장 데이터를 복기하는 중..."
                      : isCalculationUpgradePending
                        ? MATCH_CALCULATION_UPGRADE_MESSAGE
                        : "이 매치 정밀 분석 시작하기"}
                  </span>
                  <span className="text-gray-500 text-xs font-medium uppercase tracking-widest">
                    {coachingStyle === 'mild' ? "KIND COACH 모드로 분석" : "SPICY BOMBER 모드로 분석"}
                  </span>
                </div>
              </button>
            )}
            </CollapsibleDetailSection>
          )}

          {matchReport && matchReport.teams.length > 0 && (
            <CollapsibleDetailSection
              title="개인 성적"
              icon={<Trophy size={16} className="text-[#F2A900]" />}
              isOpen={openDetailSections.ranking}
              onToggle={() => toggleDetailSection("ranking")}
              summary={rankSummary ?? undefined}
            >
              <MatchPlayerRankingContent report={matchReport} nickname={nickname} onNicknameClick={onNicknameClick} />
            </CollapsibleDetailSection>
          )}

          {(hasMatchFlow(matchReport) || !isTdmMatch) && (
            <CollapsibleDetailSection
              title="경기 흐름"
              icon={<Activity size={16} className="text-sky-400" />}
              isOpen={openDetailSections.flow}
              onToggle={() => toggleDetailSection("flow")}
              summary={hasMatchFlow(matchReport) ? `교전 ${matchReport.fights.length}번` : undefined}
            >
              {hasMatchFlow(matchReport) && (
                <MatchFlowContent
                  report={matchReport}
                  canReplay={replayMapId !== null && getMatchDetailRetention(matchDate).status === "available"}
                  onReplayAt={openReplayAt}
                />
              )}
              {!isTdmMatch && (
                <>
                  <button
                    type="button"
                    aria-expanded={showFlowMap}
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowFlowMap((current) => !current);
                    }}
                    className="mt-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-white/10 px-4 text-xs font-bold text-white/70 hover:bg-white/5"
                  >
                    <span className="flex items-center gap-2">
                      <Target size={14} className="text-indigo-400" aria-hidden="true" />
                      지도와 전체 이벤트 보기
                    </span>
                    <span className="flex items-center gap-2 text-[10px] text-white/50">
                      이벤트 {matchData!.timeline?.filter((e: any) => e.type !== 'PHASE_START').length || 0}개
                      <ChevronDown size={14} className={`transition-transform ${showFlowMap ? "rotate-180" : ""}`} aria-hidden="true" />
                    </span>
                  </button>
                  {showFlowMap && (
                  <div className="mt-3 grid grid-cols-1 lg:grid-cols-12 gap-3 md:gap-4 animate-in slide-in-from-top-2 duration-300">
                    {/* Left: Mini Map */}
                    <div ref={flowMapRef} data-testid="match-tactical-map" className="lg:col-span-5 xl:col-span-4 bg-white/2 border border-white/5 rounded-[1.5rem] overflow-hidden min-h-[240px] sm:min-h-[280px] lg:min-h-0 lg:h-[360px] relative group/map">
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
                            <span className="text-[9px] text-gray-400 font-bold">지도에 교전 지점이 표시됩니다</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Right: Timeline */}
                    <div className="lg:col-span-7 xl:col-span-8 bg-white/2 border border-white/5 rounded-[1.5rem] p-3 md:p-4 lg:h-[360px] flex flex-col">
                      <div className="flex items-center justify-between mb-3 shrink-0">
                        <div className="text-[10px] text-gray-400 font-black uppercase tracking-widest">매치 타임라인</div>
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
                  )}
                </>
              )}
            </CollapsibleDetailSection>
          )}

          {/* [V58.4] 무기 세부 분석 및 아군 기여도 (Weapon & Squad Armory) */}
          {((matchData.weaponStats && Object.keys(matchData.weaponStats).length > 0) ||
            (Object.keys(normalizedSquadWeaponStats).length > 0)) && (
            <CollapsibleDetailSection
              title="무기 기록"
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
                      <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest">내 무기 상세 스탯</span>
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
                                <h5 className="text-white font-black text-[15px] tracking-tight">{getWeaponDisplayName(wName)}</h5>
                                <span className="text-[9px] text-gray-400 font-bold uppercase">
                                  {wStat.holdingTime ? `파지 ${Math.round(wStat.holdingTime)}초` : '주무기'}
                                </span>
                              </div>
                              <div className="flex flex-col items-end">
                                <span className="text-white font-black text-[14px]">
                                  {Math.round(wStat.damage)} <span className="text-[10px] text-gray-400 font-medium">딜</span>
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
                      <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest">아군 무기 상세 스탯</span>
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
                                    <span className="font-bold">{getWeaponDisplayName(sw.weapon)}</span>
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

          {/* 팀원 성적과 경기 전체(팀 순위·킬 기록) */}
          <CollapsibleDetailSection
            title="팀원 · 경기 전체"
            icon={<ListTree size={16} className="text-violet-300" />}
            isOpen={openDetailSections.team}
            onToggle={() => toggleDetailSection("team")}
            summary={hasMatchOverview(matchReport) ? `${normalizedTeamMembers.length}명 · ${matchReport.teams.length}팀` : `${normalizedTeamMembers.length}명`}
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
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-400 font-bold uppercase">킬</span>
                        <span className="text-sm font-black text-red-400">{displayStat(member.kills)}</span>
                      </div>
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-400 font-bold uppercase">어시스트</span>
                        <span className="text-sm font-black text-indigo-400">{displayStat(member.assists)}</span>
                      </div>
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-400 font-bold uppercase">기절</span>
                        <span className="text-sm font-black text-yellow-500">{displayStat(member.DBNOs)}</span>
                      </div>
                      <div className="bg-black/20 p-2 rounded-xl flex flex-col items-center">
                        <span className="text-[9px] text-gray-400 font-bold uppercase">피해량</span>
                        <span className="text-sm font-black text-white">{displayStat(member.damageDealt, Math.floor)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {hasMatchOverview(matchReport) && (
              <div className="mt-5 border-t border-white/5 pt-4">
                <MatchOverviewContent report={matchReport} />
              </div>
            )}
          </CollapsibleDetailSection>
      </div>

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
                title={!is3DReplaySupported ? "이 맵은 현재 3D 리플레이를 지원하지 않습니다." : undefined}
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
                      : replayMapId
                        ? "이 맵은 3D 지형 자산 준비 전입니다. 2D 미니 리플레이를 이용해 주세요."
                        : "이 맵은 3D 지형 자산 준비 전입니다."}
                  </p>
                </div>
              </button>

              {/* 2) 2D 리플레이: 바로 열리는 lite로 시작하고, 아군 전멸 뒤는 재생 화면에서 경기 끝까지 이어 본다. */}
              <button
                type="button"
                aria-label="2D 맵 리플레이"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowReplayModal(false);
                  handleInternalReplay(e);
                }}
                disabled={!replayMapId}
                title={!replayMapId ? get2DReplayUnsupportedMessage(matchData.mapName || "") : undefined}
                className="w-full text-left p-4 bg-white/3 hover:bg-white/5 border border-white/5 hover:border-white/10 rounded-2xl transition-all flex gap-3.5 items-center cursor-pointer group hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100 disabled:hover:bg-white/3 disabled:hover:border-white/5"
              >
                <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center text-indigo-400 shrink-0">
                  <MapIcon size={20} className="group-hover:scale-110 transition-transform" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-white font-black text-sm font-sans">2D 리플레이</span>
                  <p className="text-[10px] text-gray-400 mt-1 leading-normal font-medium font-sans">
                    {replayMapId
                      ? "모든 선수의 이동·교전·자기장을 지도에서 재생합니다. 아군이 전멸한 경기는 재생 화면에서 경기 끝까지 이어 볼 수 있습니다."
                      : get2DReplayUnsupportedMessage(matchData.mapName || "")}
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
    <span className="text-[10px] text-gray-400 font-black uppercase tracking-tighter">{label}</span>
    <span className="text-lg font-black text-white">{value}</span>
  </div>
);
