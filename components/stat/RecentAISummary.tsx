"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldAlert, Clock, TrendingUp, TrendingDown, Minus, Flame, Skull, Target, HelpCircle, Zap, Brain, X, ChevronDown, ChevronUp } from "lucide-react";
import { getNextTierInfo } from "@/lib/pubg-analysis/benchmarkScore";

import { IsolationRadar } from "./IsolationRadar";
import { SpiderChart } from "./SpiderChart";
import { MapKingCard } from "./MapKingCard";
import { useAIStatus, aiManager } from "@/lib/ai-management";
import { useAuth } from "@/components/AuthProvider";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { BgmsIcon, type BgmsIconName } from "@/components/common/BgmsIcon";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { matchDebateStatPairs, normalizeAiSummaryFinalJson, type DebateStat } from "@/lib/pubg-analysis/aiSummaryDebate";
import { parseSummaryCards, type SummaryCard, type SummaryEvidence } from "@/lib/pubg-analysis/aiSummaryCards";
import { formatBenchmarkDisplayLabel } from "@/lib/pubg-analysis/benchmarkAdapter";

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

interface BenchmarkScope {
  gameMode?: string;
  matchType?: string;
  tier?: string;
  sampleCount?: number;
  metricSampleCounts?: Record<string, number>;
}

interface DebateData {
  debateIssues?: DebateIssue[];
  finalVerdict?: string;
  weaknessDiagnostic?: string;
  actionItems?: ActionItem[];

  signature?: string;
  signatureSub?: string;
  visuals?: {
    //  API 응답 실제 구조에 맞게 정리: latency 객체는 미사용, counterLatency만 실제 사용됨
    counterLatency?: string;
    tierBreakdown?: {
      combat: number;
      tactical: number;
      survival: number;
      total: number;
    };
    latestMatchTime?: string;
    latestMatchCount?: number;
    bestMatchCount?: number;
    reactionLatency?: string;
    reactionTier?: string;
    backupTier?: string;
    overallTier?: string;
    benchmarkScope?: BenchmarkScope;
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

    initiativeSuccess?: string;
    duelStats?: { winRate: string; wins: number; losses: number; reversals: number; reversalAttempts: number };
    reversalRate?: string;
    coverRate?: string;
    goldenTime?: { early: number; mid1: number; mid2: number; late: number };
    killContrib?: { solo: number; cleanup: number };
    deathPhase?: number;
    bluezoneWaste?: number | "측정 불가";
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
      benchmarkIsolationIndex?: number;
      benchmarkMinDist?: number;
      benchmarkScope?: BenchmarkScope;
    };
    };
  };
}

type RouteOwnedVisuals = NonNullable<DebateData["visuals"]>;

export function finiteVisualNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(min, Math.min(max, number));
  } catch {
    return null;
  }
}

function safeVisualText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && !/(?:NaN|Infinity|undefined)/iu.test(text) ? text : null;
}

export function safeVisualRate(value: unknown): string | null {
  const text = safeVisualText(value);
  if (!text) return null;
  if (text === "측정 불가") return text;
  const match = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*%$/u);
  if (!match) return null;
  const number = finiteVisualNumber(match[1], -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return number === null || number < 0 || number > 100
    ? "측정 불가"
    : `${Math.round(number)}%`;
}

export function safeVisualDuration(value: unknown): string | null {
  const text = safeVisualText(value);
  if (!text || text === "측정 불가") return text;
  const match = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*s$/iu);
  if (!match) return null;
  const number = finiteVisualNumber(match[1], -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return number === null || number < 0 ? "측정 불가" : `${number.toFixed(2)}s`;
}

