"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import type { PlayerMatchRecord } from "@/lib/pubg/playerMatches";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { normalizeRecentMatchIds } from "@/lib/pubg/recentMatches";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { parseStatsPlatform } from "@/lib/stats/statsPageModel";
import type {
  PlayerStatsResponse,
  StatsErrorType,
  StatsHistoryStatus,
  StatsMatchFilter,
  StatsMatchModeMeta,
  StatsMode,
  StatsModeAvailability,
  StatsPageStatus,
  StatsPartialReason,
  StatsPartySize,
  StatsPlatform,
  StatsSectionTab,
} from "@/types/stats-page";

const REFRESH_COOLDOWN_MS = 60_000;
const PERFORMANCE_POLL_INTERVAL_MS = 10_000;
const PERFORMANCE_MAX_POLLS = 6;
const PERFORMANCE_PENDING_STATES = new Set(["pending", "running", "retry"]);
const PARTIAL_REASONS: readonly StatsPartialReason[] = [
  "summary_batch_failed",
  "summary_missing",
  "detail_failed",
  "analysis_failed",
  "stats_stale",
  "stats_unavailable",
];
const STATS_MODES: readonly StatsMode[] = ["ranked", "normal"];

export interface UseStatsPageControllerOptions {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
}

export interface StatsSearchRequest {
  nickname?: string;
  platform?: StatsPlatform;
  seasonId?: string;
  forceRefresh?: boolean;
}

export interface StatsPageController {
  status: StatsPageStatus;
  result: PlayerStatsResponse | null;
  error: { type: StatsErrorType; message: string; retryAt?: number } | null;
  suggestedPlayers: readonly { nickname: string; platform: StatsPlatform }[];
  refreshAvailableAt?: number;
  isRefreshCoolingDown: boolean;
  partialReasons: readonly StatsPartialReason[];
  platform: StatsPlatform;
  nickname: string;
  seasonId: string;
  sectionTab: StatsSectionTab;
  groupKey?: string;
  statsMode: StatsMode;
  partySize: StatsPartySize;
  matchFilter: StatsMatchFilter;
  matchSummaries: Record<string, MatchSummaryData>;
  missingMatchIds: ReadonlySet<string>;
  matchModeMeta: Record<string, StatsMatchModeMeta>;
  summaryStatus: "idle" | "loading" | "ready" | "error";
  matchIds: readonly string[];
  historyStatus: StatsHistoryStatus;
  historyPage: number;
  historyTotalPages: number;
  historyTotalCount: number;
  setPlatform(value: StatsPlatform): void;
  setNickname(value: string): void;
  setSeasonId(value: string): void;
  setSectionTab(value: StatsSectionTab): void;
  setGroupKey(value?: string): void;
  setStatsMode(value: StatsMode): void;
  setPartySize(value: StatsPartySize): void;
  setMatchFilter(value: StatsMatchFilter): void;
  search(request?: StatsSearchRequest): Promise<PlayerStatsResponse | null>;
  refresh(): Promise<void>;
  retrySummaries(): Promise<void>;
  setHistoryPage(page: number): Promise<void>;
  retryHistory(): Promise<void>;
  onModeDetected(matchId: string, gameMode: string, matchType?: string, mapName?: string): void;
  reportPartial(reason: StatsPartialReason, sourceId: string): void;
  clearPartial(reason: StatsPartialReason, sourceId: string): void;
}

type ControllerError = StatsPageController["error"];
type PartialSources = Map<StatsPartialReason, Set<string>>;

function mergeModeMeta(primary: StatsMatchModeMeta | undefined, fallback?: StatsMatchModeMeta): StatsMatchModeMeta {
  const matchType = primary?.matchType;
  return {
    gameMode: primary?.gameMode || fallback?.gameMode,
    matchType: matchType && matchType.toLowerCase() !== "unknown" ? matchType : fallback?.matchType || matchType,
    mapName: primary?.mapName || fallback?.mapName,
  };
}

function emptyPartialSources(): PartialSources {
  return new Map(PARTIAL_REASONS.map((reason) => [reason, new Set<string>()]));
}

function normalizeSeason(value?: string): string {
  return value && value !== "null" && value !== "undefined" ? value : "";
}

function playerIdentity(platform: StatsPlatform, nickname: string, seasonId: string): string {
  return `${platform}:${nickname.trim().toLowerCase()}:${seasonId}`;
}

function requestIdentity(request: Required<StatsSearchRequest>): string {
  return `${playerIdentity(request.platform, request.nickname, request.seasonId)}:${request.forceRefresh}`;
}

function parseRetryAt(value: string | null, now: number): number {
  if (!value) return now + REFRESH_COOLDOWN_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.max(now, absolute) : now + REFRESH_COOLDOWN_MS;
}

function parseRetryAfterSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseStatsAvailability(value: unknown): Partial<Record<StatsMode, StatsModeAvailability>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed: Partial<Record<StatsMode, StatsModeAvailability>> = {};
  for (const mode of STATS_MODES) {
    const candidate = (value as Record<string, unknown>)[mode];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const status = (candidate as Record<string, unknown>).status;
    if (status !== "ready" && status !== "stale" && status !== "unavailable") continue;
    const updatedAt = (candidate as Record<string, unknown>).updatedAt;
    parsed[mode] = typeof updatedAt === "string" && updatedAt.trim()
      ? { status, updatedAt: updatedAt.trim() }
      : { status };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function isPlayerResponseForRequest(value: unknown, request: Required<StatsSearchRequest>): value is PlayerStatsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const responseNickname = typeof candidate.nickname === "string" ? normalizeName(candidate.nickname) : "";
  const responsePlatform = parseStatsPlatform(typeof candidate.platform === "string" ? candidate.platform : undefined);
  const responseSeason = typeof candidate.seasonId === "string" ? normalizeSeason(candidate.seasonId) : "";
  return Boolean(
    responseNickname
    && responseNickname === normalizeName(request.nickname)
    && responsePlatform === request.platform
    && candidate.stats
    && typeof candidate.stats === "object"
    && !Array.isArray(candidate.stats)
    && Array.isArray(candidate.recentMatches)
    && (!request.seasonId || responseSeason === request.seasonId),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function normalizeSuggestions(value: unknown): { nickname: string; platform: StatsPlatform }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const nickname = "nickname" in item && typeof item.nickname === "string" ? item.nickname : "";
    const platform = "platform" in item ? parseStatsPlatform(String(item.platform)) : null;
    return nickname && platform ? [{ nickname, platform }] : [];
  });
}

function normalizeMatchModes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [rawId, mode] of Object.entries(value)) {
    if (typeof mode !== "string") continue;
    const matchId = normalizeMatchId(rawId);
    if (matchId && !Object.prototype.hasOwnProperty.call(normalized, matchId)) {
      normalized[matchId] = mode;
    }
  }
  return normalized;
}

function normalizeHistoryRecords(records: readonly PlayerMatchRecord[]): PlayerMatchRecord[] {
  const seen = new Set<string>();
  return records.flatMap((record) => {
    const matchId = normalizeMatchId(record.match_id);
    if (!matchId || seen.has(matchId)) return [];
    seen.add(matchId);
    return [{ ...record, match_id: matchId }];
  });
}

function normalizeSummaryMap(value: unknown): Record<string, MatchSummaryData> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, MatchSummaryData> = {};
  for (const [rawId, summary] of Object.entries(value)) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) continue;
    const matchId = normalizeMatchId(rawId)
      ?? normalizeMatchId((summary as { matchId?: unknown }).matchId);
    if (!matchId || Object.prototype.hasOwnProperty.call(normalized, matchId)) continue;
    normalized[matchId] = { ...(summary as MatchSummaryData), matchId };
  }
  return normalized;
}

