import "server-only";
import { getLolDataDragonVersion } from "./dataDragon.server";
import { recordLolOpsMetric, type LolOpsMetric } from "./ops.server";
import {
  acquireLolCollectionLease,
  aggregateLolMatchBenchmarks,
  hasLolBenchmarkProcessedMatch,
  hasLolStoredMatch,
  blockLolRiotRequests,
  getLolApiCache,
  getLolChallengeCatalogCache,
  putLolChallengeCatalogCache,
  getLolAccountByRiotId,
  getLolAccountNamesByPuuids,
  emptyLolRankedHistory,
  getLolRankedHistory,
  getLolPlayerMatchSummaries,
  getLolMatchRequestJson,
  isLolPersistenceEnabled,
  LolPermitError,
  LolPersistenceError,
  LolLeaseExpiredError,
  lolMatchCacheKey,
  lolSearchCacheKey,
  persistLolMatchDetails,
  persistLolSearchSnapshot,
  recordLolRiotRateHeaders,
  releaseLolCollectionLease,
  releaseLolRiotRequest,
  reserveLolRiotRequest,
  startLolRiotRequest,
  type LolPlatform,
  type LolRegionalRoute,
} from "@/lib/lol/persistence.server";
import { summarizeRecentMatches } from "@/lib/lol/summary";
import { pickLolChallenges } from "./challenges";
import { buildLolMatchInsights, summarizeLolRecentTrends } from "./insights";
import { parseLolMatchBuild, type LolMatchBuild } from "./matchBuild";
import { buildLolChallengeProfile, parseLolChallengeCatalog, type LolChallengeCatalog, type LolChallengeProfile } from "./challengeProfile";
import { parseLolMasteries, summarizeLolChampionPerformance } from "./mastery";
import { lolParticipantDto, lolSearchResultDto, openLolParticipantRef } from "./participantIdentity.server";
import type { ServerLolRecentMatch as LolRecentMatch, ServerLolMatchDetails as LolMatchDetails, ServerLolSearchResult as LolSearchResult } from "./participantIdentity.server";
import type { LolMatchFailure, LolRefreshCooldown, LolMasteryComparison } from "@/lib/lol/types";
export type { LolRecentMatch, LolQueueSummary, LolMatchDetails, LolSearchResult, LolMatchFailure, LolRefreshCooldown } from "@/lib/lol/types";

type RiotQueueEntry = {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
};

type RiotEndpoint = "account" | "summoner" | "league" | "mastery" | "challenges" | "match_ids" | "match" | "status";
type RiotFailureStage =
  | "configuration"
  | "queue"
  | "fetch"
  | "http"
  | "body_cancel"
  | "body"
  | "json";
type RiotFailureDiagnostic = {
  endpoint: RiotEndpoint;
  stage: RiotFailureStage;
  reasonCode: string;
  status?: number;
};

export class RiotSearchError extends Error {
  constructor(
    readonly kind:
      | "invalid_request"
      | "not_found"
      | "key_or_permission"
      | "restricted_match"
      | "rate_limited"
      | "timeout"
      | "upstream"
      | "unconfigured"
      | "congested"
      | "busy"
      | "persistence",
    readonly retryAfterSeconds?: number,
    readonly diagnostic?: RiotFailureDiagnostic,
  ) {
    super(kind);
  }
}

type CacheEntry = { expiresAt: number; value: unknown };
type RiotState = {
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<unknown>>;
  queue: Promise<void>;
  nextRequestAt: number;
  blockedUntil: number;
  activeSearches: number;
  accounts: Map<string, { account: { puuid: string; gameName: string; tagLine: string }; expiresAt: number }>;
  accountOps: Set<string>;
};

const STATE_KEY = Symbol.for("bgms.lol.riot-search-state");
const CACHE_MAX_ENTRIES = 100;
const CACHE_MAX_VALUE_BYTES = 256 * 1024;
const IDENTIFIER_TTL_MS = 120_000;
const MATCH_TTL_MS = 10 * 60_000;
const MIN_REQUEST_INTERVAL_MS = 1_500;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RIOT_HOSTS = {
  asia: "https://asia.api.riotgames.com",
  kr: "https://kr.api.riotgames.com",
} as const;
const LOL_PLATFORM: LolPlatform = "kr";
const LOL_REGIONAL_ROUTE: LolRegionalRoute = "asia";
export const LOL_MATCH_DETAILS_VERSION = "v5";
const MIN_SUMMARY_GAME_DURATION_SECONDS = 300;
const STATIC_TTL_MS = 24 * 60 * 60_000;
type StaticRune = { id: number; name: string; icon: string };
type StaticSpell = {
  id: string;
  key: string | number;
  name: string;
  image: { full: string };
};
type StaticStyle = {
  id: number;
  name: string;
  icon: string;
  slots: Array<{ runes: StaticRune[] }>;
};
let staticData:
  | {
      dataDragonVersion: string;
      expiresAt: number;
      enriched: boolean;
      champions: Record<string, { name: string; key: string }>;
      items: Record<string, { name: string }>;
      spells: Record<string, StaticSpell>;
      styles: StaticStyle[];
    }
  | undefined;
let staticDataRequest: Promise<NonNullable<typeof staticData>> | undefined;

// shortcut: 로컬 단일 프로세스 전용 제한·캐시이며, 다중 인스턴스 운영 전 공유 저장소로 교체한다.
const state: RiotState = (() => {
  const root = globalThis as typeof globalThis & { [STATE_KEY]?: RiotState };
  const shared = (root[STATE_KEY] ??= {
    cache: new Map(),
    inflight: new Map(),
    queue: Promise.resolve(),
    nextRequestAt: 0,
    blockedUntil: 0,
    activeSearches: 0,
    accounts: new Map(),
    accountOps: new Set(),
  });
  shared.accounts ??= new Map();
  shared.accountOps ??= new Set();
  return shared;
})();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRiotEndpoint(path: string): RiotEndpoint {
  if (path.startsWith("/riot/account/v1/accounts/by-riot-id/") || path.startsWith("/riot/account/v1/accounts/by-puuid/"))
    return "account";
  if (path.startsWith("/lol/summoner/v4/")) return "summoner";
  if (path.startsWith("/lol/league/v4/")) return "league";
  if (path === "/lol/status/v4/platform-data") return "status";
  if (path.startsWith("/lol/champion-mastery/v4/")) return "mastery";
  if (path.startsWith("/lol/challenges/v1/")) return "challenges";
  if (path.includes("/matches/by-puuid/")) return "match_ids";
  return "match";
}

function safeTransportCode(error: unknown): string {
  if (!(error instanceof Error) || error.name === "TimeoutError")
    return "fetch_failed";
  const cause = error.cause;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? cause.code
      : undefined;
  const allowed = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  return typeof code === "string" && allowed.has(code) ? code : "fetch_failed";
}

function logRiotFailure(
  endpoint: RiotEndpoint,
  stage: RiotFailureStage,
  kind: RiotSearchError["kind"],
  reasonCode: string,
  startedAt: number,
  status?: number,
) {
  console.error(
    "[lol-riot] request_failed",
    JSON.stringify({
      endpoint,
      stage,
      type: kind,
      reasonCode,
      status: status ?? null,
      durationMs: Date.now() - startedAt,
    }),
  );
}