function safeVisualMetric(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | "측정 불가" | null {
  if (value === "측정 불가") return value;
  return finiteVisualNumber(value, min, max);
}

export function formatBluezoneWaste(value: number | "측정 불가" | null | undefined): string {
  return value === "측정 불가" ? value : `${Math.floor(value ?? 0)} HP`;
}

export function normalizeRouteOwnedVisuals(value: unknown): RouteOwnedVisuals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const copyText = (key: string) => {
    const text = safeVisualText(source[key]);
    if (text !== null) normalized[key] = text;
  };
  const copyNumber = (key: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const number = finiteVisualNumber(source[key], min, max);
    if (number !== null) normalized[key] = number;
  };

  ["latestMatchTime", "reactionTier", "backupTier", "overallTier", "weaknessDiagnostic"].forEach(copyText);
  const counterLatency = safeVisualDuration(source.counterLatency);
  if (counterLatency !== null) normalized.counterLatency = counterLatency;
  const reactionLatency = safeVisualDuration(source.reactionLatency);
  if (reactionLatency !== null) normalized.reactionLatency = reactionLatency;
  ["latestMatchCount", "bestMatchCount"].forEach((key) => {
    const count = finiteVisualNumber(source[key], 0, 100);
    if (count !== null) normalized[key] = Math.floor(count);
  });
  ["initiativeSuccess", "reversalRate", "coverRate"].forEach((key) => {
    const rate = safeVisualRate(source[key]);
    if (rate !== null) normalized[key] = rate;
  });
  copyNumber("deathPhase", 0, 100);
  const bluezoneWaste = safeVisualMetric(source.bluezoneWaste, 0);
  if (bluezoneWaste !== null) normalized.bluezoneWaste = bluezoneWaste;

  const tierBreakdown = source.tierBreakdown;
  if (tierBreakdown && typeof tierBreakdown === "object" && !Array.isArray(tierBreakdown)) {
    const tierSource = tierBreakdown as Record<string, unknown>;
    const combat = finiteVisualNumber(tierSource.combat, 0, 100);
    const tactical = finiteVisualNumber(tierSource.tactical, 0, 100);
    const survival = finiteVisualNumber(tierSource.survival, 0, 100);
    const total = finiteVisualNumber(tierSource.total, 0, 100);
    if (combat !== null && tactical !== null && survival !== null && total !== null) {
      normalized.tierBreakdown = { combat, tactical, survival, total };
    }
  }

  const benchmarkScope = source.benchmarkScope;
  if (benchmarkScope && typeof benchmarkScope === "object" && !Array.isArray(benchmarkScope)) {
    const scopeSource = benchmarkScope as Record<string, unknown>;
    const scope: Record<string, unknown> = {};
    ["gameMode", "matchType", "tier"].forEach((key) => {
      const text = safeVisualText(scopeSource[key]);
      if (text !== null) scope[key] = text;
    });
    const sampleCount = finiteVisualNumber(scopeSource.sampleCount, 0);
    if (sampleCount !== null) scope.sampleCount = Math.floor(sampleCount);
    const metricCounts = scopeSource.metricSampleCounts;
    if (metricCounts && typeof metricCounts === "object" && !Array.isArray(metricCounts)) {
      const normalizedCounts: Record<string, number> = {};
      Object.entries(metricCounts as Record<string, unknown>).forEach(([key, count]) => {
        const normalizedCount = finiteVisualNumber(count, 0, sampleCount ?? Number.MAX_SAFE_INTEGER);
        if (normalizedCount !== null && Number.isInteger(normalizedCount)) normalizedCounts[key] = normalizedCount;
      });
      if (Object.keys(normalizedCounts).length > 0) scope.metricSampleCounts = normalizedCounts;
    }
    if (Object.keys(scope).length > 0) normalized.benchmarkScope = scope;
  }

  const roleInfo = source.roleInfo;
  if (roleInfo && typeof roleInfo === "object" && !Array.isArray(roleInfo)) {
    const roleSource = roleInfo as Record<string, unknown>;
    const role: Record<string, unknown> = {};
    ["primaryRole", "title", "roleLabel", "description", "signatureWeapon", "weakness"].forEach((key) => {
      const text = safeVisualText(roleSource[key]);
      if (text !== null) role[key] = text;
    });
    if (roleSource.secondaryRole === null) role.secondaryRole = null;
    else {
      const secondaryRole = safeVisualText(roleSource.secondaryRole);
      if (secondaryRole !== null) role.secondaryRole = secondaryRole;
    }
    const roleStats = roleSource.signatureWeaponStats;
    if (roleStats && typeof roleStats === "object" && !Array.isArray(roleStats)) {
      const statsSource = roleStats as Record<string, unknown>;
      const stats: Record<string, unknown> = {};
      ["kills", "dbnos"].forEach((key) => {
        const number = finiteVisualNumber(statsSource[key], 0);
        if (number !== null) stats[key] = Math.floor(number);
      });
      const consistency = finiteVisualNumber(statsSource.consistency, 0, 100);
      if (consistency !== null) stats.consistency = consistency;
      if (typeof statsSource.isReliable === "boolean") stats.isReliable = statsSource.isReliable;
      if (Object.keys(stats).length > 0) role.signatureWeaponStats = stats;
    }
    const scores = roleSource.scores;
    if (scores && typeof scores === "object" && !Array.isArray(scores)) {
      const normalizedScores: Record<string, number> = {};
      Object.entries(scores as Record<string, unknown>).forEach(([key, score]) => {
        const number = finiteVisualNumber(score, 0, 100);
        if (number !== null) normalizedScores[key] = number;
      });
      role.scores = normalizedScores;
    }
    if (Object.keys(role).length > 0) normalized.roleInfo = role;
  }

  const duelStats = source.duelStats;
  if (duelStats && typeof duelStats === "object" && !Array.isArray(duelStats)) {
    const duelSource = duelStats as Record<string, unknown>;
    const duel: Record<string, unknown> = {};
    const winRate = safeVisualRate(duelSource.winRate);
    if (winRate !== null) duel.winRate = winRate;
    ["wins", "losses", "reversals", "reversalAttempts"].forEach((key) => {
      const number = finiteVisualNumber(duelSource[key], 0);
      if (number !== null) duel[key] = Math.floor(number);
    });
    if (Object.keys(duel).length > 0) normalized.duelStats = duel;
  }

  [
    ["goldenTime", ["early", "mid1", "mid2", "late"]],
    ["killContrib", ["solo", "cleanup", "assist"]],
  ].forEach(([containerKey, keys]) => {
    const container = source[containerKey as string];
    if (!container || typeof container !== "object" || Array.isArray(container)) return;
    const target: Record<string, number> = {};
    (keys as string[]).forEach((key) => {
      const number = finiteVisualNumber((container as Record<string, unknown>)[key], 0);
      if (number !== null) target[key] = number;
    });
    if (Object.keys(target).length > 0) normalized[containerKey as string] = target;
  });

  const modeDistribution = source.modeDistribution;
  if (modeDistribution && typeof modeDistribution === "object" && !Array.isArray(modeDistribution)) {
    const modeSource = modeDistribution as Record<string, unknown>;
    const ranked = finiteVisualNumber(modeSource.ranked, 0);
    const normal = finiteVisualNumber(modeSource.normal, 0);
    const main = safeVisualText(modeSource.main);
    if (ranked !== null && normal !== null && main !== null) {
      normalized.modeDistribution = { ranked: Math.floor(ranked), normal: Math.floor(normal), main };
    }
  }

  const mapStats = source.mapStats;
  if (mapStats && typeof mapStats === "object" && !Array.isArray(mapStats)) {
    const mapSource = mapStats as Record<string, unknown>;
    const normalizeMap = (map: unknown) => {
      if (!map || typeof map !== "object" || Array.isArray(map)) return null;
      const mapRecord = map as Record<string, unknown>;
      const mapName = safeVisualText(mapRecord.mapName);
      const displayName = safeVisualText(mapRecord.displayName);
      const matchCount = finiteVisualNumber(mapRecord.matchCount, 0);
      const avgDamage = finiteVisualNumber(mapRecord.avgDamage, 0);
      const avgKills = finiteVisualNumber(mapRecord.avgKills, 0);
      const avgDeathPhase = finiteVisualNumber(mapRecord.avgDeathPhase, 0);
      if (!mapName || !displayName || matchCount === null || avgDamage === null || avgKills === null || avgDeathPhase === null) return null;
      return {
        mapName,
        displayName,
        matchCount: Math.floor(matchCount),
        avgDamage,
        avgKills,
        avgDeathPhase,
      };
    };
    const list = Array.isArray(mapSource.list)
      ? mapSource.list.map(normalizeMap).filter((entry): entry is NonNullable<ReturnType<typeof normalizeMap>> => entry !== null)
      : [];
    const bestMap = normalizeMap(mapSource.bestMap);
    const worstMap = normalizeMap(mapSource.worstMap);
    if (list.length > 0 && bestMap && worstMap) normalized.mapStats = { list, bestMap, worstMap };
  }

  const trends = source.trends;
  if (trends && typeof trends === "object" && !Array.isArray(trends)) {
    const trendSource = trends as Record<string, unknown>;
    const dmgTrend = finiteVisualNumber(trendSource.dmgTrend, -Number.MAX_SAFE_INTEGER);
    const winTrend = finiteVisualNumber(trendSource.winTrend, -Number.MAX_SAFE_INTEGER);
    const status = safeVisualText(trendSource.status);
    const recent = trendSource.recent;
    const older = trendSource.older;
    const normalizeTrendPoint = (point: unknown) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) return null;
      const record = point as Record<string, unknown>;
      const damage = finiteVisualNumber(record.damage, 0);
      const winRate = finiteVisualNumber(record.winRate, 0, 100);
      return damage === null || winRate === null ? null : { damage, winRate };
    };
    const normalizedRecent = normalizeTrendPoint(recent);
    const normalizedOlder = normalizeTrendPoint(older);
    if (dmgTrend !== null && winTrend !== null && status !== null && normalizedRecent && normalizedOlder) {
      normalized.trends = { dmgTrend, winTrend, status, recent: normalizedRecent, older: normalizedOlder };
    }
  }

  const tactical = source.tactical;
  if (tactical && typeof tactical === "object" && !Array.isArray(tactical)) {
    const tacticalSource = tactical as Record<string, unknown>;
    const tacticalTarget: Record<string, unknown> = {};
    ["suppRate", "smokeRate", "reviveRate", "tradeRate"].forEach((key) => {
      const rate = safeVisualRate(tacticalSource[key]);
      if (rate !== null) tacticalTarget[key] = rate;
    });
    const baitCount = finiteVisualNumber(tacticalSource.baitCount, 0);
    if (baitCount !== null) tacticalTarget.baitCount = Math.floor(baitCount);
    const counts = tacticalSource.counts;
    if (counts && typeof counts === "object" && !Array.isArray(counts)) {
      const countsSource = counts as Record<string, unknown>;
      const countsTarget: Record<string, unknown> = {};
      ["knocks", "smokes", "rescueSmokes", "smokeRescues", "revives", "trades", "supps", "enemyTeamWipes"].forEach((key) => {
        const number = finiteVisualNumber(countsSource[key], 0);
        if (number !== null) countsTarget[key] = Math.floor(number);
      });
      const initiative = countsSource.initiative;
      if (initiative && typeof initiative === "object" && !Array.isArray(initiative)) {
        const attempts = finiteVisualNumber((initiative as Record<string, unknown>).attempts, 0);
        const success = finiteVisualNumber((initiative as Record<string, unknown>).success, 0);
        if (attempts !== null && success !== null) countsTarget.initiative = { attempts: Math.floor(attempts), success: Math.floor(success) };
      }
      if (Object.keys(countsTarget).length > 0) tacticalTarget.counts = countsTarget;
    }
    const isolation = tacticalSource.isolation;
    if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
      const isolationSource = isolation as Record<string, unknown>;
      const isolationTarget: Record<string, unknown> = {};
      ["isolationIndex", "minDist", "heightDiff", "teammateCount", "benchmarkIsolationIndex", "benchmarkMinDist"].forEach((key) => {
        const number = finiteVisualNumber(isolationSource[key], 0);
        if (number !== null) isolationTarget[key] = number;
      });
      if (typeof isolationSource.isCrossfire === "boolean") isolationTarget.isCrossfire = isolationSource.isCrossfire;
      const nestedScope = normalizeRouteOwnedVisuals({ benchmarkScope: isolationSource.benchmarkScope })?.benchmarkScope;
      if (nestedScope) isolationTarget.benchmarkScope = nestedScope;
      if (Object.keys(isolationTarget).length > 0) tacticalTarget.isolation = isolationTarget;
    }
    if (Object.keys(tacticalTarget).length > 0) normalized.tactical = tacticalTarget;
  }

  return Object.keys(normalized).length > 0 ? normalized as RouteOwnedVisuals : null;
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

