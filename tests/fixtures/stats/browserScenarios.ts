import matchDetailReady from "./match-detail-ready.json";
import matchesSummaryReady from "./matches-summary-ready.json";
import playerReady from "./player-ready.json";
import squadReadyJson from "./squad-ready.json";

export type MatchDetailFixture = typeof matchDetailReady;

export interface StatsQaClock {
  nowMs: number;
  nowIso: string;
  readyIso: string;
  daysAgo(days: 13 | 15 | 91): string;
}

export interface SquadGroupFixture {
  groupKey: string;
  members: readonly string[];
  matchCount: number;
}

export interface SquadMatchFixture {
  matchId: string;
  playedAt: string;
  [key: string]: unknown;
}

export interface SquadDetailFixture {
  groupKey: string;
  matchCount: number;
  stats: Record<string, unknown>;
  scores: Record<string, unknown>;
  roleProfiles: readonly Record<string, unknown>[];
  matchesSummary: readonly SquadMatchFixture[];
  squadGrade: string;
  benchmarkStats: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SquadReadyFixture {
  groups: readonly SquadGroupFixture[];
  details: {
    g1: SquadDetailFixture;
    g2: SquadDetailFixture;
  };
}

export interface MockHttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
  delayMs?: number;
}

export interface StatsApiRequest {
  recordId: number;
  method: string;
  url: string;
  pathname: string;
  query: Readonly<Record<string, string>>;
  body?: unknown;
  semanticKey: string;
}

export type StatsBrowserScenarioName =
  | "ready"
  | "player-retry"
  | "not-found-then-ready"
  | "rate-limit"
  | "summary-retry"
  | "detail-retry"
  | "squad"
  | "expired"
  | "autocomplete-abort"
  | "season-refresh"
  | "route-race";