async function discardResponseBody(response: Response): Promise<boolean> {
  try {
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function getCached<T>(key: string): T | undefined {
  const entry = state.cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    state.cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function setCached(key: string, value: unknown, ttlMs: number, maxBytes = CACHE_MAX_VALUE_BYTES) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) return;
  if (state.cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = state.cache.keys().next().value;
    if (oldest) state.cache.delete(oldest);
  }
  state.cache.delete(key);
  state.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cacheAccount(key: string, account: { puuid: string; gameName: string; tagLine: string }) {
  if (state.accounts.size >= CACHE_MAX_ENTRIES && !state.accounts.has(key)) {
    const oldest = state.accounts.keys().next().value;
    if (oldest) state.accounts.delete(oldest);
  }
  state.accounts.set(key, { account, expiresAt: Date.now() + 24 * 60 * 60_000 });
}

async function readLolChallengeBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("challenge response too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function requestJson<T>(
  host: keyof typeof RIOT_HOSTS,
  path: string,
  ttlMs: number,
  bypassCache = false,
  onFetch?: () => void,
  responseLimitBytes = MAX_RESPONSE_BYTES,
): Promise<T> {
  // 마스터 전체 명단은 일반 응답 한도를 넘으므로 지정한 집계 경로만 별도 상한을 둔다.
  const maxResponseBytes = /^\/lol\/league\/v4\/(challenger|grandmaster|master)leagues\/by-queue\/(RANKED_SOLO_5x5|RANKED_FLEX_SR)$/.test(path)
    ? 32 * 1024 * 1024 : responseLimitBytes;
  const persistenceEnabled = isLolPersistenceEnabled();
  const endpoint = getRiotEndpoint(path);
  const cacheKey = `${host}:${path}`;
  const cached = persistenceEnabled || bypassCache ? undefined : getCached<T>(cacheKey);
  if (cached !== undefined) return cached;
  const existing = state.inflight.get(cacheKey);
  if (existing) return existing as Promise<T>;

  const request = new Promise<T>((resolve, reject) => {
    const startedAt = Date.now();
    const fail = (
      error: RiotSearchError,
      stage: RiotFailureStage,
      reasonCode: string,
      status?: number,
    ) => {
      const diagnostic = {
        endpoint,
        stage,
        reasonCode,
        ...(status === undefined ? {} : { status }),
      };
      logRiotFailure(
        endpoint,
        stage,
        error.kind,
        reasonCode,
        startedAt,
        status,
      );
      reject(
        new RiotSearchError(error.kind, error.retryAfterSeconds, diagnostic),
      );
    };
    const run = state.queue.then(async () => {
      let permitToken: string | undefined;
      let requestMetric: LolOpsMetric | undefined;
      try {
      if (persistenceEnabled) {
          const permit = await reserveLolRiotRequest(host);
          permitToken = permit.token;
          const waitMs = permit.permitAt - Date.now();
          if (waitMs > 4_000) {
            await releaseLolRiotRequest(permitToken);
            permitToken = undefined;
            fail(
              new RiotSearchError("congested", Math.ceil(waitMs / 1000)),
              "queue",
              "shared_guard_wait",
            );
            return;
          }
          if (waitMs > 0) await sleep(waitMs);
          const started = await startLolRiotRequest(permitToken);
          if (!started.allowed) {
            fail(
              new RiotSearchError("congested", started.retryAfterSeconds),
              "queue",
              "shared_guard_cooldown",
            );
            return;
          }
        } else {
          if (state.blockedUntil > Date.now()) {
            fail(
              new RiotSearchError(
                "rate_limited",
                Math.ceil((state.blockedUntil - Date.now()) / 1000),
              ),
              "queue",
              "rate_limit_cooldown",
            );
            return;
          }
          const delay = state.nextRequestAt - Date.now();
          if (delay > 0) await sleep(delay);
          if (state.blockedUntil > Date.now()) {
            fail(
              new RiotSearchError(
                "rate_limited",
                Math.ceil((state.blockedUntil - Date.now()) / 1000),
              ),
              "queue",
              "rate_limit_cooldown",
            );
            return;
          }
          state.nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
        }

        const key = process.env.RIOT_API_KEY?.trim();
        if (!key) {
          fail(
            new RiotSearchError("unconfigured"),
            "configuration",
            "missing_api_key",
          );
          return;
        }

        let response: Response;
        const signal = AbortSignal.timeout(8_000);
        try {
          onFetch?.();
          response = await fetch(`${RIOT_HOSTS[host]}${path}`, {
            headers: { "X-Riot-Token": key, Accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal,
          });
        } catch (error) {
          const timeout =
            signal.aborted || (error instanceof Error && error.name === "TimeoutError");
          requestMetric = timeout ? "riot_timeout" : "riot_network";
          fail(
            new RiotSearchError(timeout ? "timeout" : "upstream"),
            "fetch",
            timeout ? "timeout" : safeTransportCode(error),
          );
          return;
        }

        requestMetric = response.ok ? "riot_success" : response.status === 429 ? "riot_429"
          : response.status === 401 || response.status === 403 ? "riot_key_error" : response.status >= 500 ? "riot_5xx" : "riot_4xx";
        if (persistenceEnabled)
          await recordLolRiotRateHeaders(host, response.headers);
        if (response.status === 429) {
          const rawRetryAfter = Number(response.headers.get("Retry-After"));
          const seconds =
            Number.isFinite(rawRetryAfter) && rawRetryAfter > 0
              ? Math.min(604800, Math.ceil(rawRetryAfter))
              : 1;
          if (persistenceEnabled) await blockLolRiotRequests(host, seconds);
          else
            state.blockedUntil = Math.max(
              state.blockedUntil,
              Date.now() + seconds * 1000,
            );
          const cancelled = await discardResponseBody(response);
          fail(
            new RiotSearchError("rate_limited", seconds),
            cancelled ? "http" : "body_cancel",
            cancelled ? "http_429" : "body_cancel_failed",
            429,
          );
          return;
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404
        ) {
          const status = response.status;
          const cancelled = await discardResponseBody(response);
          const kind = status === 404 ? "not_found" : "key_or_permission";
          fail(
            new RiotSearchError(kind),
            cancelled ? "http" : "body_cancel",
            cancelled ? `http_${status}` : "body_cancel_failed",
            status,
          );
          return;
        }
        if (!response.ok) {
          const status = response.status;
          const cancelled = await discardResponseBody(response);
          fail(
            new RiotSearchError("upstream"),
            cancelled ? "http" : "body_cancel",
            cancelled ? `http_${status}` : "body_cancel_failed",
            status,
          );
          return;
        }

        const contentLength = Number(response.headers.get("Content-Length"));
        if (contentLength > maxResponseBytes) {
          await discardResponseBody(response);
          fail(
            new RiotSearchError("upstream"),
            "body",
            "response_too_large",
            response.status,
          );
          return;
        }
        let bytes: ArrayBuffer;
        try {
          bytes = endpoint === "challenges" ? await readLolChallengeBody(response, maxResponseBytes) : await response.arrayBuffer();
        } catch (error) {
          if (error instanceof RangeError) {
            fail(new RiotSearchError("upstream"), "body", "response_too_large", response.status);
            return;
          }
          const timeout = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
          requestMetric = timeout ? "riot_timeout" : "riot_network";
          fail(
            new RiotSearchError(timeout ? "timeout" : "upstream"),
            "body",
            timeout ? "timeout" : "body_read_failed",
            response.status,
          );
          return;
        }
        if (bytes.byteLength > maxResponseBytes) {
          fail(
            new RiotSearchError("upstream"),
            "body",
            "response_too_large",
            response.status,
          );
          return;
        }
        let data: T;
        try {
          data = JSON.parse(new TextDecoder().decode(bytes)) as T;
        } catch {
          fail(
            new RiotSearchError("upstream"),
            "json",
            "invalid_json",
            response.status,
          );
          return;
        }
        if (!persistenceEnabled && ttlMs > 0) setCached(cacheKey, data, ttlMs);
        resolve(data);
      } catch (error) {
        if (error instanceof LolPermitError)
          fail(
            new RiotSearchError(error.kind === "busy" ? "congested" : error.kind, error.retryAfterSeconds),
            "queue",
            `shared_${error.kind}`,
          );
        else if (error instanceof LolPersistenceError)
          fail(
            new RiotSearchError("persistence"),
            "queue",
            "persistence_unavailable",
          );
        else
          fail(
            new RiotSearchError("upstream"),
            "queue",
            "queue_execution_failed",
          );
      } finally {
        if (requestMetric) recordLolOpsMetric(requestMetric);
        if (permitToken) {
          try {
            await releaseLolRiotRequest(permitToken);
          } catch {
            /* lease expiry recovers a failed release */
          }
        }
      }
    });
    void run.catch(() =>
      fail(new RiotSearchError("upstream"), "queue", "queue_execution_failed"),
    );
    state.queue = run.then(
      () => undefined,
      () => undefined,
    );
  });

  state.inflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    state.inflight.delete(cacheKey);
  }
}

function parseRiotId(
  input: unknown,
): { gameName: string; tagLine: string } | null {
  if (
    typeof input !== "string" ||
    input.length > 140 ||
    /[\u0000-\u001f\u007f]/.test(input)
  )
    return null;
  const separator = input.lastIndexOf("#");
  if (separator < 1) return null;
  const gameName = input.slice(0, separator).trim();
  const tagLine = input.slice(separator + 1).trim();
  if (
    !gameName ||
    !tagLine ||
    gameName.length > 64 ||
    tagLine.length > 16 ||
    gameName.includes("#")
  )
    return null;
  return { gameName, tagLine };
}

function ratio(
  numerator: number | null,
  denominator: number | null,
): number | null {
  return numerator !== null && denominator !== null && denominator > 0
    ? numerator / denominator
    : null;
}

function sumComplete(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + value!, 0)
    : null;
}

function summarizeMatch(match: any, puuid: string): LolRecentMatch | null {
  const info = match?.info;
  const participant = info?.participants?.find(
    (item: any) => item?.puuid === puuid,
  );
  if (
    !info ||
    !participant ||
    Number(info.queueId) === 0 ||
    info.gameType === "CUSTOM_GAME"
  )
    return null;
  const number = (value: unknown) => optionalNonNegativeNumber(value);
  const duration = number(info.gameDuration);
  const kills = number(participant.kills);
  const deaths = number(participant.deaths);
  const assists = number(participant.assists);
  const cs = sumComplete([
    number(participant.totalMinionsKilled),
    number(participant.neutralMinionsKilled),
  ]);
  const goldEarned = number(participant.goldEarned);
  const teamId = optionalPositiveInteger(participant.teamId);
  const team = info.participants.filter(
    (item: any) => teamId !== null && item?.teamId === teamId,
  );
  const seenTeammates = new Set<string>();
  const teammates = team.flatMap((item: any) => {
    if (item?.puuid === puuid || typeof item?.puuid !== "string" || !item.puuid || seenTeammates.has(item.puuid)
      || typeof item?.riotIdGameName !== "string" || !item.riotIdGameName.trim()
      || typeof item?.riotIdTagline !== "string" || !item.riotIdTagline.trim()) return [];
    seenTeammates.add(item.puuid);
    return [{ puuid: item.puuid, riotId: `${item.riotIdGameName}#${item.riotIdTagline}`, win: typeof item.win === "boolean" ? item.win : null }];
  });
  const teamKills = sumComplete(team.map((item: any) => number(item.kills)));
  const teamKillParticipation =
    kills !== null && assists !== null ? kills + assists : null;
  const minutes =
    duration !== null && duration >= MIN_SUMMARY_GAME_DURATION_SECONDS
      ? duration / 60
      : null;
  return {
    matchId: String(match.metadata?.matchId ?? ""),
    challenges: pickLolChallenges(participant.challenges),
    insights: participantInsights(participant, info),
    queueId: Number(info.queueId) || 0,
    gameMode: String(info.gameMode ?? "Unknown"),
    gameEndTimestamp: Number(info.gameEndTimestamp ?? info.gameCreation) || 0,
    gameDuration: duration,
    win: typeof participant.win === "boolean" ? participant.win : null,
    championName: String(participant.championName ?? "Unknown"),
    championId: Number(participant.championId) || 0,
    championImageId: String(participant.championName ?? ""),
    championNameKo: String(participant.championName ?? "알 수 없음"),
    kills,
    deaths,
    assists,
    cs,
    goldEarned,
    wardsPlaced: number(participant.wardsPlaced),
    wardsKilled: number(participant.wardsKilled),
    detectorWardsPlaced: number(participant.detectorWardsPlaced),
    damageDealtToObjectives: number(participant.damageDealtToObjectives),
    damageDealtToTurrets: number(participant.damageDealtToTurrets),
    killParticipationPct:
      ratio(teamKillParticipation, teamKills) === null
        ? null
        : ratio(teamKillParticipation, teamKills)! * 100,
    csPerMinute: ratio(cs, minutes),
    goldPerMinute: ratio(goldEarned, minutes),
    teamPosition: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"].includes(
      participant.teamPosition,
    )
      ? participant.teamPosition
      : "미분류",
    teammates,
    ...(optionalNonNegativeNumber(participant.largestMultiKill) !== null
      ? { largestMultiKill: optionalNonNegativeNumber(participant.largestMultiKill)! } : {}),
    remake:
      participant.gameEndedInEarlySurrender === true ||
      team.some((item: any) => item.teamEarlySurrendered === true) ||
      participant.teamEarlySurrendered === true,
  };
}