const TIER_TOOLTIP_ID = "recent-ai-summary-tier-tooltip";

function neutralBenchmarkLabel(
  label: string,
  scope?: BenchmarkScope,
): string {
  const benchmarkLabel = formatBenchmarkDisplayLabel({
    gameMode: scope?.gameMode,
    matchType: scope?.matchType,
    tier: scope?.tier,
  });
  const normalized = label.replace(
    /(?:상위권|엘리트|benchmark|벤치마크|동일\s*조건\s*[·ㆍ・.]?\s*동일\s*티어|동일\s*티어)(?:\s*평균)?/gi,
    benchmarkLabel,
  );
  return normalized !== label ? normalized : `${benchmarkLabel}: ${normalized}`;
}

export interface AiSummarySnapshot {
  verdict: string;
  tier?: string;
}

export interface RecentAISummaryProps {
  matchIds: readonly string[];
  nickname: string;
  platform: string;
  isMobile?: boolean;
  onSummaryChange?(summary: AiSummarySnapshot | null): void;
}

interface SummaryRequestOwner {
  generation: number;
  identity: string;
  controller: AbortController;
  routeOwnedVisuals: DebateData["visuals"] | null;
}

class AiSummaryRequestError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { status?: number; errorCode?: string | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AiSummaryRequestError";
    this.status = details.status ?? 0;
    this.errorCode = details.errorCode ?? null;
    this.retryable = details.retryable ?? false;
  }
}