export function useStatsPageController(
  options: UseStatsPageControllerOptions,
): StatsPageController {
  const initialPlatform = parseStatsPlatform(options.initialPlatform) ?? "steam";
  const [baseStatus, setBaseStatus] = useState<StatsPageStatus>("idle");
  const [result, setResultState] = useState<PlayerStatsResponse | null>(null);
  const [error, setError] = useState<ControllerError>(null);
  const [suggestedPlayers, setSuggestedPlayers] = useState<
    { nickname: string; platform: StatsPlatform }[]
  >([]);
  const [refreshAvailableAt, setRefreshAvailableAtState] = useState<number>();
  const [isRefreshCoolingDown, setIsRefreshCoolingDown] = useState(false);
  const [partialSources, setPartialSources] = useState<PartialSources>(emptyPartialSources);
  const [platform, setPlatformState] = useState<StatsPlatform>(initialPlatform);
  const [nickname, setNicknameState] = useState(options.initialNickname ?? "");
  const [seasonId, setSeasonIdState] = useState("");
  const [sectionTab, setSectionTabState] = useState<StatsSectionTab>(options.initialTab ?? "overview");
  const [groupKey, setGroupKey] = useState<string | undefined>(options.initialGroupKey);
  const [statsMode, setStatsMode] = useState<StatsMode>("ranked");
  const [partySize, setPartySize] = useState<StatsPartySize>("squad");
  const [matchFilter, setMatchFilterState] = useState<StatsMatchFilter>("all");
  const [matchSummaries, setMatchSummaries] = useState<Record<string, MatchSummaryData>>({});
  const [missingMatchIds, setMissingMatchIds] = useState<ReadonlySet<string>>(new Set());
  const [matchModeMeta, setMatchModeMeta] = useState<Record<string, StatsMatchModeMeta>>({});
  const [summaryStatus, setSummaryStatus] = useState<StatsPageController["summaryStatus"]>("idle");
  const [historyMatches, setHistoryMatches] = useState<PlayerMatchRecord[]>([]);
  const [historyStatus, setHistoryStatus] = useState<StatsHistoryStatus>("idle");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyPage, setHistoryPageState] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(0);
  const [historyTotalCount, setHistoryTotalCount] = useState(0);
  const [historyResponseVersion, setHistoryResponseVersion] = useState(0);
  const [historyVisible, setHistoryVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  ));

  const platformRef = useRef(platform);
  const nicknameRef = useRef(nickname);
  const seasonIdRef = useRef(seasonId);
  const resultRef = useRef<PlayerStatsResponse | null>(null);
  const refreshAvailableAtRef = useRef<number | undefined>(undefined);
  const playerRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const playerRequestIdRef = useRef(0);
  const inFlightPromiseRef = useRef<{
    key: string;
    promise: Promise<PlayerStatsResponse | null>;
  } | null>(null);
  const summaryRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const summaryRequestIdRef = useRef(0);
  const historyRequestRef = useRef<AbortController | null>(null);
  const historyRequestIdRef = useRef(0);
  const historyPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyPollAttemptRef = useRef(0);
  const historyPollGenerationRef = useRef(0);
  const historyPageRef = useRef(1);
  const matchFilterRef = useRef<StatsMatchFilter>("all");
  const historySummaryIdsRef = useRef(new Set<string>());
  const rateLimitUntilRef = useRef(new Map<string, number>());
  const activeRouteKeyRef = useRef<string | null>(null);

  const setPlatform = useCallback((value: StatsPlatform) => {
    platformRef.current = value;
    setPlatformState(value);
  }, []);

  const setNickname = useCallback((value: string) => {
    nicknameRef.current = value;
    setNicknameState(value);
  }, []);

  const setSeasonId = useCallback((value: string) => {
    const normalized = normalizeSeason(value);
    seasonIdRef.current = normalized;
    setSeasonIdState(normalized);
  }, []);

  const setSectionTab = useCallback((value: StatsSectionTab) => {
    setSectionTabState(value);
  }, []);

  const setResult = useCallback((value: PlayerStatsResponse | null) => {
    resultRef.current = value;
    setResultState(value);
  }, []);

  const setRefreshAvailableAt = useCallback((value?: number) => {
    refreshAvailableAtRef.current = value;
    setRefreshAvailableAtState(value);
    setIsRefreshCoolingDown(Boolean(value && value > Date.now()));
  }, []);

  const reportPartial = useCallback((reason: StatsPartialReason, sourceId: string) => {
    if (!sourceId) return;
    setPartialSources((previous) => {
      const currentSources = previous.get(reason) ?? new Set<string>();
      if (currentSources.has(sourceId)) return previous;
      const next = new Map(previous);
      next.set(reason, new Set(currentSources).add(sourceId));
      return next;
    });
  }, []);

  const clearPartial = useCallback((reason: StatsPartialReason, sourceId: string) => {
    setPartialSources((previous) => {
      const currentSources = previous.get(reason);
      if (!currentSources?.has(sourceId)) return previous;
      const nextSources = new Set(currentSources);
      nextSources.delete(sourceId);
      const next = new Map(previous);
      next.set(reason, nextSources);
      return next;
    });
  }, []);

  const clearAllPartials = useCallback(() => {
    setPartialSources(emptyPartialSources());
  }, []);

  const cancelHistoryPolling = useCallback((resetAttempts = false) => {
    if (historyPollTimeoutRef.current) {
      clearTimeout(historyPollTimeoutRef.current);
      historyPollTimeoutRef.current = null;
    }
    historyPollGenerationRef.current += 1;
    if (resetAttempts) historyPollAttemptRef.current = 0;
  }, []);

  const applyStatsAvailability = useCallback((availability?: PlayerStatsResponse["statsAvailability"]) => {
    for (const mode of STATS_MODES) {
      const sourceId = `player-stats:${mode}`;
      const status = availability?.[mode]?.status;
      if (status === "stale") {
        reportPartial("stats_stale", sourceId);
        clearPartial("stats_unavailable", sourceId);
      } else if (status === "unavailable") {
        reportPartial("stats_unavailable", sourceId);
        clearPartial("stats_stale", sourceId);
      } else {
        clearPartial("stats_stale", sourceId);
        clearPartial("stats_unavailable", sourceId);
      }
    }
  }, [clearPartial, reportPartial]);

  const resetSummaryState = useCallback(() => {
    summaryRequestRef.current?.controller.abort();
    summaryRequestRef.current = null;
    historyRequestRef.current?.abort();
    historyRequestRef.current = null;
    historyRequestIdRef.current += 1;
    cancelHistoryPolling(true);
    historyPageRef.current = 1;
    historySummaryIdsRef.current.clear();
    setHistoryMatches([]);
    setHistoryStatus("idle");
    setHistoryLoaded(false);
    setHistoryPageState(1);
    setHistoryTotalPages(0);
    setHistoryTotalCount(0);
    setHistoryResponseVersion((version) => version + 1);
    setMatchSummaries({});
    setMissingMatchIds(new Set());
    setMatchModeMeta({});
    setSummaryStatus("idle");
  }, [cancelHistoryPolling]);

  const runSearch = useCallback((
    request: StatsSearchRequest = {},
    preserveRouteTab = false,
  ): Promise<PlayerStatsResponse | null> => {
    const resolved: Required<StatsSearchRequest> = {
      nickname: (request.nickname ?? nicknameRef.current).trim(),
      platform: request.platform ?? platformRef.current,
      seasonId: normalizeSeason(request.seasonId ?? seasonIdRef.current),
      forceRefresh: request.forceRefresh ?? false,
    };
    if (!resolved.nickname) return Promise.resolve(null);

    const key = requestIdentity(resolved);
    if (inFlightPromiseRef.current?.key === key) {
      return inFlightPromiseRef.current.promise;
    }
    if (inFlightPromiseRef.current && !preserveRouteTab) {
      return Promise.resolve(null);
    }

    const identity = playerIdentity(resolved.platform, resolved.nickname, resolved.seasonId);
    const currentResult = resultRef.current;
    const samePlayer = Boolean(
      currentResult
      && currentResult.platform === resolved.platform
      && currentResult.nickname.toLowerCase() === resolved.nickname.toLowerCase(),
    );
    const retryAt = rateLimitUntilRef.current.get(identity);
    if (retryAt && Date.now() < retryAt) {
      if (preserveRouteTab && currentResult && !samePlayer) {
        setResult(null);
        setRefreshAvailableAt(undefined);
        resetSummaryState();
        clearAllPartials();
      }
      setError({
        type: "rate_limit",
        message: "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요.",
        retryAt,
      });
      setBaseStatus("error");
      return Promise.resolve(null);
    }

    if (
      resolved.forceRefresh
      && resultRef.current
      && resultRef.current.platform === resolved.platform
      && resultRef.current.nickname.toLowerCase() === resolved.nickname.toLowerCase()
      && refreshAvailableAtRef.current
      && Date.now() < refreshAvailableAtRef.current
    ) {
      return Promise.resolve(null);
    }

    playerRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = ++playerRequestIdRef.current;
    playerRequestRef.current = { id: requestId, controller };

    const preserveResult = Boolean(
      samePlayer
      && (resolved.forceRefresh || resolved.seasonId !== currentResult?.seasonId),
    );

    setError(null);
    setSuggestedPlayers([]);
    clearAllPartials();
    if (preserveResult) {
      setBaseStatus("refreshing");
    } else {
      setBaseStatus("loading");
      setResult(null);
      setRefreshAvailableAt(undefined);
      resetSummaryState();
    }

    const stale = () => requestId !== playerRequestIdRef.current || controller.signal.aborted;
    const seasonQuery = resolved.seasonId
      ? `&season=${encodeURIComponent(resolved.seasonId)}`
      : "";
    const refreshQuery = resolved.forceRefresh ? "&refresh=true" : "";
    const url = `/api/pubg/player?nickname=${encodeURIComponent(resolved.nickname)}`
      + `&platform=${encodeURIComponent(resolved.platform)}`
      + seasonQuery
      + refreshQuery
      + `&_t=${Date.now()}`;

    const promise = (async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
          throw new Error(
            `서버 응답 지연이 발생했습니다. 잠시 후 다시 시도해 주세요. (HTTP ${response.status})`,
          );
        }
        const data = await response.json() as Record<string, unknown>;
        if (stale()) return null;

        const retryAfterSeconds = parseRetryAfterSeconds(data.retryAfterSeconds);
        if (retryAfterSeconds !== null) {
          setRefreshAvailableAt(Date.now() + retryAfterSeconds * 1000);
        }

        if (!response.ok) {
          if (stale()) return null;
          const message = typeof data.error === "string"
            ? data.error
            : `전적 서버 응답이 지연되거나 실패했습니다. 잠시 후 다시 시도해 주세요. (HTTP ${response.status})`;
          let nextError: Exclude<ControllerError, null>;
          if (response.status === 403 || data.code === "PLAYER_PRIVATE") {
            nextError = { type: "private", message: message || `${resolved.nickname}의 프로필은 비공개입니다.` };
          } else if (response.status === 404 || data.code === "PLAYER_NOT_FOUND") {
            nextError = { type: "not_found", message };
            setSuggestedPlayers(normalizeSuggestions(data.suggestions));
          } else if (response.status === 429) {
            const nextRetryAt = parseRetryAt(response.headers.get("Retry-After"), Date.now());
            rateLimitUntilRef.current.set(identity, nextRetryAt);
            nextError = { type: "rate_limit", message, retryAt: nextRetryAt };
          } else {
            nextError = { type: "server", message };
          }
          setError(nextError);
          setBaseStatus("error");
          trackEvent({
            name: "stats_searched",
            params: {
              nickname: resolved.nickname,
              platform: resolved.platform,
              has_data: false,
            },
          });
          return null;
        }

        if (stale()) return null;
        if (!isPlayerResponseForRequest(data, resolved)) {
          throw new Error("전적 서버 응답의 플레이어 또는 시즌 정보가 일치하지 않습니다.");
        }
        const availability = parseStatsAvailability(data.statsAvailability);
        const player = {
          ...data,
          recentMatches: normalizeRecentMatchIds(data.recentMatches as unknown[]),
          matchModes: normalizeMatchModes(data.matchModes),
          statsAvailability: availability,
          ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
        } as unknown as PlayerStatsResponse;
        const responsePlatform = parseStatsPlatform(player.platform) ?? resolved.platform;
        const responseSeason = normalizeSeason(player.seasonId);
        setResult(player);
        setPlatform(responsePlatform);
        setNickname("");
        setSeasonId(responseSeason);
        setSuggestedPlayers([]);
        applyStatsAvailability(availability);
        rateLimitUntilRef.current.delete(identity);
        const updatedAt = player.updatedAt ? Date.parse(player.updatedAt) : Number.NaN;
        if (retryAfterSeconds === null) {
          setRefreshAvailableAt(Number.isFinite(updatedAt) ? updatedAt + REFRESH_COOLDOWN_MS : undefined);
        }
        if (!preserveRouteTab) setSectionTab("overview");
        setBaseStatus("ready");
        trackEvent({
          name: "stats_searched",
          params: {
            nickname: player.nickname,
            platform: responsePlatform,
            has_data: true,
            season_id: responseSeason || undefined,
          },
        });
        return player;
      } catch (caught) {
        if (stale() || isAbortError(caught)) return null;
        const message = caught instanceof Error
          ? caught.message
          : "전적 서버 응답이 지연되거나 실패했습니다. 잠시 후 다시 시도해 주세요.";
        const isRateLimit = message.includes("429") || message.toLowerCase().includes("too many requests");
        const nextError: Exclude<ControllerError, null> = isRateLimit
          ? {
              type: "rate_limit",
              message: "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요.",
              retryAt: Date.now() + REFRESH_COOLDOWN_MS,
            }
          : { type: "server", message };
        if (nextError.retryAt) rateLimitUntilRef.current.set(identity, nextError.retryAt);
        setError(nextError);
        setBaseStatus("error");
        trackEvent({
          name: "stats_searched",
          params: {
            nickname: resolved.nickname,
            platform: resolved.platform,
            has_data: false,
          },
        });
        return null;
      } finally {
        if (requestId === playerRequestIdRef.current) {
          playerRequestRef.current = null;
          if (inFlightPromiseRef.current?.key === key) {
            inFlightPromiseRef.current = null;
          }
        }
      }
    })();
    inFlightPromiseRef.current = { key, promise };
    return promise;
  }, [
    clearAllPartials,
    resetSummaryState,
    setNickname,
    setPlatform,
    setRefreshAvailableAt,
    setResult,
    setSeasonId,
    setSectionTab,
    applyStatsAvailability,
  ]);

  const search = useCallback((request?: StatsSearchRequest) => (
    runSearch(request, false)
  ), [runSearch]);

  const applyHistoryRecords = useCallback((incoming: readonly PlayerMatchRecord[]) => {
    const normalizedIncoming = normalizeHistoryRecords(incoming);
    if (!normalizedIncoming.length) return;
    for (const record of normalizedIncoming) historySummaryIdsRef.current.add(record.match_id);
    const basicSummaries = Object.fromEntries(
      normalizedIncoming.map((record) => [record.match_id, buildBasicMatchSummary(record)]),
    );
    setMatchSummaries((previous) => ({ ...basicSummaries, ...previous }));
    setMissingMatchIds((previous) => {
      if (!previous.size) return previous;
      const next = new Set(previous);
      for (const record of normalizedIncoming) next.delete(record.match_id);
      return next;
    });
    setMatchModeMeta((previous) => {
      const next = { ...previous };
      for (const record of normalizedIncoming) {
        next[record.match_id] = mergeModeMeta(previous[record.match_id], {
          gameMode: record.game_mode,
          matchType: record.match_type,
          mapName: record.map_name,
        });
      }
      return next;
    });
  }, []);

  const loadHistoryPage = useCallback(async (
    player: PlayerStatsResponse,
    page: number,
    options: { isPoll?: boolean; filter?: StatsMatchFilter } = {},
  ): Promise<PlayerMatchRecord[] | null> => {
    const isPoll = options.isPoll === true;
    if (!isPoll) {
      cancelHistoryPolling(true);
      historyPageRef.current = Math.max(1, Math.floor(page));
    }
    historyRequestRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++historyRequestIdRef.current;
    historyRequestRef.current = controller;
    setHistoryStatus("loading");
    const stale = () => controller.signal.aborted || requestId !== historyRequestIdRef.current;

    try {
      const params = new URLSearchParams({
        nickname: player.nickname,
        platform: player.platform,
        page: String(Math.max(1, Math.floor(page))),
        filter: options.filter ?? matchFilterRef.current,
      });
      const response = await fetch(`/api/pubg/player/matches?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json() as {
        matches?: PlayerMatchRecord[];
        performances?: Record<string, MatchSummaryData["benchmark"]>;
        performanceStates?: Record<string, MatchSummaryData["performanceState"]>;
        page?: number;
        totalCount?: number;
        totalPages?: number;
      };
      if (!response.ok) throw new Error("전체 전적을 불러오지 못했습니다.");
      if (stale()) return null;

      const incoming = Array.isArray(data.matches)
        ? normalizeHistoryRecords(data.matches)
        : [];
      applyHistoryRecords(incoming);
      if (data.performances) {
        const scored = normalizeSummaryMap(Object.fromEntries(incoming.filter(r => data.performances?.[r.match_id]).map(r => [r.match_id, { ...buildBasicMatchSummary(r), benchmark: data.performances?.[r.match_id], performanceOnly: true }])));
        setMatchSummaries(previous => ({ ...scored, ...previous, ...Object.fromEntries(Object.entries(scored).filter(([id]) => !previous[id]?.benchmark)) }));
      }
      if (data.performanceStates) setMatchSummaries(previous => Object.fromEntries(Object.entries(previous).map(([id, summary]) => [id, data.performanceStates?.[id] ? { ...summary, performanceState: data.performanceStates[id] } : summary])));
      setHistoryMatches(incoming);
      setHistoryLoaded(true);
      const resolvedPage = data.page && data.page > 0 ? data.page : page;
      historyPageRef.current = resolvedPage;
      setHistoryPageState(resolvedPage);
      setHistoryTotalPages(Math.max(0, data.totalPages ?? 0));
      setHistoryTotalCount(Math.max(0, data.totalCount ?? 0));
      setHistoryResponseVersion((version) => version + 1);
      setHistoryStatus("ready");
      return incoming;
    } catch (caught) {
      if (stale() || isAbortError(caught)) return null;
      setHistoryStatus("error");
      setHistoryResponseVersion((version) => version + 1);
      return null;
    } finally {
      if (historyRequestRef.current === controller) historyRequestRef.current = null;
    }
  }, [applyHistoryRecords, cancelHistoryPolling]);

  const loadSummaries = useCallback((player: PlayerStatsResponse): Promise<readonly string[]> => {
    const matchIds = normalizeRecentMatchIds(player.recentMatches);
    summaryRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = ++summaryRequestIdRef.current;
    summaryRequestRef.current = { id: requestId, controller };
    clearPartial("summary_batch_failed", "summary-batch");
    clearPartial("summary_missing", "summary-batch");

    if (!matchIds.length) {
      setMatchSummaries({});
      setMissingMatchIds(new Set());
      setMatchModeMeta({});
      setSummaryStatus("idle");
      return Promise.resolve([]);
    }

    setSummaryStatus("loading");
    const stale = () => requestId !== summaryRequestIdRef.current || controller.signal.aborted;
    return (async () => {
      try {
        const response = await fetch("/api/pubg/matches-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matchIds,
            nickname: player.nickname,
            platform: player.platform,
          }),
          signal: controller.signal,
        });
        const data = await response.json() as {
          summaries?: Record<string, MatchSummaryData>;
          missingMatchIds?: string[];
        };
        if (stale()) return [];
        if (!response.ok) throw new Error("최근 매치 요약을 불러오지 못했습니다.");

        const summaries = normalizeSummaryMap(data.summaries);
        const missingIds = new Set(
          normalizeRecentMatchIds(data.missingMatchIds ?? [])
            .filter((id) => !historySummaryIdsRef.current.has(id)),
        );
        const nextModeMeta: Record<string, StatsMatchModeMeta> = {};
        for (const [rawMatchId, gameMode] of Object.entries(player.matchModes ?? {})) {
          const matchId = normalizeMatchId(rawMatchId);
          if (matchId) nextModeMeta[matchId] = { gameMode };
        }
        for (const [matchId, summary] of Object.entries(summaries)) {
          const matchInfo = summary.matchInfo as { mode?: string; matchType?: string; mapId?: string } | undefined;
          nextModeMeta[matchId] = {
            gameMode: summary.gameMode || matchInfo?.mode || nextModeMeta[matchId]?.gameMode,
            matchType: summary.matchType || matchInfo?.matchType,
            mapName: summary.mapName || summary.mapId || matchInfo?.mapId,
          };
        }
        setMatchSummaries((previous) => ({ ...previous, ...summaries }));
        setMissingMatchIds(missingIds);
        setMatchModeMeta((previous) => {
          const next = { ...previous };
          for (const [id, meta] of Object.entries(nextModeMeta)) next[id] = mergeModeMeta(meta, previous[id]);
          return next;
        });
        setSummaryStatus("ready");
        clearPartial("summary_batch_failed", "summary-batch");
        if (missingIds.size) reportPartial("summary_missing", "summary-batch");
        else clearPartial("summary_missing", "summary-batch");
        return Object.keys(summaries);
      } catch (caught) {
        if (stale() || isAbortError(caught)) return [];
        setSummaryStatus("error");
        reportPartial("summary_batch_failed", "summary-batch");
        return [];
      }
    })();
  }, [clearPartial, reportPartial]);

  const setHistoryPage = useCallback(async (page: number) => {
    const player = resultRef.current;
    if (!player || historyStatus === "loading") return;
    if (page < 1 || (historyTotalPages > 0 && page > historyTotalPages)) return;
    if (page === historyPage && historyLoaded) return;
    await loadHistoryPage(player, page);
  }, [historyLoaded, historyPage, historyStatus, historyTotalPages, loadHistoryPage]);

  const setMatchFilter = useCallback((value: StatsMatchFilter) => {
    if (matchFilterRef.current === value) return;
    matchFilterRef.current = value;
    setMatchFilterState(value);
    const player = resultRef.current;
    if (player) void loadHistoryPage(player, 1, { filter: value });
  }, [loadHistoryPage]);

  const retryHistory = useCallback(async () => {
    const player = resultRef.current;
    if (!player || historyStatus === "loading") return;
    await loadHistoryPage(player, historyPage);
  }, [historyPage, historyStatus, loadHistoryPage]);

  const loadRecentRecords = useCallback(async (player: PlayerStatsResponse) => {
    // Publish each response independently so basic records never wait for analysis.
    const history = loadHistoryPage(player, 1);
    const historyRequestId = historyRequestIdRef.current;
    const [records, summaryIds] = await Promise.all([history, loadSummaries(player)]);
    if (resultRef.current !== player || historyRequestId !== historyRequestIdRef.current || !records) return;
    const storedIds = new Set(records.map((record) => record.match_id));
    // Summary lookup can ingest recent matches. Refresh pagination once only when
    // it recovered records absent from the initial page, and no newer page owns it.
    if (summaryIds.some((id) => !storedIds.has(id))) await loadHistoryPage(player, 1);
  }, [loadHistoryPage, loadSummaries]);

  const retrySummaries = useCallback(async () => {
    const player = resultRef.current;
    if (!player || summaryStatus === "loading") return;
    await loadRecentRecords(player);
  }, [loadRecentRecords, summaryStatus]);

  const refresh = useCallback(async () => {
    const player = resultRef.current;
    if (!player) return;
    await search({
      nickname: player.nickname,
      platform: player.platform,
      seasonId: seasonIdRef.current || player.seasonId,
      forceRefresh: true,
    });
  }, [search]);

  const onModeDetected = useCallback((
    matchId: string,
    gameMode: string,
    matchType?: string,
    mapName?: string,
  ) => {
    setMatchModeMeta((previous) => {
      const next = { gameMode, matchType, mapName };
      const current = previous[matchId];
      if (
        current?.gameMode === next.gameMode
        && current.matchType === next.matchType
        && current.mapName === next.mapName
      ) return previous;
      return { ...previous, [matchId]: next };
    });
  }, []);

  useEffect(() => {
    if (!result) return;
    void loadRecentRecords(result);
  }, [loadRecentRecords, result]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setHistoryVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    const performancePending = Object.values(matchSummaries).some((summary) => (
      PERFORMANCE_PENDING_STATES.has(summary.performanceState ?? "")
    ));
    const shouldPoll = performancePending;
    if (!historyVisible || !result || !shouldPoll || historyPollAttemptRef.current >= PERFORMANCE_MAX_POLLS) {
      cancelHistoryPolling(!shouldPoll || !result);
      return;
    }
    if (historyPollTimeoutRef.current) return;

    const player = result;
    const page = historyPageRef.current;
    const generation = historyPollGenerationRef.current;
    const nextAttempt = historyPollAttemptRef.current + 1;
    const timeout = setTimeout(() => {
      if (historyPollTimeoutRef.current !== timeout) return;
      historyPollTimeoutRef.current = null;
      if (generation !== historyPollGenerationRef.current || document.visibilityState === "hidden") return;
      if (resultRef.current !== player || historyPageRef.current !== page) return;
      historyPollAttemptRef.current = nextAttempt;
      void loadHistoryPage(player, page, { isPoll: true });
    }, PERFORMANCE_POLL_INTERVAL_MS);
    historyPollTimeoutRef.current = timeout;

    return () => {
      if (historyPollTimeoutRef.current !== timeout) return;
      clearTimeout(timeout);
      historyPollTimeoutRef.current = null;
      historyPollGenerationRef.current += 1;
    };
  }, [
    cancelHistoryPolling,
    historyMatches,
    matchSummaries,
    historyResponseVersion,
    historyVisible,
    loadHistoryPage,
    result,
  ]);

  useEffect(() => {
    setSectionTab(options.initialTab ?? "overview");
  }, [options.initialTab, setSectionTab]);

  useEffect(() => {
    setGroupKey(options.initialGroupKey);
  }, [options.initialGroupKey]);

  useEffect(() => {
    const routePlatform = parseStatsPlatform(options.initialPlatform) ?? "steam";
    const routeNickname = options.initialNickname?.trim() ?? "";
    if (!routeNickname) {
      if (activeRouteKeyRef.current) {
        playerRequestRef.current?.controller.abort();
        activeRouteKeyRef.current = null;
        setResult(null);
        setError(null);
        setBaseStatus("idle");
        resetSummaryState();
      }
      return;
    }
    const routeKey = `${routePlatform}:${routeNickname.toLowerCase()}`;
    if (activeRouteKeyRef.current === routeKey) return;
    activeRouteKeyRef.current = routeKey;
    setPlatform(routePlatform);
    setNickname(routeNickname);
    setSeasonId("");
    setSectionTab(options.initialTab ?? "overview");
    void runSearch({ nickname: routeNickname, platform: routePlatform, seasonId: "" }, true);
  }, [
    options.initialNickname,
    options.initialPlatform,
    options.initialTab,
    resetSummaryState,
    runSearch,
    setNickname,
    setPlatform,
    setResult,
    setSeasonId,
    setSectionTab,
  ]);

  useEffect(() => {
    if (!refreshAvailableAt || refreshAvailableAt <= Date.now()) return;
    const timeout = window.setTimeout(() => {
      setIsRefreshCoolingDown(false);
    }, refreshAvailableAt - Date.now());
    return () => window.clearTimeout(timeout);
  }, [refreshAvailableAt]);

  useEffect(() => () => {
    playerRequestRef.current?.controller.abort();
    playerRequestIdRef.current += 1;
    playerRequestRef.current = null;
    inFlightPromiseRef.current = null;
    summaryRequestRef.current?.controller.abort();
    summaryRequestIdRef.current += 1;
    summaryRequestRef.current = null;
    historyRequestRef.current?.abort();
    historyRequestRef.current = null;
    cancelHistoryPolling(true);
    activeRouteKeyRef.current = null;
  }, [cancelHistoryPolling]);

  const partialReasons = useMemo(() => PARTIAL_REASONS.filter(
    (reason) => (partialSources.get(reason)?.size ?? 0) > 0,
  ), [partialSources]);
  const matchIds = useMemo(() => {
    const recent = normalizeRecentMatchIds(result?.recentMatches ?? []);
    if (historyLoaded && (historyTotalCount > 0 || historyPage > 1 || matchFilter !== "all")) {
      return normalizeRecentMatchIds(historyMatches.map((record) => record.match_id));
    }
    return recent;
  }, [historyLoaded, historyMatches, historyPage, historyTotalCount, matchFilter, result]);
  const status = baseStatus === "ready" && partialReasons.length > 0
    ? "partial"
    : baseStatus;

  return {
    status,
    result,
    error,
    suggestedPlayers,
    refreshAvailableAt,
    isRefreshCoolingDown,
    partialReasons,
    platform,
    nickname,
    seasonId,
    sectionTab,
    groupKey,
    statsMode,
    partySize,
    matchFilter,
    matchSummaries,
    missingMatchIds,
    matchModeMeta,
    summaryStatus,
    matchIds,
    historyStatus,
    historyPage,
    historyTotalPages,
    historyTotalCount,
    setPlatform,
    setNickname,
    setSeasonId,
    setSectionTab,
    setGroupKey,
    setStatsMode,
    setPartySize,
    setMatchFilter,
    search,
    refresh,
    retrySummaries,
    setHistoryPage,
    retryHistory,
    onModeDetected,
    reportPartial,
    clearPartial,
  };
}