async function getStaticData(includeBuild = false, version?: string) {
  const dataDragonVersion = version ?? await getLolDataDragonVersion();
  if (
    staticData &&
    staticData.dataDragonVersion === dataDragonVersion &&
    staticData.expiresAt > Date.now() &&
    (!includeBuild || staticData.enriched)
  )
    return staticData;
  if (staticDataRequest) {
    const pending = staticDataRequest;
    const loaded = await pending;
    if (loaded.dataDragonVersion === dataDragonVersion && (!includeBuild || loaded.enriched)) return loaded;
    if (staticDataRequest === pending) staticDataRequest = undefined;
    return getStaticData(includeBuild, dataDragonVersion);
  }
  const request = (async () => {
    const load = async <T>(
      kind: "champion" | "item" | "summoner",
    ): Promise<Record<string, T>> => {
      try {
        const response = await fetch(
          `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/data/ko_KR/${kind}.json`,
          {
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (
          !response.ok ||
          Number(response.headers.get("Content-Length")) > 4 * 1024 * 1024
        )
          return {};
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 4 * 1024 * 1024) return {};
        const json = JSON.parse(new TextDecoder().decode(bytes));
        return json?.data && typeof json.data === "object"
          ? (json.data as Record<string, T>)
          : {};
      } catch {
        return {};
      }
    };
    const [champions, items, spells, styles] = await Promise.all([
      load<{ name: string; key: string }>("champion"),
      load<{ name: string }>("item"),
      includeBuild
        ? load<StaticSpell>("summoner")
        : Promise.resolve({} as Record<string, StaticSpell>),
      includeBuild
        ? (async () => {
            try {
              const response = await fetch(
                `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/data/ko_KR/runesReforged.json`,
                {
                  cache: "no-store",
                  redirect: "error",
                  signal: AbortSignal.timeout(8_000),
                },
              );
              if (
                !response.ok ||
                Number(response.headers.get("Content-Length")) > 4 * 1024 * 1024
              )
                return [];
              const bytes = await response.arrayBuffer();
              if (bytes.byteLength > 4 * 1024 * 1024) return [];
              const json = JSON.parse(new TextDecoder().decode(bytes));
              return Array.isArray(json) ? (json as StaticStyle[]) : [];
            } catch {
              return [];
            }
          })()
        : Promise.resolve([] as StaticStyle[]),
    ]);
    return (staticData = {
      dataDragonVersion,
      expiresAt:
        Object.keys(champions).length ||
        Object.keys(items).length ||
        Object.keys(spells).length ||
        styles.length
          ? Date.now() + STATIC_TTL_MS
          : 0,
      enriched: includeBuild,
      champions,
      items,
      spells,
      styles,
    });
  })();
  staticDataRequest = request;
  try {
    return await request;
  } finally {
    if (staticDataRequest === request) staticDataRequest = undefined;
  }
}

function isMatchId(input: string): boolean {
  return input.length <= 24 && /^KR_\d{1,20}$/.test(input);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNonNegativeNumber(value: unknown): number | null {
  const number = optionalNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function optionalPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function participantInsights(participant: any, info: any) {
  const opponents = info.participants.filter((other: any) => other.teamId !== participant.teamId
    && typeof participant.teamPosition === "string" && other.teamPosition === participant.teamPosition);
  return buildLolMatchInsights({ challenges: participant.challenges, position: participant.teamPosition,
    queueId: Number(info.queueId), duration: optionalNonNegativeNumber(info.gameDuration),
    remake: participant.gameEndedInEarlySurrender === true, visionScore: participant.visionScore,
    opponentChallenges: opponents.length === 1 ? opponents[0].challenges : undefined,
    opponentVisionScore: opponents.length === 1 ? opponents[0].visionScore : undefined });
}

function buildMatchDetails(
  raw: any,
  metadata: Awaited<ReturnType<typeof getStaticData>>,
): Omit<LolMatchDetails, "matchId" | "queueId" | "gameMode" | "gameDuration"> {
  const info = raw.info;
  const runesById = new Map<
    number,
    { id: number; name: string; image: string }
  >();
  for (const style of metadata.styles) {
    runesById.set(style.id, {
      id: style.id,
      name: style.name,
      image: style.icon,
    });
    for (const slot of style.slots ?? [])
      for (const rune of slot.runes ?? [])
        runesById.set(rune.id, {
          id: rune.id,
          name: rune.name,
          image: rune.icon,
        });
  }
  const participants = info.participants.map((participant: any) => {
    const championEntry = Object.entries(metadata.champions).find(
      ([, champion]) => Number(champion.key) === Number(participant.championId),
    );
    const champion = championEntry?.[1];
    const perkStyles = Array.isArray(participant.perks?.styles)
      ? participant.perks.styles
      : [];
    const primaryStyle =
      perkStyles.find((style: any) => style?.description === "primaryStyle") ??
      perkStyles[0];
    const subStyle =
      perkStyles.find((style: any) => style?.description === "subStyle") ??
      perkStyles[1];
    const runeInfo = (id: unknown) => {
      const numericId = optionalNonNegativeNumber(id);
      return numericId === null || numericId === 0
        ? null
        : (runesById.get(numericId) ?? {
            id: numericId,
            name: String(numericId),
            image: "",
          });
    };
    const totalMinions = optionalNumber(participant.totalMinionsKilled);
    const neutralMinions = optionalNumber(participant.neutralMinionsKilled);
    return {
      puuid: typeof participant.puuid === "string" ? participant.puuid : undefined,
      riotId:
        participant.riotIdGameName && participant.riotIdTagline
          ? `${String(participant.riotIdGameName)}#${String(participant.riotIdTagline)}`
          : "Riot ID 미제공",
      championId: Number(participant.championId) || 0,
      championImageId:
        championEntry?.[0] ?? String(participant.championName ?? ""),
      championName: String(participant.championName ?? "Unknown"),
      championNameKo:
        champion?.name ?? String(participant.championName ?? "알 수 없음"),
      win: Boolean(participant.win),
      ...(optionalNonNegativeNumber(participant.profileIcon) !== null
        ? { profileIconId: optionalNonNegativeNumber(participant.profileIcon)! } : {}),
      championLevel: optionalPositiveInteger(participant.champLevel),
      spells: [participant.summoner1Id, participant.summoner2Id].map((id) => {
        const spellId = optionalNonNegativeNumber(id);
        if (spellId === null || spellId === 0) return null;
        const spell = Object.values(metadata.spells).find(
          (entry) => Number(entry.key) === spellId,
        );
        return spell
          ? { id: spellId, name: spell.name, image: spell.image?.full ?? "" }
          : { id: spellId, name: String(spellId), image: "" };
      }),
      runes: {
        keystone: runeInfo(
          primaryStyle?.selections?.find((selection: any) => selection?.perk)
            ?.perk,
        ),
        primaryStyle: runeInfo(primaryStyle?.style),
        subStyle: runeInfo(subStyle?.style),
      },
      kills: optionalNonNegativeNumber(participant.kills),
      deaths: optionalNonNegativeNumber(participant.deaths),
      assists: optionalNonNegativeNumber(participant.assists),
      items: Array.from(
        { length: 7 },
        (_, index) => Number(participant[`item${index}`]) || 0,
      ).map((id) => ({
        id,
        name: id ? (metadata.items[String(id)]?.name ?? "") : "",
      })),
      damageToChampions: optionalNonNegativeNumber(
        participant.totalDamageDealtToChampions,
      ),
      damageTaken: optionalNonNegativeNumber(participant.totalDamageTaken),
      cs:
        totalMinions !== null &&
        neutralMinions !== null &&
        totalMinions >= 0 &&
        neutralMinions >= 0
          ? totalMinions + neutralMinions
          : null,
      visionScore: optionalNonNegativeNumber(participant.visionScore),
      goldEarned: optionalNonNegativeNumber(participant.goldEarned),
      wardsPlaced: optionalNonNegativeNumber(participant.wardsPlaced),
      wardsKilled: optionalNonNegativeNumber(participant.wardsKilled),
      detectorWardsPlaced: optionalNonNegativeNumber(
        participant.detectorWardsPlaced,
      ),
      damageDealtToObjectives: optionalNonNegativeNumber(
        participant.damageDealtToObjectives,
      ),
      damageDealtToTurrets: optionalNonNegativeNumber(
        participant.damageDealtToTurrets,
      ),
      killParticipationPct: (() => {
        const teamId = optionalPositiveInteger(participant.teamId);
        const teammates = info.participants.filter(
          (item: any) => teamId !== null && item?.teamId === teamId,
        );
        const teamKills = sumComplete(
          teammates.map((item: any) => optionalNonNegativeNumber(item.kills)),
        );
        const contribution = optionalNonNegativeNumber(participant.kills);
        const assists = optionalNonNegativeNumber(participant.assists);
        return ratio(
          contribution !== null && assists !== null
            ? contribution + assists
            : null,
          teamKills,
        ) === null
          ? null
          : ratio(contribution! + assists!, teamKills)! * 100;
      })(),
    };
  });
  const teamIds: number[] = Array.from(
    new Set<number>(
      info.participants.map(
        (participant: any) => Number(participant.teamId) || 0,
      ),
    ),
  );
  const objectiveNames = [
    "tower",
    "dragon",
    "baron",
    "riftHerald",
    "horde",
    "inhibitor",
  ] as const;
  const result = {
    teams: teamIds.map((teamId) => ({
      teamId,
      win: Boolean(
        info.teams?.find((team: any) => Number(team.teamId) === teamId)?.win,
      ),
      totalKills: sumComplete(
        info.participants
          .filter((participant: any) => Number(participant.teamId) === teamId)
          .map((participant: any) =>
            optionalNonNegativeNumber(participant.kills),
          ),
      ),
      totalGold: sumComplete(
        info.participants
          .filter((participant: any) => Number(participant.teamId) === teamId)
          .map((participant: any) =>
            optionalNonNegativeNumber(participant.goldEarned),
          ),
      ),
      objectives: Object.fromEntries(
        objectiveNames.map((name) => {
          const objective = info.teams?.find(
            (team: any) => Number(team.teamId) === teamId,
          )?.objectives?.[name];
          return [
            name,
            {
              kills: optionalNonNegativeNumber(objective?.kills),
              first:
                typeof objective?.first === "boolean" ? objective.first : null,
            },
          ];
        }),
      ) as LolMatchDetails["teams"][number]["objectives"],
      participants: participants.filter(
        (_: unknown, index: number) =>
          Number(info.participants[index].teamId) === teamId,
      ),
    })),
  };
  return result;
}

async function getLolMatchDetailsAndRaw(
  input: string,
  includeRaw = false,
): Promise<{ details: LolMatchDetails; raw: unknown }> {
  if (!isMatchId(input)) throw new RiotSearchError("invalid_request");
  const persistenceEnabled = isLolPersistenceEnabled();
  const dataDragonVersion = await getLolDataDragonVersion();
  const cacheKey = lolMatchCacheKey(
    input,
    LOL_PLATFORM,
    LOL_REGIONAL_ROUTE,
    `${dataDragonVersion}:${LOL_MATCH_DETAILS_VERSION}`,
  );
  let rawCacheChecked = false;
  let cachedRaw: unknown;
  if (persistenceEnabled) {
    const cached = await getLolApiCache<LolMatchDetails>(
      "match_details",
      cacheKey,
      LOL_PLATFORM,
      LOL_REGIONAL_ROUTE,
      dataDragonVersion,
    );
    if (cached && !includeRaw) return { details: { ...cached, dataDragonVersion }, raw: undefined };
    if (cached) {
      cachedRaw = await getLolMatchRequestJson(input, LOL_PLATFORM, LOL_REGIONAL_ROUTE);
      rawCacheChecked = true;
      if (cachedRaw && String((cachedRaw as any)?.metadata?.matchId ?? "") === input
        && Array.isArray((cachedRaw as any)?.info?.participants)) return { details: { ...cached, dataDragonVersion }, raw: cachedRaw };
    }
  }
  const lease = persistenceEnabled
    ? await acquireLolCollectionLease(`match:${input}`, 45)
    : null;
  if (persistenceEnabled && !lease) throw new RiotSearchError("busy", 2);
  let saved = false;
  try {
    const storedRaw = persistenceEnabled
      ? rawCacheChecked ? cachedRaw : await getLolMatchRequestJson(input, LOL_PLATFORM, LOL_REGIONAL_ROUTE)
      : undefined;
    const raw = storedRaw ?? (persistenceEnabled
      ? (
        (await requestJson<any>(
          "asia",
          `/lol/match/v5/matches/${encodeURIComponent(input)}`,
          MATCH_TTL_MS,
        ))
      ) : await requestJson<any>(
          "asia",
          `/lol/match/v5/matches/${encodeURIComponent(input)}`,
          MATCH_TTL_MS,
        ));
    const info = raw?.info;
    if (
      String(raw?.metadata?.matchId ?? "") !== input ||
      !Array.isArray(info?.participants)
    )
      throw new RiotSearchError("upstream");
    if (Number(info.queueId) === 0 || info.gameType === "CUSTOM_GAME")
      throw new RiotSearchError("restricted_match");
    const metadata = await getStaticData(true, dataDragonVersion);
    const result = {
      dataDragonVersion,
      matchId: input,
      queueId: Number(info.queueId) || 0,
      gameMode: String(info.gameMode ?? "Unknown"),
      gameDuration: optionalNonNegativeNumber(info.gameDuration),
      ...buildMatchDetails(raw, metadata),
    };
    if (lease) {
      await persistLolMatchDetails({
        lease,
        cacheKey,
        cachePayload: result,
        platform: LOL_PLATFORM,
        route: LOL_REGIONAL_ROUTE,
        version: dataDragonVersion,
        raw,
        participants: info.participants,
        teams: info.teams ?? [],
      });
      saved = true;
    }
    return { details: result, raw };
  } finally {
    if (lease && !saved) {
      try {
        await releaseLolCollectionLease(lease);
      } catch {
        /* lease 만료가 해제 실패를 복구한다 */
      }
    }
  }
}

// 타임라인은 상세 탭에서 빌드를 열 때만 1회 요청하고, 가공한 빌드만 잠시 메모리에 둔다.
const LOL_BUILD_TTL_MS = 30 * 60_000;
const LOL_TIMELINE_MAX_BYTES = 8 * 1024 * 1024;

export async function getLolMatchBuild(input: string, storedOnly = false): Promise<LolMatchBuild> {
  if (!isMatchId(input)) throw new RiotSearchError("invalid_request");
  if (storedOnly && (!isLolPersistenceEnabled() || !await hasLolStoredMatch(input))) throw new RiotSearchError("not_found");
  const cacheKey = `build:v1:${input}`;
  const cached = getCached<LolMatchBuild>(cacheKey);
  if (cached) return cached;
  const { raw } = await getLolMatchDetailsAndRaw(input, true);
  const timeline = await requestJson<unknown>("asia", `/lol/match/v5/matches/${encodeURIComponent(input)}/timeline`,
    MATCH_TTL_MS, false, undefined, LOL_TIMELINE_MAX_BYTES);
  let build: LolMatchBuild;
  try {
    build = parseLolMatchBuild(timeline, raw, input);
  } catch {
    throw new RiotSearchError("upstream");
  }
  setCached(cacheKey, build, LOL_BUILD_TTL_MS);
  return build;
}

export async function getLolMatchDetails(input: string, storedOnly = false): Promise<import("./types").LolMatchDetails> {
  if (storedOnly && (!isLolPersistenceEnabled() || !await hasLolStoredMatch(input))) throw new RiotSearchError("not_found");
  return lolParticipantDto((await getLolMatchDetailsAndRaw(input)).details);
}

const LOL_REFRESH_COOLDOWN_MS = 120_000;

function refreshRemaining(lastUpdatedAt: string): number {
  const elapsed = Date.now() - Date.parse(lastUpdatedAt);
  return Number.isFinite(elapsed) ? Math.max(0, Math.ceil((LOL_REFRESH_COOLDOWN_MS - elapsed) / 1000)) : 0;
}

async function enrichMatchRecords(records: Array<{ summary: LolRecentMatch; raw: unknown }>) {
  if (!records.length) return;
  const metadata = await getStaticData(true);
  for (const { summary, raw } of records) {
    const championEntry = Object.entries(metadata.champions).find(([, champion]) => Number(champion.key) === summary.championId);
    summary.dataDragonVersion = metadata.dataDragonVersion;
    summary.championImageId = championEntry?.[0] ?? summary.championName;
    summary.championNameKo = championEntry?.[1].name ?? summary.championName;
    summary.details = buildMatchDetails(raw, metadata);
  }
}

// 전적 목록은 Riot 경기 ID 한 페이지(20개) 단위로 불러온다.
const LOL_MATCH_PAGE_SIZE = 20;

async function loadMatchRecords(puuid: string, matchIds: string[], persistDetails = false) {
  const matches: LolRecentMatch[] = [];
  const records: Array<{ summary: LolRecentMatch; raw: unknown }> = [];
  const matchFailures: LolMatchFailure[] = [];
  let loadedCount = 0;
  for (const matchId of matchIds.slice(0, LOL_MATCH_PAGE_SIZE)) {
    try {
      const stored = isLolPersistenceEnabled()
        ? persistDetails
          ? await getLolMatchDetailsAndRaw(matchId, true)
          : { raw: await getLolMatchRequestJson(matchId, LOL_PLATFORM, LOL_REGIONAL_ROUTE) }
        : undefined;
      const match = stored?.raw ?? await requestJson<any>("asia", `/lol/match/v5/matches/${encodeURIComponent(matchId)}`, MATCH_TTL_MS);
      const summary = summarizeMatch(match, puuid);
      if (!summary) matchFailures.push({ matchId, kind: "invalid_match" });
      else {
        matches.push(summary);
        records.push({ summary, raw: match });
      }
    } catch (error) {
      if (error instanceof LolLeaseExpiredError || error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence")) throw error;
      matchFailures.push({
        matchId,
        kind: error instanceof RiotSearchError ? error.kind : "upstream",
        ...(error instanceof RiotSearchError && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
      loadedCount += 1;
      if (error instanceof RiotSearchError && error.kind === "rate_limited") break;
      continue;
    }
    loadedCount += 1;
  }
  await enrichMatchRecords(records);
  return { matches, records, matchFailures, loadedCount };
}

async function loadLolMastery(puuid: string, refresh: boolean): Promise<LolMasteryComparison> {
  const recent: LolMasteryComparison["recent"] = { status: "unavailable", sampleSize: 0, champions: [] };
  try {
    const raw = await requestJson<unknown>("kr",
      `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=10`, IDENTIFIER_TTL_MS, refresh);
    const champions = parseLolMasteries(raw);
    const metadata = await getStaticData();
    return { status: "ready", recent, champions: champions.map(champion => {
      const entry = Object.entries(metadata.champions).find(([, value]) => Number(value.key) === champion.championId);
      return { ...champion, championName: entry?.[1].name ?? "알 수 없음", championImageId: entry?.[0] ?? "" };
    }) };
  } catch {
    return { status: "failed", recent, champions: [] };
  }
}

async function withLolRecentPerformance(result: LolSearchResult, puuid?: string): Promise<LolSearchResult> {
  if (!result.mastery || !isLolPersistenceEnabled()) return result;
  try {
    const accountPuuid = puuid ?? (await getLolAccountByRiotId(result.account.gameName, result.account.tagLine))?.puuid;
    if (!accountPuuid) return result;
    const rows = await getLolPlayerMatchSummaries(accountPuuid, 100);
    const metadata = await getStaticData();
    const champions = summarizeLolChampionPerformance(rows).map(champion => {
      const entry = Object.entries(metadata.champions).find(([, value]) => Number(value.key) === champion.championId);
      return { ...champion, championName: entry?.[1].name ?? champion.championName, championImageId: entry?.[0] ?? champion.championImageId };
    });
    return { ...result, recentTrends: summarizeLolRecentTrends(rows), mastery: { ...result.mastery,
      recent: { status: "ready", sampleSize: champions.reduce((sum, champion) => sum + champion.games, 0), champions } } };
  } catch {
    return { ...result, recentTrends: undefined, mastery: { ...result.mastery, recent: { status: "unavailable", sampleSize: 0, champions: [] } } };
  }
}

async function loadLolChallengeCatalog(): Promise<LolChallengeCatalog | undefined> {
  const key = "challenge-catalog:kr:ko_KR:v1";
  const persistent = isLolPersistenceEnabled();
  const cached = persistent ? await getLolChallengeCatalogCache() : getCached<LolChallengeCatalog>(key);
  if (cached) return cached;
  if (getCached<boolean>(`${key}:failed`)) return undefined;
  const inflight = state.inflight.get(key);
  if (inflight) return inflight as Promise<LolChallengeCatalog | undefined>;
  const request = (async () => {
    const lease = persistent ? await acquireLolCollectionLease(key, 60) : null;
    if (persistent && !lease) return undefined;
    try {
      if (persistent) {
        const rechecked = await getLolChallengeCatalogCache();
        if (rechecked) return rechecked;
      }
      const config = await requestJson<unknown>("kr", "/lol/challenges/v1/challenges/config", STATIC_TTL_MS, false, undefined, 8 * MAX_RESPONSE_BYTES);
      const percentiles = await requestJson<unknown>("kr", "/lol/challenges/v1/challenges/percentiles", STATIC_TTL_MS, false, undefined, 8 * MAX_RESPONSE_BYTES);
      const catalog = parseLolChallengeCatalog(config, percentiles);
      if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_RESPONSE_BYTES) throw new Error("challenge catalog too large");
      if (lease) await putLolChallengeCatalogCache(catalog, lease);
      else setCached(key, catalog, STATIC_TTL_MS, MAX_RESPONSE_BYTES);
      return catalog;
    } catch {
      setCached(`${key}:failed`, true, IDENTIFIER_TTL_MS);
      return undefined;
    } finally {
      if (lease) try { await releaseLolCollectionLease(lease); } catch { /* 만료된 lease는 자동 복구한다. */ }
    }
  })();
  state.inflight.set(key, request);
  try { return await request; } finally { state.inflight.delete(key); }
}

async function loadLolChallengeProfile(puuid: string, refresh: boolean): Promise<LolChallengeProfile> {
  try {
    const player = await requestJson<unknown>("kr", `/lol/challenges/v1/player-data/${puuid}`, IDENTIFIER_TTL_MS, refresh);
    const profile = buildLolChallengeProfile(player);
    try { return buildLolChallengeProfile(player, await loadLolChallengeCatalog()); } catch { return profile; }
  } catch {
    return { status: "failed", titleMappingUnverified: false, total: null, categories: [], rarest: [], distributionStatus: "unavailable" };
  }
}

async function searchLolRiotIdInternal(
  input: unknown,
  options: { refresh?: boolean } = {},
): Promise<LolSearchResult | LolRefreshCooldown> {
  const riotId = parseRiotId(input);
  if (!riotId) throw new RiotSearchError("invalid_request");
  const persistenceEnabled = isLolPersistenceEnabled();
  const lookupKey = `search:v11:${riotId.gameName.toLocaleLowerCase()}#${riotId.tagLine.toLocaleLowerCase()}`;
  const dataDragonVersion = await getLolDataDragonVersion();
  const persistentCacheKey = lolSearchCacheKey(riotId.gameName, riotId.tagLine, LOL_PLATFORM, LOL_REGIONAL_ROUTE, dataDragonVersion);
  const cached = persistenceEnabled
    ? await getLolApiCache<LolSearchResult>("search", persistentCacheKey, LOL_PLATFORM, LOL_REGIONAL_ROUTE, dataDragonVersion)
    : getCached<LolSearchResult>(lookupKey);
  const storedAccount = options.refresh && persistenceEnabled
    ? await getLolAccountByRiotId(riotId.gameName, riotId.tagLine)
    : undefined;
  if (cached) {
    const lastUpdatedAt = storedAccount?.accountFetchedAt
      && Date.parse(storedAccount.accountFetchedAt) > Date.parse(cached.lastUpdatedAt)
      ? storedAccount.accountFetchedAt
      : cached.lastUpdatedAt;
    const remainSeconds = refreshRemaining(lastUpdatedAt);
    if (options.refresh && remainSeconds > 0) return { status: "cooldown", remainSeconds, lastUpdatedAt };
    if (!options.refresh) return withLolRecentPerformance({ ...cached, dataDragonVersion,
      matches: cached.matches.map(match => ({ ...match, dataDragonVersion: match.dataDragonVersion ?? dataDragonVersion })), refreshRemainSeconds: remainSeconds });
  } else if (options.refresh && storedAccount?.accountFetchedAt) {
    const remainSeconds = refreshRemaining(storedAccount.accountFetchedAt);
    if (remainSeconds > 0) return { status: "cooldown", remainSeconds, lastUpdatedAt: storedAccount.accountFetchedAt };
  }
  const existing = state.inflight.get(lookupKey);
  if (existing) {
    const shared = await existing as LolSearchResult | LolRefreshCooldown;
    if ("status" in shared && !options.refresh) throw new RiotSearchError("busy", shared.remainSeconds);
    return shared;
  }
  if (state.accountOps.has(lookupKey)) throw new RiotSearchError("busy", 2);
  if (!persistenceEnabled && state.activeSearches >= 2) throw new RiotSearchError("congested");
  const lease = persistenceEnabled ? await acquireLolCollectionLease(lookupKey, 180) : null;
  if (persistenceEnabled && !lease) throw new RiotSearchError("busy", 2);
  state.accountOps.add(lookupKey);
  if (!persistenceEnabled) state.activeSearches += 1;
  let saved = false;
  const search = (async (): Promise<LolSearchResult | LolRefreshCooldown> => {
    if (options.refresh && lease) {
      const currentAccount = await getLolAccountByRiotId(riotId.gameName, riotId.tagLine);
      const remainSeconds = currentAccount ? refreshRemaining(currentAccount.accountFetchedAt) : 0;
      if (currentAccount && remainSeconds > 0)
        return { status: "cooldown", remainSeconds, lastUpdatedAt: currentAccount.accountFetchedAt };
    }
    const name = encodeURIComponent(riotId.gameName);
    const tag = encodeURIComponent(riotId.tagLine);
    const account = await requestJson<{ puuid: string; gameName: string; tagLine: string }>(
      "asia", `/riot/account/v1/accounts/by-riot-id/${name}/${tag}`, IDENTIFIER_TTL_MS, options.refresh === true,
    );
    const puuid = account.puuid;
    if (!puuid) throw new RiotSearchError("upstream");
    cacheAccount(`${account.gameName.toLocaleLowerCase()}#${account.tagLine.toLocaleLowerCase()}`, account);
    const encodedPuuid = encodeURIComponent(puuid);
    const [summoner, ranked, matchIds] = await Promise.all([
      requestJson<{ profileIconId: number; summonerLevel: number }>("kr", `/lol/summoner/v4/summoners/by-puuid/${encodedPuuid}`, IDENTIFIER_TTL_MS, options.refresh === true),
      requestJson<RiotQueueEntry[]>("kr", `/lol/league/v4/entries/by-puuid/${encodedPuuid}`, IDENTIFIER_TTL_MS, options.refresh === true),
      requestJson<string[]>("asia", `/lol/match/v5/matches/by-puuid/${encodedPuuid}/ids?start=0&count=20`, IDENTIFIER_TTL_MS, options.refresh === true),
    ]);
    const pageIds = matchIds.slice(0, 20);
    const batch = await loadMatchRecords(puuid, pageIds);
    // 숙련도 429가 현재 검색의 경기 조회를 막지 않도록 필수 조회 뒤에 요청한다.
    const mastery = await loadLolMastery(encodedPuuid, options.refresh === true);
    const challengeProfile = await loadLolChallengeProfile(encodedPuuid, options.refresh === true);
    const lastUpdatedAt = new Date().toISOString();
    const matches = batch.matches;
    const result: LolSearchResult = {
      challengeProfile,
      mastery,
      dataDragonVersion,
      account: { gameName: account.gameName, tagLine: account.tagLine },
      profile: { profileIconId: Number(summoner.profileIconId) || 0, summonerLevel: Number(summoner.summonerLevel) || 0 },
      ranked: ranked.filter((entry): entry is RiotQueueEntry & { queueType: "RANKED_SOLO_5x5" | "RANKED_FLEX_SR" } => entry.queueType === "RANKED_SOLO_5x5" || entry.queueType === "RANKED_FLEX_SR")
        .map(({ queueType, tier, rank, leaguePoints, wins, losses }) => ({ queueType, tier, rank, leaguePoints, wins, losses })),
      rankedHistory: emptyLolRankedHistory(), matches, matchIds: pageIds, loadedCount: batch.loadedCount,
      hasMore: pageIds.length > batch.loadedCount || pageIds.length === 20, matchFailures: batch.matchFailures, lastUpdatedAt,
      refreshRemainSeconds: 120,
      summaries: summarizeRecentMatches(matches, `${account.gameName}#${account.tagLine}`),
      matchStatus: pageIds.length === 0 ? "empty" : matches.length === 0 ? "failed" : batch.matchFailures.length ? "partial" : "ready",
    };
    if (lease) {
      await persistLolSearchSnapshot({
        lease, cacheKey: persistentCacheKey, cachePayload: result, platform: LOL_PLATFORM, route: LOL_REGIONAL_ROUTE,
        version: dataDragonVersion,
        account: { ...account, profileIconId: Number(summoner.profileIconId) || 0, summonerLevel: Number(summoner.summonerLevel) || 0 },
        ranked: result.ranked, matches: batch.records,
      });
      saved = true;
      result.rankedHistory = await getLolRankedHistory(puuid);
    } else setCached(lookupKey, result, LOL_REFRESH_COOLDOWN_MS);
    return withLolRecentPerformance(result, puuid);
  })();
  state.inflight.set(lookupKey, search);
  try { return await search; }
  finally {
    state.inflight.delete(lookupKey);
    if (!persistenceEnabled) state.activeSearches -= 1;
    state.accountOps.delete(lookupKey);
    if (lease && !saved) {
      try { await releaseLolCollectionLease(lease); } catch { /* lease 만료가 해제 실패를 복구한다 */ }
    }
  }
}

async function getMoreLolMatchesInternal(input: { riotId: unknown; offset: number; matchIds?: string[]; validateMatchIds?: boolean }) {
  const riotId = parseRiotId(input.riotId);
  if (!riotId || !Number.isSafeInteger(input.offset) || input.offset < 0
    || (input.matchIds !== undefined && (input.matchIds.length < 1 || input.matchIds.length > 5 || input.matchIds.some((id) => !isMatchId(id))))) {
    throw new RiotSearchError("invalid_request");
  }
  const key = `${riotId.gameName.toLocaleLowerCase()}#${riotId.tagLine.toLocaleLowerCase()}`;
  const cachedAccount = state.accounts.get(key);
  const account = cachedAccount?.expiresAt && cachedAccount.expiresAt > Date.now()
    ? cachedAccount.account
    : isLolPersistenceEnabled() ? await getLolAccountByRiotId(riotId.gameName, riotId.tagLine) : undefined;
  if (!account?.puuid) throw new RiotSearchError("not_found");
  cacheAccount(key, account);
  const lookupKey = `search:v11:${key}`;
  const idKey = input.matchIds?.join(",") ?? "page";
  const moreKey = `more:${lookupKey}:${input.offset}:${idKey}${input.validateMatchIds ? ":public" : ""}`;
  const existing = state.inflight.get(moreKey);
  if (existing) return existing;
  if (state.inflight.has(lookupKey) || state.accountOps.has(lookupKey)) throw new RiotSearchError("busy", 2);
  const lease = isLolPersistenceEnabled() ? await acquireLolCollectionLease(lookupKey, 180) : null;
  if (isLolPersistenceEnabled() && !lease) throw new RiotSearchError("busy", 2);
  state.accountOps.add(lookupKey);
  const pageStart = Math.floor(input.offset / 20) * 20;
  const pending = (async () => {
    try {
      const retryIds = Array.isArray(input.matchIds) ? input.matchIds : undefined;
      const explicitIds = retryIds !== undefined;
      const matchIds = explicitIds && !input.validateMatchIds
        ? retryIds.slice(0, 20)
        : await requestJson<string[]>("asia", `/lol/match/v5/matches/by-puuid/${encodeURIComponent(account.puuid)}/ids?start=${pageStart}&count=20`, IDENTIFIER_TTL_MS);
      if (retryIds && input.validateMatchIds && retryIds.some(id => !matchIds.includes(id))) throw new RiotSearchError("invalid_request");
      const localOffset = input.offset - pageStart;
      const selectedIds = explicitIds ? retryIds.slice(0, 5) : matchIds.slice(localOffset, localOffset + LOL_MATCH_PAGE_SIZE);
      const batch = await loadMatchRecords(account.puuid, selectedIds, true);
      return {
        matches: batch.matches, matchIds,
        loadedCount: input.offset + batch.loadedCount,
        hasMore: explicitIds || pageStart + matchIds.length > input.offset + batch.loadedCount || matchIds.length === 20,
        matchFailures: batch.matchFailures,
      };
    } finally {
      state.accountOps.delete(lookupKey);
      if (lease) {
        try { await releaseLolCollectionLease(lease); } catch { /* lease 만료가 해제 실패를 복구한다 */ }
      }
    }
  })();
  state.inflight.set(moreKey, pending);
  try { return await pending; }
  finally { state.inflight.delete(moreKey); }
}

export function clearLolPersonalCaches(): void {
  state.cache.clear();
  state.accounts.clear();
}

export async function collectLolMatches(input: { riotId: string; count: number; startOffset: number }): Promise<import("./types").LolCollectionResult> {
  const riotId = parseRiotId(input.riotId);
  if (!riotId || !Number.isInteger(input.count) || input.count < 1 || input.count > 100
    || !Number.isSafeInteger(input.startOffset) || input.startOffset < 0) throw new RiotSearchError("invalid_request");
  if (!isLolPersistenceEnabled()) throw new LolPersistenceError();
  const started = Date.now();
  const result: import("./types").LolCollectionResult = {
    requested: input.count, fetched: 0, reused: 0, failed: 0, aggregated: 0, skipped: 0,
    processed: 0, nextOffset: input.startOffset, hasMore: false, durationMs: 0,
  };
  const onFetch = () => { result.fetched += 1; };
  const key = `${riotId.gameName.toLocaleLowerCase()}#${riotId.tagLine.toLocaleLowerCase()}`;
  const lookupKey = `search:v11:${key}`;
  if (state.accountOps.has(lookupKey)) throw new RiotSearchError("busy", 2);
  const lease = await acquireLolCollectionLease(lookupKey, 120);
  if (!lease) throw new RiotSearchError("busy", 2);
  state.accountOps.add(lookupKey);
  let accountLease: Awaited<ReturnType<typeof acquireLolCollectionLease>> = null;
  try {
    const cached = state.accounts.get(key);
    const account = await getLolAccountByRiotId(riotId.gameName, riotId.tagLine)
      ?? (cached && cached.expiresAt > Date.now() ? cached.account : undefined)
      ?? await requestJson<{ puuid: string; gameName: string; tagLine: string }>("asia",
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.gameName)}/${encodeURIComponent(riotId.tagLine)}`,
        IDENTIFIER_TTL_MS, false, onFetch);
    if (!account.puuid) throw new RiotSearchError("upstream");
    cacheAccount(key, account);
    accountLease = await acquireLolCollectionLease(`collect:${account.puuid}`, 120);
    if (!accountLease) throw new RiotSearchError("busy", 2);
    const limit = Math.min(input.count, 20);
    const idKey = `collect-ids:${account.puuid}:${input.startOffset}:${limit}`;
    let ids = getCached<string[]>(idKey);
    if (!ids) {
      ids = await requestJson<string[]>("asia",
        `/lol/match/v5/matches/by-puuid/${encodeURIComponent(account.puuid)}/ids?start=${input.startOffset}&count=${limit}`,
        IDENTIFIER_TTL_MS, false, onFetch);
      if (!Array.isArray(ids) || ids.length > limit || ids.some((id) => !isMatchId(id))) throw new RiotSearchError("upstream");
      setCached(idKey, ids, MATCH_TTL_MS);
    }
    result.hasMore = ids.length === limit;
    for (const matchId of ids) {
      if (Date.now() - started > 50_000) { result.hasMore = true; break; }
      try {
        const stored = await getLolMatchRequestJson(matchId, LOL_PLATFORM, LOL_REGIONAL_ROUTE, true);
        let previouslyProcessed = false;
        if (stored) {
          result.reused += 1;
        } else {
          const matchLease = await acquireLolCollectionLease(`match:${matchId}`, 45);
          if (!matchLease) throw new RiotSearchError("busy", 2);
          let saved = false;
          try {
            previouslyProcessed = await hasLolBenchmarkProcessedMatch(matchId);
            const raw = await requestJson<any>("asia", `/lol/match/v5/matches/${encodeURIComponent(matchId)}`, MATCH_TTL_MS, false, onFetch);
            if (raw?.metadata?.matchId !== matchId || !Array.isArray(raw?.info?.participants)) throw new RiotSearchError("upstream");
            await persistLolMatchDetails({
              lease: matchLease, cacheKey: `benchmark-raw:${matchId}`, cachePayload: {},
              platform: LOL_PLATFORM, route: LOL_REGIONAL_ROUTE, version: "benchmark-raw-v1",
              raw, participants: raw.info.participants, teams: raw.info.teams ?? [],
            });
            saved = true;
          } finally {
            if (!saved) await releaseLolCollectionLease(matchLease);
          }
        }
        const benchmark = await aggregateLolMatchBenchmarks(matchId);
        // 원문이 삭제된 뒤 재수집한 경기는 기존 익명 집계의 신규 표본으로 세지 않는다.
        if (benchmark.skipped) result.skipped += 1;
        else if ((!stored && !previouslyProcessed) || benchmark.aggregated) result.aggregated += 1;
      } catch (error) {
        if (error instanceof LolPersistenceError) throw error;
        if (error instanceof RiotSearchError && ["rate_limited", "busy", "key_or_permission", "unconfigured"].includes(error.kind)) throw error;
        result.failed += 1;
      }
      result.processed += 1;
      result.nextOffset += 1;
    }
    if (result.processed < ids.length) result.hasMore = true;
  } catch (error) {
    if (!(error instanceof RiotSearchError) || !["rate_limited", "busy", "key_or_permission", "unconfigured"].includes(error.kind)) throw error;
    result.stopped = error.kind as NonNullable<typeof result.stopped>;
    result.retryAfter = error.retryAfterSeconds;
    result.hasMore = true;
  } finally {
    state.accountOps.delete(lookupKey);
    try { if (accountLease) await releaseLolCollectionLease(accountLease); }
    finally { await releaseLolCollectionLease(lease); }
  }
  result.durationMs = Date.now() - started;
  return result;
}

export function searchLolRiotId(input: unknown): Promise<import("./types").LolSearchResult>;
export function searchLolRiotId(input: unknown, options: { refresh?: boolean }): Promise<import("./types").LolSearchResult | LolRefreshCooldown>;
export async function searchLolRiotId(input: unknown, options: { refresh?: boolean } = {}) {
  const result = await searchLolRiotIdInternal(input, options);
  return "status" in result ? result : lolSearchResultDto(result);
}

export async function getMoreLolMatches(input: { riotId: unknown; offset: number; matchIds?: string[]; validateMatchIds?: boolean }) {
  return lolParticipantDto(await getMoreLolMatchesInternal(input));
}

export async function resolveLolParticipantRef(ref: string): Promise<string> {
  const puuid = openLolParticipantRef(ref);
  if (!puuid) throw new RiotSearchError("invalid_request");
  const stored = isLolPersistenceEnabled() ? (await getLolAccountNamesByPuuids([puuid]))[0] : undefined;
  const age = stored ? Date.now() - Date.parse(stored.account_fetched_at) : Infinity;
  if (stored && age >= 0 && age < 24 * 60 * 60_000) return `${stored.game_name}#${stored.tag_line}`;
  const account = await requestJson<{ puuid: string; gameName: string; tagLine: string }>(
    "asia", `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`, IDENTIFIER_TTL_MS, true,
  );
  if (account.puuid !== puuid || !parseRiotId(`${account.gameName}#${account.tagLine}`)) throw new RiotSearchError("upstream");
  return `${account.gameName}#${account.tagLine}`;
}

export async function resolveLolAccountForDeletion(input: string) {
  const riotId = parseRiotId(input);
  if (!riotId) throw new RiotSearchError("invalid_request");
  const account = await requestJson<{ puuid: string; gameName: string; tagLine: string }>("asia",
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.gameName)}/${encodeURIComponent(riotId.tagLine)}`,
    IDENTIFIER_TTL_MS, true);
  if (!account.puuid || !account.gameName || !account.tagLine) throw new RiotSearchError("upstream");
  return account;
}
