"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import type { PlayerMatchRecord } from "@/lib/pubg/playerMatches";
import { parseStatsPlatform } from "@/lib/stats/statsPageModel";
import type {
  PlayerStatsResponse,
  StatsErrorType,
  StatsHistoryStatus,
  StatsMatchFilter,
  StatsMatchModeMeta,
  StatsMode,
  StatsPageStatus,
  StatsPartialReason,
  StatsPartySize,
  StatsPlatform,
  StatsSectionTab,
} from "@/types/stats-page";

const REFRESH_COOLDOWN_MS = 60_000;
const PARTIAL_REASONS: readonly StatsPartialReason[] = [
  "summary_batch_failed",
  "summary_missing",
  "detail_failed",
  "analysis_failed",
];

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
  const [matchFilter, setMatchFilter] = useState<StatsMatchFilter>("all");
  const [matchSummaries, setMatchSummaries] = useState<Record<string, MatchSummaryData>>({});
  const [missingMatchIds, setMissingMatchIds] = useState<ReadonlySet<string>>(new Set());
  const [matchModeMeta, setMatchModeMeta] = useState<Record<string, StatsMatchModeMeta>>({});
  const [summaryStatus, setSummaryStatus] = useState<StatsPageController["summaryStatus"]>("idle");
  const [historyMatches, setHistoryMatches] = useState<PlayerMatchRecord[]>([]);
  const [historyStatus, setHistoryStatus] = useState<StatsHistoryStatus>("idle");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyPage, setHistoryPageState] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(0);

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

  const resetSummaryState = useCallback(() => {
    summaryRequestRef.current?.controller.abort();
    summaryRequestRef.current = null;
    historyRequestRef.current?.abort();
    historyRequestRef.current = null;
    historyRequestIdRef.current += 1;
    setHistoryMatches([]);
    setHistoryStatus("idle");
    setHistoryLoaded(false);
    setHistoryPageState(1);
    setHistoryTotalPages(0);
    setMatchSummaries({});
    setMissingMatchIds(new Set());
    setMatchModeMeta({});
    setSummaryStatus("idle");
  }, []);

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

        if (!response.ok) {
          if (stale()) return null;
          const message = typeof data.error === "string"
            ? data.error
            : `전적 서버 응답이 지연되거나 실패했습니다. 잠시 후 다시 시도해 주세요. (HTTP ${response.status})`;
          let nextError: Exclude<ControllerError, null>;
          if (response.status === 404 || data.code === "PLAYER_NOT_FOUND") {
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
        const player = data as unknown as PlayerStatsResponse;
        const responsePlatform = parseStatsPlatform(player.platform) ?? resolved.platform;
        const responseSeason = normalizeSeason(player.seasonId);
        setResult(player);
        setPlatform(responsePlatform);
        setNickname("");
        setSeasonId(responseSeason);
        setSuggestedPlayers([]);
        rateLimitUntilRef.current.delete(identity);
        const updatedAt = player.updatedAt ? Date.parse(player.updatedAt) : Number.NaN;
        setRefreshAvailableAt(Number.isFinite(updatedAt) ? updatedAt + REFRESH_COOLDOWN_MS : undefined);
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
  ]);

  const search = useCallback((request?: StatsSearchRequest) => (
    runSearch(request, false)
  ), [runSearch]);

  const loadHistoryPage = useCallback(async (
    player: PlayerStatsResponse,
    page: number,
  ): Promise<PlayerMatchRecord[]> => {
    historyRequestRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++historyRequestIdRef.current;
    historyRequestRef.current = controller;
    setHistoryStatus("loading");

    try {
      const params = new URLSearchParams({
        nickname: player.nickname,
        platform: player.platform,
        page: String(Math.max(1, Math.floor(page))),
      });
      const response = await fetch(`/api/pubg/player/matches?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json() as {
        matches?: PlayerMatchRecord[];
        page?: number;
        totalPages?: number;
      };
      if (!response.ok) throw new Error("전체 전적을 불러오지 못했습니다.");
      if (controller.signal.aborted || requestId !== historyRequestIdRef.current) return [];

      const incoming = Array.isArray(data.matches) ? data.matches : [];
      setHistoryMatches(incoming);
      setHistoryLoaded(true);
      setHistoryPageState(data.page && data.page > 0 ? data.page : page);
      setHistoryTotalPages(Math.max(0, data.totalPages ?? 0));
      setHistoryStatus("ready");
      return incoming;
    } catch (caught) {
      if (isAbortError(caught)) return [];
      setHistoryStatus("error");
      return [];
    } finally {
      if (historyRequestRef.current === controller) historyRequestRef.current = null;
    }
  }, []);

  const loadSummaries = useCallback((player: PlayerStatsResponse): Promise<void> => {
    const matchIds = player.recentMatches.slice(0, 20);
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
      return Promise.resolve();
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
        if (stale()) return;
        if (!response.ok) throw new Error("최근 매치 요약을 불러오지 못했습니다.");

        const summaries = data.summaries ?? {};
        const missingIds = new Set(data.missingMatchIds ?? []);
        const nextModeMeta: Record<string, StatsMatchModeMeta> = {};
        for (const [matchId, gameMode] of Object.entries(player.matchModes ?? {})) {
          nextModeMeta[matchId] = { gameMode };
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
        setMatchModeMeta((previous) => ({ ...previous, ...nextModeMeta }));
        setSummaryStatus("ready");
        clearPartial("summary_batch_failed", "summary-batch");
        if (missingIds.size) reportPartial("summary_missing", "summary-batch");
        else clearPartial("summary_missing", "summary-batch");
      } catch (caught) {
        if (stale() || isAbortError(caught)) return;
        setSummaryStatus("error");
        reportPartial("summary_batch_failed", "summary-batch");
      }
    })();
  }, [clearPartial, reportPartial]);

  const applyHistoryRecords = useCallback((incoming: readonly PlayerMatchRecord[]) => {
    if (!incoming.length) return;
    const basicSummaries = Object.fromEntries(
      incoming.map((record) => [record.match_id, buildBasicMatchSummary(record)]),
    );
    setMatchSummaries((previous) => ({ ...basicSummaries, ...previous }));
    setMissingMatchIds((previous) => {
      if (!previous.size) return previous;
      const next = new Set(previous);
      for (const record of incoming) next.delete(record.match_id);
      return next;
    });
    setMatchModeMeta((previous) => {
      const next = { ...previous };
      for (const record of incoming) {
        next[record.match_id] = {
          gameMode: record.game_mode,
          matchType: record.match_type,
          mapName: record.map_name,
        };
      }
      return next;
    });
  }, []);

  const setHistoryPage = useCallback(async (page: number) => {
    const player = resultRef.current;
    if (!player || historyStatus === "loading") return;
    if (page < 1 || (historyTotalPages > 0 && page > historyTotalPages)) return;
    if (page === historyPage && historyLoaded) return;
    const incoming = await loadHistoryPage(player, page);
    applyHistoryRecords(incoming);
  }, [applyHistoryRecords, historyLoaded, historyPage, historyStatus, historyTotalPages, loadHistoryPage]);

  const retryHistory = useCallback(async () => {
    const player = resultRef.current;
    if (!player || historyStatus === "loading") return;
    const incoming = await loadHistoryPage(player, historyPage);
    applyHistoryRecords(incoming);
  }, [applyHistoryRecords, historyPage, historyStatus, loadHistoryPage]);

  const retrySummaries = useCallback(async () => {
    if (!resultRef.current) return;
    await loadSummaries(resultRef.current);
  }, [loadSummaries]);

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
    void loadSummaries(result);
    void loadHistoryPage(result, 1).then(applyHistoryRecords);
  }, [applyHistoryRecords, loadHistoryPage, loadSummaries, result]);

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
    activeRouteKeyRef.current = null;
  }, []);

  const partialReasons = useMemo(() => PARTIAL_REASONS.filter(
    (reason) => (partialSources.get(reason)?.size ?? 0) > 0,
  ), [partialSources]);
  const matchIds = useMemo(() => [...new Set([
    ...(historyLoaded && historyMatches.length > 0
      ? historyMatches.map((record) => record.match_id)
      : (result?.recentMatches ?? []).slice(0, 20)),
  ])], [historyLoaded, historyMatches, result]);
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