export const RecentAISummary = ({
  matchIds,
  nickname,
  platform,
  isMobile,
  onSummaryChange,
}: RecentAISummaryProps) => {
  const [debateData, setDebateData] = useState<DebateData | null>(null);
  const [summaryCards, setSummaryCards] = useState<SummaryCard[] | null>(null);
  const [summaryContractVersion, setSummaryContractVersion] = useState<2 | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<AiSummaryRequestError | null>(null);
  const [openIssueIdx, setOpenIssueIdx] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showTierTooltip, setShowTierTooltip] = useState(false);
  const [activeStatTooltip, setActiveStatTooltip] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const statTooltipRef = useRef<HTMLDivElement>(null);
  const tierTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreTierFocusRef = useRef(false);
  const tierTriggerPointerRef = useRef(false);

  const textBufferRef = useRef("");
  const lineBufferRef = useRef("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const isLoadingRef = useRef(false);
  const matchIdsIdentity = matchIds.join("\u001f");
  const identity = `${platform}\u001e${nickname}\u001e${matchIdsIdentity}`;
  const [renderIdentity, setRenderIdentity] = useState(identity);
  const identityRef = useRef(identity);
  const generationRef = useRef(0);
  const requestOwnerRef = useRef<SummaryRequestOwner | null>(null);
  const dataIdentityRef = useRef<string | null>(null);
  const summaryCardsRef = useRef<SummaryCard[] | null>(null);
  const summaryContractVersionRef = useRef<2 | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSummaryChangeRef = useRef(onSummaryChange);
  const emittedSummaryRef = useRef<string | null>(null);
  // [AUTO-RETRY] 일시적 Gemini 스트림 오류 자동 재시도
  const retryCountRef = useRef(0);
  const MAX_AUTO_RETRIES = 1;
  const AI_SUMMARY_CLIENT_SAFETY_TIMEOUT_MS = 55_000;
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const { isAnalyzing: isGlobalAnalyzing } = useAIStatus();
  const { user } = useAuth();
  const router = useRouter();

  const writeSummaryCards = (cards: SummaryCard[] | null) => {
    summaryCardsRef.current = cards;
    setSummaryCards(cards);
  };

  const markSummaryContractV2 = () => {
    summaryContractVersionRef.current = 2;
    setSummaryContractVersion(2);
  };

  const latestMatchCount = debateData?.visuals?.latestMatchCount ?? 10;
  const bestMatchCount = debateData?.visuals?.bestMatchCount ?? 5;
  const latestMatchRangeLabel = debateData?.visuals?.latestMatchCount === undefined
    ? "최대 10판"
    : `${latestMatchCount}판`;
  const bestMatchRangeLabel = debateData?.visuals?.bestMatchCount === undefined
    ? "최대 5판"
    : `${bestMatchCount}판`;

  useEffect(() => {
    onSummaryChangeRef.current = onSummaryChange;
  }, [onSummaryChange]);

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
    const requestedIdentity = identity;
    const requestedGeneration = generationRef.current;
    const identityIsCurrent = () => (
      generationRef.current === requestedGeneration && identityRef.current === requestedIdentity
    );
    //  [보안] 비로그인 유저 AI 요약 차단 — 로그인 유도 토스트
    if (!user) {
      toast.error("AI 전술 분석은 로그인 후 이용할 수 있습니다.", {
        action: {
          label: "로그인",
          onClick: () => router.push("/login"),
        },
      });
      return;
    }

    //  [세션 동기화] API fetch 전 브라우저 쿠키를 최신 세션 토큰으로 강제 동기화 (401 방지)
    try {
      await supabase.auth.getSession();
    } catch (e) {
      console.warn("[AI-SUMMARY] Session refresh failed (ignored):", e);
    }
    if (!identityIsCurrent()) return;

    // [V46.1] 전역 락 체크 및 중복 실행 방지
    if (isGlobalAnalyzing || loading || isLoadingRef.current || (!force && debateData)) return;

    if (!aiManager.startAnalysis("summary")) return;

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    // 수동 시작 시 재시도 카운트 초기화
    if (!retryCountRef.current) retryCountRef.current = 0;
    setRetryMessage(null);

    setLoading(true);
    isLoadingRef.current = true;
    setError(null);
    setStreamingText("");

    if (force) {
      dataIdentityRef.current = null;
      // A v2 retry may still have server-assembled facts available. Keep the
      // facts visible until the replacement cards arrive (or the request is
      // reset by an identity change), while preserving the v1 reset behavior.
      if (summaryContractVersionRef.current !== 2) setDebateData(null);
      textBufferRef.current = "";
      lineBufferRef.current = "";
    }

    const abortController = new AbortController();
    const owner: SummaryRequestOwner = {
      generation: requestedGeneration,
      identity: requestedIdentity,
      controller: abortController,
      routeOwnedVisuals: null,
    };
    requestOwnerRef.current = owner;
    abortControllerRef.current = abortController;
    const ownsRequest = () => (
      requestOwnerRef.current === owner
      && identityIsCurrent()
    );
    const canWriteRequest = () => ownsRequest() && !abortController.signal.aborted;
    const scheduleRetry = (message: string) => {
      if (!canWriteRequest() || retryTimerRef.current || retryCountRef.current >= MAX_AUTO_RETRIES) return false;
      retryCountRef.current += 1;
      setRetryMessage(`${message} (${retryCountRef.current}/${MAX_AUTO_RETRIES})`);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!identityIsCurrent()) return;
        setRetryMessage(null);
        void handleFetchSummary(true);
      }, 2500);
      return true;
    };

    // Route maxDuration(60초)보다 여유를 둬 cold path의 정상 응답을 재시도로 오인하지 않는다.
    const safetyTimeout = setTimeout(() => {
      if (!canWriteRequest()) return;
      console.warn("[AI-SUMMARY] Safety timeout triggered. Forcing cleanup.");
      readerRef.current?.cancel().catch(() => {});
      if (!scheduleRetry("AI 서버 응답이 느려요. 잠깐만요...")) {
        retryCountRef.current = 0;
        setError(new AiSummaryRequestError("분석 서버 응답이 너무 느립니다. 잠시 후 다시 시도해주세요."));
      }
      abortController.abort();
    }, AI_SUMMARY_CLIENT_SAFETY_TIMEOUT_MS);

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
          force,
          summaryContractVersion: 2,
        })
      });
      if (!canWriteRequest()) return;

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as {
          error?: string;
          errorCode?: string;
          retryable?: boolean;
        };
        if (!canWriteRequest()) return;
        throw new AiSummaryRequestError(
          errorData.error || "분석 서버 응답 오류가 발생했습니다.",
          {
            status: response.status,
            errorCode: errorData.errorCode,
            retryable: errorData.retryable === true,
          },
        );
      }

      const reader = response.body?.getReader();
      // [MOBILE-FIX] ref에 저장해 safety timeout에서도 cancel() 호출 가능하게
      readerRef.current = reader ?? null;
      const decoder = new TextDecoder();
      let fullText = "";
      const decodeFinalRecord = (text: string): Record<string, unknown> | null => {
        try {
          const decoded = JSON.parse(text) as unknown;
          return decoded && typeof decoded === "object" && !Array.isArray(decoded)
            ? decoded as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      };
      let streamedError: {
        error?: string;
        errorCode?: string;
        retryable?: boolean;
      } | null = null;
      // [V45.3] UI 업데이트를 위한 인터벌 (스트리밍 시각화용)
      const updateInterval = setInterval(() => {
        if (canWriteRequest() && textBufferRef.current !== streamingText) {
          setStreamingText(textBufferRef.current);
        }
      }, 100);

      let sawTerminalRecord = false;
      const clearPartialStreamState = () => {
        dataIdentityRef.current = null;
        // v2 cards are facts owned by the route, so a rejected/partial AI
        // final must not remove them. Legacy streams keep the old clear path.
        if (summaryContractVersionRef.current !== 2) setDebateData(null);
        textBufferRef.current = "";
        lineBufferRef.current = "";
        setStreamingText("");
      };

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (!canWriteRequest()) break;

            if (value && value.length > 0) {
              lineBufferRef.current += decoder.decode(value, { stream: true });
            }
            if (done) {
              // A final read can contain a complete NDJSON record without its
              // usual trailing newline. Appending one lets the same parser path
              // process that record before EOF handling below.
              lineBufferRef.current += decoder.decode();
              if (lineBufferRef.current && !lineBufferRef.current.endsWith("\n")) {
                lineBufferRef.current += "\n";
              }
            }

            const lines = lineBufferRef.current.split("\n");
            lineBufferRef.current = lines.pop() || "";

            for (const line of lines) {
              if (!canWriteRequest()) break;
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;

              try {
                const parsed = JSON.parse(trimmedLine) as {
                  type?: string;
                  data?: unknown;
                  valid?: boolean;
                  cards?: unknown;
                  error?: string;
                  errorCode?: string;
                  retryable?: boolean;
                };

                if (sawTerminalRecord) continue;

                if (parsed.type === "visuals" && parsed.data && typeof parsed.data === "object") {
                  // 비주얼 데이터가 오면 로딩을 풀고 UI를 보여줌
                  const routeOwnedVisuals = normalizeRouteOwnedVisuals(parsed.data);
                  if (!routeOwnedVisuals) continue;
                  owner.routeOwnedVisuals = routeOwnedVisuals;
                  dataIdentityRef.current = requestedIdentity;
                  setDebateData((previous) => ({
                    ...(previous ?? {}),
                    visuals: routeOwnedVisuals,
                  }));
                  // v2 cards can arrive after route-owned visuals while the
                  // provider is still streaming. Keep their pending state
                  // distinguishable from a terminal unavailable result.
                  if (summaryContractVersionRef.current !== 2) setLoading(false);
                } else if (parsed.type === "chunk" && typeof parsed.data === "string") {
                  textBufferRef.current += parsed.data;
                  fullText += parsed.data;
                } else if (parsed.type === "cards") {
                  // The cards record is deliberately independent of provider
                  // prose. Even if the terminal record reports failure, these
                  // validated facts remain renderable.
                  markSummaryContractV2();
                  setLoading(true);
                  const cards = parseSummaryCards(parsed.data);
                  if (cards) writeSummaryCards(cards);
                } else if (parsed.type === "final") {
                  // [V54.3] 서버에서 보내준 최종 정제된 JSON으로 교체 (중복 방지)
                  fullText = typeof parsed.data === "string" ? parsed.data : JSON.stringify(parsed.data ?? {});
                  const finalRecord = decodeFinalRecord(fullText);
                  if (finalRecord?.schemaVersion === 2) markSummaryContractV2();
                } else if (parsed.type === "error") {
                  streamedError = {
                    error: parsed.error,
                    errorCode: parsed.errorCode,
                    retryable: parsed.retryable === true,
                  };
                  console.error("[AI-SUMMARY] Server reported failure:", parsed.error || parsed.errorCode || "unknown");
                } else if (parsed.type === "done") {
                  sawTerminalRecord = true;
                  if (parsed.valid !== true) {
                    // v2 may send a partially accepted final before done:false.
                    // Merge that assembled card snapshot before exposing the
                    // terminal error so valid interpretations survive beside
                    // unavailable cards.
                    const terminalFinal = decodeFinalRecord(fullText.trim());
                    if (terminalFinal?.schemaVersion === 2) {
                      markSummaryContractV2();
                      const terminalCards = parseSummaryCards(terminalFinal.cards);
                      if (terminalCards) writeSummaryCards(terminalCards);
                    }
                    const failure = {
                      ...(streamedError ?? {}),
                      ...parsed,
                    };
                    const errMsg = failure.error || "서버 분석 도중 오류가 발생했습니다.";
                    const errorCode = failure.errorCode;
                    const retryable = failure.retryable === true;
                    const requestError = new AiSummaryRequestError(errMsg, {
                      status: errorCode === "PUBG_AI_CANONICAL_NOT_READY"
                        ? 409
                        : errorCode === "PUBG_AI_ROUTE_TIMEOUT" ? 504 : 200,
                      errorCode,
                      retryable,
                    });
                    // Do not leave a failed stream's visual/text prefix in the
                    // successful analysis surface while a retry/CTA is shown.
                    clearPartialStreamState();
                    console.error("[AI-SUMMARY] Server reported failure:", errMsg);
                    if (!(retryable || isTransientError(errMsg)) || !scheduleRetry(
                      errorCode === "PUBG_AI_CANONICAL_NOT_READY"
                        ? "매치 분석 데이터가 아직 준비되지 않았어요. 자동으로 재시도 중이에요."
                        : "AI 서버가 잠깐 바빴어요. 자동으로 재시도 중이에요.",
                    )) {
                      retryCountRef.current = 0;
                      setError(requestError);
                    }
                  } else {
                    try {
                      // The server emits route-owned visuals separately. A
                      // provider final must be a complete strict JSON
                      // contract; brace extraction would accept partial
                      // payloads or trailing prose and is intentionally not
                      // used here.
                      const routeOwnedVisuals = owner.routeOwnedVisuals;
                      if (!routeOwnedVisuals || Object.keys(routeOwnedVisuals).length === 0) {
                        throw new Error("Route-owned AI summary visuals are missing.");
                      }
                      const finalRecord = decodeFinalRecord(fullText.trim());
                      const isV2Final = summaryContractVersionRef.current === 2 || finalRecord?.schemaVersion === 2;
                      let decoded: Record<string, unknown>;
                      if (isV2Final) {
                        if (!finalRecord || finalRecord.schemaVersion !== 2) {
                          throw new Error("Final AI summary payload is invalid.");
                        }
                        const finalCards = parseSummaryCards(finalRecord.cards);
                        if (!finalCards) throw new Error("Final AI summary cards are invalid.");
                        if (finalCards.some((card) => card.analysisStatus === "pending")
                          || finalCards.every((card) => card.analysisStatus !== "ready")) {
                          throw new Error("Final AI summary cards contain no usable interpretation.");
                        }
                        markSummaryContractV2();
                        writeSummaryCards(finalCards);
                        decoded = finalRecord;
                      } else {
                        const normalizedJson = normalizeAiSummaryFinalJson(fullText.trim());
                        if (!normalizedJson) throw new Error("Final AI summary payload is invalid.");
                        decoded = JSON.parse(normalizedJson) as Record<string, unknown>;
                      }
                      const finalData: DebateData = {
                        debateIssues: Array.isArray(decoded.debateIssues) ? decoded.debateIssues as DebateIssue[] : undefined,
                        finalVerdict: typeof decoded.finalVerdict === "string" ? decoded.finalVerdict : undefined,
                        actionItems: Array.isArray(decoded.actionItems) ? decoded.actionItems as ActionItem[] : undefined,
                        weaknessDiagnostic: typeof decoded.weaknessDiagnostic === "string" ? decoded.weaknessDiagnostic : undefined,
                        signature: typeof decoded.signature === "string" ? decoded.signature : undefined,
                        signatureSub: typeof decoded.signatureSub === "string" ? decoded.signatureSub : undefined,
                        // Final JSON never owns visuals. Keep the server
                        // snapshot captured from the dedicated visuals
                        // record, even if a provider attempted to inject one.
                        visuals: routeOwnedVisuals,
                      };
                      dataIdentityRef.current = requestedIdentity;
                      setDebateData((previous) => ({
                        ...finalData,
                        visuals: routeOwnedVisuals ?? previous?.visuals,
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
                    } catch (parseError) {
                      console.error("[AI-SUMMARY] Final result parse failed:", parseError);
                      clearPartialStreamState();
                      const parseRequestError = new AiSummaryRequestError("분석 결과 데이터 처리에 실패했습니다.", {
                        errorCode: "PUBG_AI_INVALID_FINAL",
                        retryable: true,
                      });
                      if (!scheduleRetry("분석 결과가 불완전해요. 자동으로 재시도 중이에요.")) {
                        retryCountRef.current = 0;
                        setError(parseRequestError);
                      }

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

            if (done) {
              if (canWriteRequest() && !sawTerminalRecord) {
                clearPartialStreamState();
                throw new AiSummaryRequestError("분석 스트림이 완료 신호 없이 종료되었습니다.", {
                  errorCode: "PUBG_AI_STREAM_EOF",
                  retryable: true,
                });
              }
              break;
            }
          }
        } catch (readError) {
          if (readError instanceof Error && readError.name === 'AbortError') {
            // 사용자가 페이지를 이탈하거나 안전 타임아웃이 동작한 정상 중단입니다.
          } else {
            throw readError;
          }
        } finally {
          clearInterval(updateInterval);
          if (canWriteRequest()) setStreamingText(textBufferRef.current);
          if (readerRef.current === reader) readerRef.current = null;
        }
      } else {
        clearInterval(updateInterval);
        if (canWriteRequest()) {
          throw new AiSummaryRequestError("분석 스트림을 시작하지 못했습니다.", {
            errorCode: "PUBG_AI_STREAM_EOF",
            retryable: true,
          });
        }
      }

    } catch (err) {
      if (canWriteRequest() && (!(err instanceof Error) || err.name !== 'AbortError')) {
        console.error("[AI-SUMMARY] Critical Error:", err);
        const errMsg = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
        
        // GA4 이벤트 트래킹: 10경기 요약 실패
        trackEvent({
          name: "feature_consumption",
          params: {
            feature_name: "ai-coaching",
            status: "fail",
            error_type: errMsg
          }
        });

        const requestError = err instanceof AiSummaryRequestError ? err : null;
        const canonicalNotReady = requestError?.status === 409
          && requestError.errorCode === "PUBG_AI_CANONICAL_NOT_READY"
          && requestError.retryable;
        const shouldRetry = requestError?.retryable === true || isTransientError(errMsg);
        if (!shouldRetry || !scheduleRetry(
          canonicalNotReady
            ? "매치 분석 데이터가 아직 준비되지 않았어요. 자동으로 재시도 중이에요."
            : "AI 서버가 잠깐 바빴어요. 자동으로 재시도 중이에요.",
        )) {
          retryCountRef.current = 0;
          setError(requestError ?? new AiSummaryRequestError("AI 분석 중 오류가 발생했어요. 다시 시도해주세요."));
        }
      }
    } finally {
      clearTimeout(safetyTimeout);
      if (ownsRequest()) {
        requestOwnerRef.current = null;
        setLoading(false);
        isLoadingRef.current = false;
        if (abortControllerRef.current === abortController) abortControllerRef.current = null;
        aiManager.stopAnalysis("summary");
      }
    }
  };

  const issueViews = (summaryContractVersion === 2 ? [] : debateData?.debateIssues ?? []).map((issue) => {
    const pairs = matchDebateStatPairs(issue.userStats, issue.benchmarkStats);
    const winner = pairs.length > 0 ? issue.winner : null;
    return { issue, pairs, winner };
  });
  const summaryCardViews = (summaryCards ?? []).map((card) => {
    const winner = card.dataStatus === "comparable"
      && card.analysisStatus === "ready"
      && (card.winner === "kind" || card.winner === "spicy")
      ? card.winner
      : null;
    const evidenceById = new Map(card.evidence.map((evidence) => [evidence.id, evidence]));
    const referencedIds = new Set<string>();
    const referencedEvidence = card.evidenceIds.flatMap((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) return [];
      referencedIds.add(evidence.id);
      return [evidence];
    });
    // Unavailable records have no valid evidence ID by contract, but they are
    // still factual rows and must remain visible after observed references.
    const remainingEvidence = card.evidence.filter((evidence) => !referencedIds.has(evidence.id));
    return { card, winner, evidence: [...referencedEvidence, ...remainingEvidence] };
  });
  const score = (summaryContractVersion === 2
    ? summaryCardViews
    : issueViews).reduce(
    (scoreMap, { winner }) => {
      if (winner === "kind") scoreMap.kind++;
      else if (winner === "spicy") scoreMap.spicy++;
      else if (winner === "draw") scoreMap.draw++;
      else scoreMap.pending++;
      return scoreMap;
    },
    { kind: 0, spicy: 0, draw: 0, pending: 0 },
  );

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showTierTooltip) {
        restoreTierFocusRef.current = true;
        setShowTierTooltip(false);
        tierTriggerRef.current?.focus();
      }
      if (activeStatTooltip) setActiveStatTooltip(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showTierTooltip, activeStatTooltip, isMobile]);

  useEffect(() => {
    identityRef.current = identity;
    setRenderIdentity(identity);
    generationRef.current += 1;
    dataIdentityRef.current = null;
    setDebateData(null);
    summaryContractVersionRef.current = null;
    writeSummaryCards(null);
    setSummaryContractVersion(null);
    setStreamingText("");
    setLoading(false);
    setError(null);
    setRetryMessage(null);
    isLoadingRef.current = false;
    textBufferRef.current = "";
    lineBufferRef.current = "";
    const resetSignature = `${identity}\u001enull`;
    if (emittedSummaryRef.current !== resetSignature) {
      emittedSummaryRef.current = resetSignature;
      onSummaryChangeRef.current?.(null);
    }

    return () => {
      generationRef.current += 1;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const owner = requestOwnerRef.current;
      requestOwnerRef.current = null;
      readerRef.current?.cancel().catch(() => {});
      readerRef.current = null;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      isLoadingRef.current = false;
      if (owner) aiManager.stopAnalysis("summary");
    };
  }, [identity]);

  const summaryVerdict = typeof debateData?.finalVerdict === "string"
    ? debateData.finalVerdict.trim()
    : "";
  const summaryTier = typeof debateData?.visuals?.overallTier === "string"
    ? debateData.visuals.overallTier.trim()
    : "";

  useEffect(() => {
    if (!summaryVerdict || dataIdentityRef.current !== identity) return;
    const signature = `${identity}\u001e${summaryVerdict}\u001e${summaryTier}`;
    if (emittedSummaryRef.current === signature) return;
    emittedSummaryRef.current = signature;
    onSummaryChangeRef.current?.({
      verdict: summaryVerdict,
      ...(summaryTier ? { tier: summaryTier } : {}),
    });
  }, [identity, summaryTier, summaryVerdict]);

  // Hide the previous selection during the render before its reset effect.
  if (renderIdentity !== identity) return null;

  // [AUTO-RETRY] 재시도 중 메시지 표시
  if (retryMessage && !summaryCards) {
    return (
      <div className="p-8 bg-white/5 rounded-3xl border border-white/10 text-center">
        <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-indigo-300 text-sm font-medium">{retryMessage}</p>
        <p className="text-gray-600 text-xs mt-2">잠시만 기다려주세요</p>
      </div>
    );
  }

  const retrySummary = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryCountRef.current = 0;
    dataIdentityRef.current = null;
    setError(null);
    if (summaryContractVersionRef.current !== 2) setDebateData(null);
    textBufferRef.current = "";
    lineBufferRef.current = "";
    void handleFetchSummary(true);
  };

  if (error && !summaryCards) {
    return (
      <div className="p-6 bg-white/5 border border-white/10 rounded-2xl text-center">
        <BgmsIcon name="info" size={28} className="mx-auto mb-3 text-indigo-300" />
        <p className="text-gray-300 text-sm mb-1">AI 분석이 잠깐 막혔어요.</p>
        <p className="text-gray-500 text-xs mb-4">서버가 바쁘거나 네트워크가 불안정할 때 가끔 생겨요.</p>
        <button
          onClick={retrySummary}
          className="px-5 py-2 bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 rounded-xl text-sm hover:bg-indigo-500/30 transition-colors"
        >
          다시 시도하기
        </button>
      </div>
    );
  }

  if (!debateData && !summaryCards && !loading) {
    //  비로그인 유저에게는 로그인 유도 CTA 표시
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
              <span>최근 최대 10경기 AI 끝장 토론 시작</span>
              <span className="text-xs font-normal opacity-60">최근 유효 {latestMatchRangeLabel}은 전체 흐름에, 잘한 {bestMatchRangeLabel}은 잠재 티어와 비슷한 조건의 평균 비교에 사용합니다.</span>
            </div>
          </>
        )}
      </button>
    );
  }

  // [V46.5] 로딩 중이지만 이미 데이터가 있는 경우(갱신 중)에는 전체 화면 스피너를 보여주지 않음 (Partial Loading)
  if (loading && !debateData && !summaryCards) {
    return (
      <div className="p-12 bg-white/5 rounded-3xl border border-white/10 text-center">
        <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mx-auto mb-6" />
        <p className="text-gray-400 animate-pulse text-sm">AI 분석 엔진이 최근 유효 {latestMatchRangeLabel} 전체와 점수 상위 {bestMatchRangeLabel}를 확인 중입니다...</p>
      </div>
    );
  }

  const parseRate = (s: string | undefined) => {
    if (!s) return 0;
    const n = parseInt(s);
    return isNaN(n) ? 0 : n;
  };

  const renderSummaryCard = ({
    card,
    winner,
    evidence,
  }: {
    card: SummaryCard;
    winner: "kind" | "spicy" | null;
    evidence: SummaryEvidence[];
  }, idx: number) => {
    const interpretationPending = card.analysisStatus === "pending" && loading && !error && !retryMessage;
    const interpretationReady = card.analysisStatus === "ready";
    const interpretationStatus = interpretationReady
      ? "ready"
      : interpretationPending ? "pending" : "unavailable";
    const interpretationText = interpretationStatus === "pending"
      ? "AI 해석 준비 중"
      : interpretationStatus === "unavailable"
        ? "AI 해석을 표시할 수 없습니다."
        : null;
    const renderEvidenceRow = (row: SummaryEvidence, rowIdx: number) => {
      if (row.status === "comparable" && row.userValue !== null && row.benchmarkValue !== null) {
        return (
          <div key={row.id || rowIdx} className="grid grid-cols-11 items-center gap-2 p-4 bg-white/5 rounded-xl border border-white/5 group hover:bg-white/10 transition-colors">
            <div className="col-span-4 text-right">
              <div className="text-lg md:text-xl font-black text-indigo-400">{row.userValue}</div>
              <div className="text-[9px] text-gray-500 font-bold uppercase">{row.label}</div>
            </div>
            <div className="col-span-3 flex flex-col items-center justify-center gap-1">
              <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-[10px] font-black text-white/20 group-hover:text-white/40 border border-white/10">VS</div>
            </div>
            <div className="col-span-4 text-left">
              <div className="text-lg md:text-xl font-black text-gray-400">{row.benchmarkValue}</div>
              <div className="text-[9px] text-gray-500 font-bold uppercase">{neutralBenchmarkLabel(row.benchmarkLabel, {
                gameMode: card.context.gameMode, matchType: card.context.matchType, tier: card.context.tier ?? undefined,
              })}</div>
              <div className="text-[9px] text-gray-500">내 {card.context.userMatchCount}경기 · 비교 표본 {row.sampleCount}건</div>
            </div>
          </div>
        );
      }

      if (row.status === "user_only" && row.userValue !== null) {
        return (
          <div key={row.id || rowIdx} className="grid grid-cols-11 items-center gap-2 p-4 bg-white/5 rounded-xl border border-white/5 group hover:bg-white/10 transition-colors">
            <div className="col-span-5 text-right">
              <div className="text-lg md:text-xl font-black text-indigo-400">{row.userValue}</div>
              <div className="text-[9px] text-gray-500 font-bold uppercase">{row.label} · 내 기록</div>
            </div>
            <div className="col-span-2 flex items-center justify-center">
              <span className="text-[10px] font-black text-gray-500 text-center">비교 자료 없음</span>
            </div>
            <div className="col-span-4 text-left">
              <div className="text-sm font-bold text-gray-500">비교 자료 없음</div>
            </div>
          </div>
        );
      }

      return (
        <div key={row.id || rowIdx} className="flex flex-col gap-2 p-4 bg-white/5 rounded-xl border border-white/5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="shrink-0 text-sm font-bold text-gray-400">{row.label}</div>
          <div className="min-w-0 break-keep text-sm font-black text-gray-500">{row.unavailableReason || "측정 불가"}</div>
        </div>
      );
    };

    return (
      <div key={card.topicId || idx} className="bg-white/5 border border-white/10 rounded-3xl overflow-hidden transition-all hover:border-white/20">
        <button
          onClick={() => setOpenIssueIdx(openIssueIdx === idx ? null : idx)}
          className="w-full p-6 flex justify-between items-center text-left group"
        >
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[10px] text-indigo-400 font-black uppercase tracking-widest">{card.topic || "분석 항목"}</span>
            <h4 className="text-lg font-black text-white group-hover:text-indigo-300 transition-colors break-words">{card.question || "분석 내용 로드 중..."}</h4>
          </div>
          <div className="flex items-center gap-4 shrink-0 ml-4">
            <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter ${winner === "spicy" ? "bg-red-500/20 text-red-400 border border-red-500/30" :
              winner === "kind" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
                "bg-gray-500/20 text-gray-300 border border-gray-500/30"
              }`}>
              {winner === "spicy" ? "매운맛 승" : winner === "kind" ? "착한맛 승" : "판정 보류"}
            </div>
            <svg className={`w-6 h-6 text-white/50 transition-transform ${openIssueIdx === idx ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
          </div>
        </button>

        {openIssueIdx === idx && (
          <div className="px-6 pb-6 animate-in slide-in-from-top-4 duration-300">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={`p-5 rounded-2xl border transition-all ${winner === "kind" ? "bg-green-500/5 border-green-500/30 ring-1 ring-green-500/20" : "bg-black/30 border-white/10"}`}>
                <div className="flex items-center gap-2 mb-3">
                  <BgmsIcon name="shield" size={18} className="text-green-400" />
                  <span className="text-xs font-black text-green-400 uppercase">착한맛 코치</span>
                </div>
                {interpretationReady ? (
                  <p className="text-sm text-gray-300 leading-relaxed font-medium">&quot;{card.kindOpinion || "의견을 표시할 수 없습니다."}&quot;</p>
                ) : (
                  <p className="text-sm text-gray-400 leading-relaxed font-medium">{interpretationText}</p>
                )}
              </div>

              <div className={`p-5 rounded-2xl border transition-all ${winner === "spicy" ? "bg-red-500/5 border-red-500/30 ring-1 ring-red-500/20" : "bg-black/30 border-white/10"}`}>
                <div className="flex items-center gap-2 mb-3">
                  <BgmsIcon name="zap" size={18} className="text-red-400" />
                  <span className="text-xs font-black text-red-400 uppercase">매운맛 폭격기</span>
                </div>
                {interpretationReady ? (
                  <p className="text-sm text-gray-300 leading-relaxed font-medium">&quot;{card.spicyOpinion || "의견을 표시할 수 없습니다."}&quot;</p>
                ) : (
                  <p className="text-sm text-gray-400 leading-relaxed font-medium">{interpretationText}</p>
                )}
              </div>
            </div>

            {(interpretationStatus === "unavailable" && card.analysisReason) && (
              <p className="mt-3 text-xs text-gray-500 text-center md:text-left">{card.analysisReason}</p>
            )}

            <div className="mt-8 p-6 bg-black/40 rounded-2xl border border-white/5">
              <div className="flex flex-col gap-1 text-center md:text-left mb-8">
                <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">데이터 증거 (전술적 증거)</span>
                <span className="text-lg font-black text-white">{card.topic || "데이터"} 상세 비교</span>
              </div>
              <div className="space-y-4">
                {evidence.length > 0
                  ? evidence.map(renderEvidenceRow)
                  : <p className="px-4 py-6 text-center text-sm font-medium leading-relaxed text-gray-400">이 항목의 비교 근거를 표시할 수 없습니다.</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full flex flex-col gap-6">
      {summaryCards && retryMessage && (
        <div className="p-5 bg-indigo-500/5 border border-indigo-500/20 rounded-2xl text-center">
          <div className="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-indigo-300 text-sm font-medium">{retryMessage}</p>
          <p className="text-gray-600 text-xs mt-2">확인된 데이터는 계속 표시됩니다.</p>
        </div>
      )}
      {summaryCards && error && !retryMessage && (
        <div role="alert" className="p-5 bg-white/5 border border-white/10 rounded-2xl text-center">
          <p className="text-gray-300 text-sm mb-1">AI 해석을 표시할 수 없습니다.</p>
          <p className="text-gray-500 text-xs mb-4">확인된 데이터는 아래에 표시됩니다. 잠시 후 다시 시도해주세요.</p>
          <button
            onClick={retrySummary}
            className="px-5 py-2 bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 rounded-xl text-sm hover:bg-indigo-500/30 transition-colors"
          >
            다시 시도하기
          </button>
        </div>
      )}
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
                    최근 유효 {latestMatchRangeLabel} 중 점수 상위 {bestMatchRangeLabel} 잠재력
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
                <span className="text-[10px] text-white/30 font-black uppercase tracking-[0.2em] mb-1">점수 상위 {bestMatchRangeLabel} 잠재 티어</span>
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
                &quot;{debateData?.finalVerdict || (summaryCards
                  ? loading ? "AI 해석 준비 중" : "AI 해석을 표시할 수 없습니다."
                  : "분석 결과를 생성 중입니다...")}&quot;
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
        {(debateData?.visuals?.tactical?.isolation || (loading && !debateData && !summaryCards)) && (
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
        {!summaryCards && !debateData?.debateIssues && (loading || streamingText) && (
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
                    if (len < 500) return `최근 ${latestMatchCount}경기의 전투 로그를 복기하는 중...`;
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

        {/* [V2.1] 서버가 산정한 잠재 티어 3축 레이더 차트 */}
        {debateData?.visuals?.tierBreakdown && (
          <SpiderChart
            nickname={nickname}
            bestMatchCount={debateData.visuals.bestMatchCount}
            data={{
              combat: debateData.visuals.tierBreakdown.combat,
              tactical: debateData.visuals.tierBreakdown.tactical,
              survival: debateData.visuals.tierBreakdown.survival,
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
        {score.pending > 0 && (
          <p className="-mt-4 px-4 text-center text-xs font-bold leading-relaxed text-gray-400">
            근거 확인이 필요한 {score.pending}개 항목은 판정을 보류했습니다.
          </p>
        )}

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
                    <span className="text-[12px] font-black text-white tracking-widest uppercase">점수 상위 {bestMatchRangeLabel} {(debateData.visuals.overallTier || 'B')} 잠재 티어</span>
                  </div>

                  {/* [V38.2] 티어 세부 점수 툴팁 */}
                  {debateData.visuals.tierBreakdown && (
                    <div
                      className="relative"
                      ref={tooltipRef}
                      onMouseEnter={() => !isMobile && setShowTierTooltip(true)}
                      onMouseLeave={() => !isMobile && setShowTierTooltip(false)}
                    >
                      <button
                        type="button"
                        ref={tierTriggerRef}
                        aria-label={`점수 상위 ${bestMatchRangeLabel} 잠재 티어 산정 방법 보기`}
                        aria-expanded={showTierTooltip}
                        aria-controls={TIER_TOOLTIP_ID}
                        aria-describedby={showTierTooltip ? TIER_TOOLTIP_ID : undefined}
                        onPointerDown={() => { tierTriggerPointerRef.current = true; }}
                        onClick={() => {
                          tierTriggerPointerRef.current = false;
                          if (isMobile) setShowTierTooltip((visible) => !visible);
                        }}
                        onFocus={() => {
                          if (restoreTierFocusRef.current) {
                            restoreTierFocusRef.current = false;
                            return;
                          }
                          if (tierTriggerPointerRef.current) {
                            tierTriggerPointerRef.current = false;
                            return;
                          }
                          setShowTierTooltip(true);
                        }}
                        onBlur={(event) => {
                          const nextTarget = event.relatedTarget;
                          if (!(nextTarget instanceof Node) || !tooltipRef.current?.contains(nextTarget)) {
                            setShowTierTooltip(false);
                          }
                        }}
                        className="flex items-center justify-center p-1 focus:outline-none"
                      >
                        <HelpCircle size={16} className={`${showTierTooltip ? 'text-white' : 'text-white/30'} hover:text-white/60 cursor-help transition-colors`} />
                      </button>

                      {showTierTooltip && (
                        <div
                          id={TIER_TOOLTIP_ID}
                          role={isMobile ? "dialog" : "tooltip"}
                          aria-modal={isMobile ? "true" : undefined}
                          aria-label={isMobile ? "잠재 티어 산정 방법" : undefined}
                          className={`${isMobile
                            ? 'fixed inset-x-4 bottom-20 animate-in slide-in-from-bottom-5'
                            : 'absolute left-full ml-3 top-1/2 -translate-y-1/2 w-48 animate-in fade-in zoom-in-95'
                            } p-4 bg-black/95 border border-white/20 rounded-2xl backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.8)] z-[100] duration-200`}
                        >
                          <div className="flex justify-between items-center mb-3 pb-2 border-b border-white/10">
                            <div className="text-[11px] text-white/50 font-black uppercase tracking-wider">점수 상위 {bestMatchRangeLabel} 잠재 티어 분석</div>
                            {isMobile && (
                              <button
                                type="button"
                                aria-label="잠재 티어 산정 방법 닫기"
                                onClick={() => setShowTierTooltip(false)}
                                className="text-white/40"
                              >
                                <X size={14} />
                              </button>
                            )}
                          </div>
                          <div className="mb-3 text-[10px] text-white/50 leading-relaxed">
                            최근 유효 {latestMatchRangeLabel} 중 점수가 높은 {bestMatchRangeLabel}을 골라 교전·전술·생존 점수로 계산합니다.
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
                              <span className="text-[11px] text-white font-black uppercase">잠재 점수</span>
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
                자기장 누적 피해: {formatBluezoneWaste(debateData?.visuals?.bluezoneWaste)}
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



        {debateData?.visuals && <div className="grid grid-cols-2 md:grid-cols-3 gap-4">

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
            <div className="text-[9px] text-gray-500 font-medium">최근 {latestMatchCount}경기 평균 생존 구간</div>
          </div>
        </div>

        }
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
                <span className="text-white font-black">{latestMatchCount}경기 전술 마스터리</span>
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
                  <div className="text-[9px] text-gray-500 font-bold mt-1">{latestMatchCount}경기 합계</div>
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
          {summaryContractVersion === 2
            ? summaryCardViews.map((cardView, idx) => renderSummaryCard(cardView, idx))
            : issueViews.map(({ issue, pairs, winner }, idx) => (
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
                  <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter ${winner === "spicy" ? "bg-red-500/20 text-red-400 border border-red-500/30" :
                    winner === "kind" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
                      winner === "draw" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" :
                        "bg-gray-500/20 text-gray-300 border border-gray-500/30"
                    }`}>
                    {winner === "spicy" ? "매운맛 승" : winner === "kind" ? "착한맛 승" : winner === "draw" ? "무승부" : "판정 보류"}
                  </div>
                  <svg className={`w-6 h-6 text-white/50 transition-transform ${openIssueIdx === idx ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                </div>
              </button>

              {openIssueIdx === idx && (
                <div className="px-6 pb-6 animate-in slide-in-from-top-4 duration-300">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={`p-5 rounded-2xl border transition-all ${winner === "kind" ? "bg-green-500/5 border-green-500/30 ring-1 ring-green-500/20" : "bg-black/30 border-white/10"}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <BgmsIcon name="shield" size={18} className="text-green-400" />
                        <span className="text-xs font-black text-green-400 uppercase">착한맛 코치</span>
                      </div>
                      <p className="text-sm text-gray-300 leading-relaxed font-medium">&quot;{issue?.kindOpinion || "의견을 가져오는 중..."}&quot;</p>
                    </div>

                    <div className={`p-5 rounded-2xl border transition-all ${winner === "spicy" ? "bg-red-500/5 border-red-500/30 ring-1 ring-red-500/20" : "bg-black/30 border-white/10"}`}>
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
                      {pairs.length > 0 ? pairs.map(({ user: uStat, benchmark: bStat }, sIdx) => {
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
                              <div className="text-[9px] text-gray-500 font-bold uppercase">{neutralBenchmarkLabel(bStat?.label || uStat.label, debateData?.visuals?.benchmarkScope)}</div>
                            </div>
                          </div>
                        );
                      }) : (
                        <p className="px-4 py-6 text-center text-sm font-medium leading-relaxed text-gray-400">
                          이 항목의 비교 근거를 표시할 수 없습니다.
                        </p>
                      )}
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