export interface StatsScenarioState {
  readonly name: StatsBrowserScenarioName;
  resolve(request: StatsApiRequest): Promise<MockHttpResponse>;
  abort(request: StatsApiRequest): void;
  readonly counters: Readonly<Record<string, number>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const PLAYER_QUERY_KEYS = new Set(["nickname", "platform", "season", "refresh", "_t"]);
const SUMMARY_BODY_KEYS = ["matchIds", "nickname", "platform"] as const;
const MATCH_QUERY_KEYS = new Set(["matchId", "nickname", "platform"]);
const SQUAD_QUERY_KEYS = new Set(["nickname", "platform", "groupKey"]);
const DEFAULT_MATCH_ID = "match-fixture-1";
const EXPIRED_MATCH_IDS = ["match-age-13", "match-age-15", "match-age-91"] as const;
const MANY_MATCH_IDS = Array.from({ length: 16 }, (_, index) => `match-many-${index + 1}`);

const squadReady = squadReadyJson as SquadReadyFixture;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function accountIdForNickname(nickname: string): string {
  const slug = nickname
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "fixture-player";
  return `account.${slug}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function semanticQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .filter(([key]) => key !== "_t")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function createSemanticKey(input: {
  method: string;
  pathname: string;
  query: Readonly<Record<string, string>>;
  body?: unknown;
}): string {
  const queryPart = semanticQuery(input.query);
  const body = parseRequestBody(input.body);
  return `${input.method.toUpperCase()} ${input.pathname}`
    + (queryPart ? `?${queryPart}` : "")
    + (body === undefined ? "" : ` body=${stableJson(body)}`);
}

export function buildStatsApiRequest(input: {
  recordId: number;
  method: string;
  url: string;
  body?: unknown;
}): StatsApiRequest {
  const parsed = new URL(input.url, "http://stats-local.test");
  const query = Object.fromEntries(parsed.searchParams.entries());
  const body = parseRequestBody(input.body);
  return {
    recordId: input.recordId,
    method: input.method.toUpperCase(),
    url: parsed.toString(),
    pathname: parsed.pathname,
    query,
    ...(body === undefined ? {} : { body }),
    semanticKey: createSemanticKey({
      method: input.method,
      pathname: parsed.pathname,
      query,
      body,
    }),
  };
}

export function createStatsQaClock(nowMs = Date.now()): StatsQaClock {
  return {
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    readyIso: new Date(nowMs - DAY_MS).toISOString(),
    daysAgo: (days: 13 | 15 | 91) => new Date(nowMs - days * DAY_MS).toISOString(),
  };
}

export function cloneMatchDetailForRequest(input: {
  matchId: string;
  nickname: string;
  clock: StatsQaClock;
}): MatchDetailFixture {
  const clone = deepClone(matchDetailReady) as MatchDetailFixture;
  clone.matchId = input.matchId;
  clone.stats.name = input.nickname;
  clone.stats.playerId = accountIdForNickname(input.nickname);
  clone.createdAt = input.clock.readyIso;
  return clone;
}

export function playerReadyForRequest(input: {
  nickname: string;
  platform: "steam" | "kakao";
  season?: string;
  clock: StatsQaClock;
  recentMatchIds?: readonly string[];
  qaResponse?: string;
}): Record<string, unknown> {
  const clone = deepClone(playerReady) as Record<string, unknown>;
  const recentMatches = [...(input.recentMatchIds ?? [DEFAULT_MATCH_ID])];
  clone.nickname = input.nickname;
  clone.platform = input.platform;
  clone.seasonId = input.season ?? String(clone.seasonId ?? "");
  clone.updatedAt = input.clock.readyIso;
  clone.recentMatches = recentMatches;
  clone.matchModes = Object.fromEntries(recentMatches.map((matchId) => [matchId, "squad-fpp"]));
  if (input.qaResponse) clone.qaResponse = input.qaResponse;
  return clone;
}

export function cloneSummaryForRequest(input: {
  matchId: string;
  nickname: string;
  clock: StatsQaClock;
  playedAt?: string;
}): Record<string, unknown> {
  const firstSummary = Object.values(matchesSummaryReady.summaries)[0];
  const clone = deepClone(firstSummary) as Record<string, unknown>;
  const stats = (clone.stats ?? {}) as Record<string, unknown>;
  clone.matchId = input.matchId;
  clone.createdAt = input.playedAt ?? input.clock.readyIso;
  stats.name = input.nickname;
  stats.playerId = accountIdForNickname(input.nickname);
  clone.stats = stats;
  return clone;
}

function jsonResponse(status: number, body: unknown, options: {
  headers?: Readonly<Record<string, string>>;
  delayMs?: number;
} = {}): MockHttpResponse {
  return {
    status,
    body,
    headers: { ...JSON_HEADERS, ...(options.headers ?? {}) },
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
  };
}

function errorResponse(status: number, message: string, options: {
  headers?: Readonly<Record<string, string>>;
  delayMs?: number;
} = {}): MockHttpResponse {
  return jsonResponse(status, { error: message }, options);
}

function assertAllowedQuery(request: StatsApiRequest, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(request.query)) {
    if (!allowed.has(key)) throw new Error(`Unexpected query parameter: ${key}`);
  }
}

function requiredQuery(request: StatsApiRequest, key: string): string {
  const value = request.query[key];
  if (!value) throw new Error(`Missing required query parameter: ${key}`);
  return value;
}

function assertMethod(request: StatsApiRequest, expected: string): void {
  if (request.method !== expected) {
    throw new Error(`Unexpected method for ${request.pathname}: expected ${expected}, got ${request.method}`);
  }
}

function assertNoRequestBody(request: StatsApiRequest): void {
  if (request.body !== undefined) {
    throw new Error(`Unexpected body for GET ${request.pathname}`);
  }
}

function assertIdentity(nickname: string, platform: string): asserts platform is "steam" | "kakao" {
  if (platform !== "steam" && platform !== "kakao") throw new Error(`Invalid platform: ${platform}`);
  if (!nickname.trim()) throw new Error("Missing nickname");
}

function exactBodyKeys(body: unknown, expectedKeys: readonly string[]): asserts body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object");
  const keys = Object.keys(body).sort();
  const expected = [...expectedKeys].sort();
  if (stableJson(keys) !== stableJson(expected)) throw new Error("Request body keys do not match the expected contract");
}

function expectedMatchIds(name: StatsBrowserScenarioName, nickname: string): readonly string[] {
  if (name === "expired" || nickname === "ExpiredPlayer") return EXPIRED_MATCH_IDS;
  if (nickname === "EmptyPlayer") return [];
  if (nickname === "ManyMatches") return MANY_MATCH_IDS;
  return [DEFAULT_MATCH_ID];
}

function identityKey(nickname: string, platform: string): string {
  return `${nickname}:${platform}`;
}

function playerCounterKey(nickname: string, platform: string): string {
  return `player:${nickname}:${platform}`;
}

function increment(counters: Record<string, number>, key: string): number {
  const next = (counters[key] ?? 0) + 1;
  counters[key] = next;
  return next;
}

function isSupportedIdentity(name: StatsBrowserScenarioName, nickname: string, platform: string): boolean {
  if (platform !== "steam" && platform !== "kakao") return false;
  if (nickname === "OtherPlayer") return false;
  if (name === "not-found-then-ready") return nickname === "MissingPlayer" || nickname === "KakaoPlayer";
  if (name === "route-race") return nickname === "PlayerA" || nickname === "PlayerB";
  if (name === "expired") return nickname === "ExpiredPlayer";
  if (name === "squad") return nickname === "FixturePlayer";
  if (name === "summary-retry" || name === "detail-retry") return nickname === "FixturePlayer";
  if (name === "season-refresh") return nickname === "FixturePlayer" || nickname === "SeasonFailurePlayer";
  return Boolean(nickname.trim());
}

function isPlayerRequestAllowed(name: StatsBrowserScenarioName, nickname: string, platform: string): boolean {
  if (platform !== "steam" && platform !== "kakao") return false;
  if (name === "not-found-then-ready") return nickname === "MissingPlayer" || nickname === "KakaoPlayer";
  if (name === "route-race") return nickname === "PlayerA" || nickname === "PlayerB";
  if (name === "expired") return nickname === "ExpiredPlayer";
  if (name === "squad") return nickname === "FixturePlayer";
  return Boolean(nickname.trim());
}

export function createStatsBrowserScenario(input: {
  name: StatsBrowserScenarioName;
  clock: StatsQaClock;
}): StatsScenarioState {
  const counters: Record<string, number> = {};
  const reservations = new Map<number, string>();
  let rateLimitUntil = 0;
  const supportedIdentities = new Set<string>();

  const reserve = (request: StatsApiRequest, key: string): number => {
    const attempt = increment(counters, key);
    reservations.set(request.recordId, key);
    return attempt;
  };

  const abort = (request: StatsApiRequest): void => {
    const key = reservations.get(request.recordId);
    if (!key) return;
    counters[key] = Math.max(0, (counters[key] ?? 1) - 1);
    reservations.delete(request.recordId);
  };

  const resolvePlayer = (request: StatsApiRequest): MockHttpResponse => {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    assertAllowedQuery(request, PLAYER_QUERY_KEYS);
    const nickname = requiredQuery(request, "nickname");
    const platform = requiredQuery(request, "platform");
    assertIdentity(nickname, platform);
    if (request.query.refresh !== undefined && request.query.refresh !== "true") {
      throw new Error("refresh must be the literal true");
    }
    if (request.query.season !== undefined && !request.query.season) throw new Error("season cannot be empty");
    const key = playerCounterKey(nickname, platform);
    const attempt = reserve(request, key);
    const identity = identityKey(nickname, platform);

    if (input.name === "not-found-then-ready" && nickname === "MissingPlayer") {
      return jsonResponse(404, {
        error: "Player MissingPlayer was not found",
        code: "PLAYER_NOT_FOUND",
        suggestions: [{ nickname: "KakaoPlayer", platform: "kakao" }],
      });
    }
    if (!isPlayerRequestAllowed(input.name, nickname, platform)) {
      throw new Error(`Unsupported player identity: ${identity}`);
    }

    if (input.name === "rate-limit") {
      if (!rateLimitUntil) rateLimitUntil = Date.now() + 1_000;
      if (Date.now() < rateLimitUntil) {
        return errorResponse(429, "Retry after the fixture deadline", { headers: { "Retry-After": "1" } });
      }
    }
    if (input.name === "season-refresh" && nickname === "SeasonFailurePlayer" && request.query.season) {
      return errorResponse(500, "fixture season refresh failure");
    }
    if (input.name === "player-retry" && nickname === "FixturePlayer" && platform === "steam" && attempt === 1) {
      return errorResponse(500, "fixture player retry", { delayMs: 200 });
    }

    const recentMatchIds = expectedMatchIds(input.name, nickname);
    const season = request.query.season;
    const qaResponse = input.name === "season-refresh"
      ? request.query.refresh === "true"
        ? "refresh"
        : season
          ? `season:${season}`
          : "base"
      : undefined;
    const body = playerReadyForRequest({
      nickname,
      platform,
      season,
      clock: input.clock,
      recentMatchIds,
      qaResponse,
    });
    supportedIdentities.add(identity);
    return jsonResponse(200, body, {
      delayMs: input.name === "route-race" && nickname === "PlayerA" ? 600 : undefined,
    });
  };

  const resolveSuggest = (request: StatsApiRequest): MockHttpResponse => {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    assertAllowedQuery(request, new Set(["q"]));
    const query = requiredQuery(request, "q");
    if (input.name !== "autocomplete-abort") {
      return jsonResponse(200, { suggestions: [] });
    }
    const normalized = query.toLowerCase();
    if (normalized === "old") {
      return jsonResponse(200, { suggestions: [{ nickname: "OldPlayer", platform: "steam" }] }, { delayMs: 500 });
    }
    if (normalized === "latest" || normalized === "new") {
      return jsonResponse(200, { suggestions: [{ nickname: "LatestPlayer", platform: "kakao" }] });
    }
    return jsonResponse(200, { suggestions: [] });
  };

  const resolveSummary = (request: StatsApiRequest): MockHttpResponse => {
    assertMethod(request, "POST");
    assertAllowedQuery(request, new Set());
    exactBodyKeys(request.body, SUMMARY_BODY_KEYS);
    const matchIds = request.body.matchIds;
    const nickname = request.body.nickname;
    const platform = request.body.platform;
    if (!Array.isArray(matchIds) || matchIds.some((value) => typeof value !== "string")) {
      throw new Error("Summary body matchIds must be a string array");
    }
    if (typeof nickname !== "string" || typeof platform !== "string") throw new Error("Summary body identity is invalid");
    assertIdentity(nickname, platform);
    if (!isSupportedIdentity(input.name, nickname, platform)) throw new Error("Summary body identity is not owned by this scenario");
    const expectedIds = expectedMatchIds(input.name, nickname);
    if (stableJson(matchIds) !== stableJson(expectedIds)) throw new Error("Summary body matchIds do not match the player response");
    const key = `summary:${nickname}:${platform}:${matchIds.join(",")}`;
    const attempt = reserve(request, key);
    if (input.name === "summary-retry" && attempt === 1) return errorResponse(500, "fixture summary retry");
    const summaries = Object.fromEntries(matchIds.map((matchId, index) => [
      matchId,
      cloneSummaryForRequest({
        matchId,
        nickname,
        clock: input.clock,
        playedAt: input.name === "expired" ? input.clock.daysAgo([13, 15, 91][index] as 13 | 15 | 91) : undefined,
      }),
    ]));
    return jsonResponse(200, { summaries, missingMatchIds: [] });
  };

  const resolveDetail = (request: StatsApiRequest): MockHttpResponse => {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    assertAllowedQuery(request, MATCH_QUERY_KEYS);
    const matchId = requiredQuery(request, "matchId");
    const nickname = requiredQuery(request, "nickname");
    const platform = requiredQuery(request, "platform");
    assertIdentity(nickname, platform);
    if (!isSupportedIdentity(input.name, nickname, platform)) throw new Error("Detail identity is not owned by this scenario");
    if (!matchId.startsWith("match-")) throw new Error(`Unknown matchId: ${matchId}`);
    const key = `detail:${matchId}:${nickname}:${platform}`;
    const attempt = reserve(request, key);
    if (input.name === "detail-retry" && attempt === 1) {
      return errorResponse(500, "fixture detail retry");
    }
    return jsonResponse(200, cloneMatchDetailForRequest({ matchId, nickname, clock: input.clock }));
  };

  const resolveSquad = (request: StatsApiRequest): MockHttpResponse => {
    assertMethod(request, "GET");
    assertNoRequestBody(request);
    assertAllowedQuery(request, SQUAD_QUERY_KEYS);
    const nickname = requiredQuery(request, "nickname");
    const platform = requiredQuery(request, "platform");
    assertIdentity(nickname, platform);
    if (!isSupportedIdentity(input.name, nickname, platform)) throw new Error("Squad identity is not owned by this scenario");
    const groupKey = request.query.groupKey;
    if (!groupKey) return jsonResponse(200, { groups: squadReady.groups });
    if (groupKey !== "g1" && groupKey !== "g2") throw new Error(`Unknown squad groupKey: ${groupKey}`);
    return jsonResponse(200, squadReady.details[groupKey]);
  };

  const resolve = async (request: StatsApiRequest): Promise<MockHttpResponse> => {
    if (!request.pathname.startsWith("/api/pubg/")) {
      throw new Error(`Unexpected endpoint: ${request.pathname}`);
    }
    if (["/api/pubg/ai-summary", "/api/pubg/ai-analyze", "/api/pubg/ai-squad"].includes(request.pathname)) {
      throw new Error(`Fatal unauthenticated AI request: ${request.pathname}`);
    }
    switch (request.pathname) {
      case "/api/pubg/player": return resolvePlayer(request);
      case "/api/pubg/suggest": return resolveSuggest(request);
      case "/api/pubg/matches-summary": return resolveSummary(request);
      case "/api/pubg/match": return resolveDetail(request);
      case "/api/pubg/squad-analyze": return resolveSquad(request);
      default: throw new Error(`Unexpected endpoint: ${request.pathname}`);
    }
  };

  return {
    name: input.name,
    resolve,
    abort,
    counters,
  };
}
