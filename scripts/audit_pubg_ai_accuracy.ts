import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisEngine } from "../lib/pubg-analysis/AnalysisEngine";
import {
  AI_CACHE_VERSION,
  RESULT_VERSION,
  TELEMETRY_VERSION,
} from "../lib/pubg-analysis/constants";
import {
  filterTelemetryEvents,
} from "../lib/pubg-analysis/telemetryContract";
import {
  normalizeMatchId,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "../lib/pubg-analysis/recentMatchSelection";
import { normalizeName } from "../lib/pubg-analysis/utils";

/** A deliberately small read-only surface accepted from Supabase or tests. */
type ReadQuery = {
  select: (columns: string) => ReadQuery;
  eq: (column: string, value: unknown) => ReadQuery;
  order: (column: string, options?: { ascending?: boolean }) => ReadQuery;
  limit: (count: number) => Promise<{ data: unknown; error: unknown }>;
};

type ReadOnlySupabaseClient = {
  from: (table: string) => ReadQuery;
};

type AuditFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AccuracyAuditSource = "real_read_only" | "synthetic_fixture";
export type AccuracyAuditPlatform = "steam" | "kakao";

export type AccuracyAuditOptions = {
  /** Omit to use real mode when all prerequisites are present. */
  source?: AccuracyAuditSource;
  nickname?: string;
  platform?: AccuracyAuditPlatform | string;
  limit?: number;
  fixturePath?: string;
  /** Test-only/in-process fixture injection; never sent to a remote service. */
  fixture?: unknown;
  /** Test-only dependency injection. The default is the global fetch. */
  fetchFn?: AuditFetch;
  /** Test-only read-only Supabase dependency injection. */
  supabase?: ReadOnlySupabaseClient;
  /** Test-only environment override; values are never included in a report. */
  env?: Record<string, string | undefined>;
  /** Write the redacted report to this local path after validation. */
  output?: string;
};

export type NumericComparison = {
  legacy: Record<string, number>;
  next: Record<string, number>;
  delta: Record<string, number>;
};

export type AccuracyAuditReport = {
  schemaVersion: "1";
  source: AccuracyAuditSource;
  fallbackReason: string | null;
  playerFingerprint: string;
  platform: AccuracyAuditPlatform;
  loadedMatchCount: number;
  versions: {
    result: number;
    telemetry: number;
    aiCache: string;
  };
  singleMatchMetrics: NumericComparison;
  recentSelection: {
    legacyCount: number;
    nextCount: number;
    legacyMatchFingerprints: string[];
    nextMatchFingerprints: string[];
    legacyExcluded: Record<string, number>;
    nextExcluded: Record<string, number>;
    legacyRecentPoolCount: number;
    legacyBest5Count: number;
    nextLimit: number;
    legacyExcludedCount: number;
    nextExcludedCount: number;
    legacyRejectionCounts: Record<string, number>;
    nextRejectionCounts: Record<string, number>;
    legacySelectionFingerprint: string;
    nextSelectionFingerprint: string;
  };
  telemetry: NumericComparison;
  remoteWritesAttempted: 0;
  externalAiCalls: 0;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MATCH_ID = /^[A-Za-z0-9._-]{1,160}$/;
const DEFAULT_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/pubg-official-shaped-telemetry.json",
);

/** This is the allowlist used by the pre-contract match route. */
const LEGACY_EVENT_ALLOWLIST = new Set<string>([
  "LogMatchStart",
  "LogPlayerCreate",
  "LogPlayerKill",
  "LogPlayerKillV2",
  "LogPlayerMakeGroggy",
  "LogPlayerRevive",
  "LogPlayerRecall",
  "LogPlayerRecallShip",
  "LogPlayerRedeploy",
  "LogPlayerRedeployBRStart",
  "LogPlayerTakeDamage",
  "LogItemUse",
  "LogPlayerUseThrowable",
  "LogThrowableUse",
  "LogProjectileHit",
  "LogGameStatePeriodic",
  "LogPhaseChange",
  "LogParachuteLanding",
  "LogMatchEnd",
]);

/** Fixed labels only: remote failures must never cross into a report or log. */
const FALLBACK_REASONS = [
  "explicit_synthetic_fixture",
  "missing_nickname",
  "invalid_platform",
  "missing_credentials",
  "database_read_failed",
  "no_valid_processed_rows",
  "match_read_failed",
  "player_not_in_match",
  "asset_missing",
  "telemetry_read_failed",
  "telemetry_shape_invalid",
  "engine_run_failed",
  "fixture_read_failed",
] as const;

type FallbackReason = (typeof FALLBACK_REASONS)[number];

type PlainRecord = Record<string, unknown>;

type AuditMatch = {
  /** Canonical ID used internally; it is never placed in a report. */
  id: string | null;
  /** Raw ID is retained only to let the selector reproduce canonicalization. */
  rawId: unknown;
  createdAt: string | null;
  matchType: string | null;
  gameMode: string | null;
  mapName: string | null;
  score: number;
  fullResult: PlainRecord;
  metadata?: MatchMetadata;
  sourceIndex: number;
};

type AuditContext = {
  teamNames: Set<string>;
  teamAccountIds: Set<string>;
};

type AuditEngineSeed = {
  matchAttr: PlainRecord;
  rosters: PlainRecord[];
  participants: PlainRecord[];
  myStats: PlainRecord;
  teamStats: PlainRecord[];
  eliteBenchmark: PlainRecord;
  myAccountId: string;
  myRosterId: string;
};

type AuditInput = {
  matches: AuditMatch[];
  telemetry: unknown[];
  context: AuditContext;
  targetMatch: AuditMatch | null;
  engineSeed: AuditEngineSeed;
  sensitiveValues: string[];
};

type MatchMetadata = {
  attributes?: PlainRecord;
  participants: PlainRecord[];
  rosters: PlainRecord[];
  telemetry: unknown[];
  myStats?: PlainRecord;
  teamStats?: PlainRecord[];
  myAccountId?: string;
  myRosterId?: string;
  eliteBenchmark?: PlainRecord;
};

type FixtureDocument = PlainRecord & {
  matches?: unknown[];
  telemetry?: unknown[];
  metadata?: MatchMetadata;
};

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function normalizePlatform(value: unknown): AccuracyAuditPlatform | null {
  const platform = typeof value === "string" ? value.trim().toLowerCase() : "";
  return platform === "steam" || platform === "kakao" ? platform : null;
}

function boundedLimit(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(number)));
}

function fixedFallbackReason(value: unknown, fallback: FallbackReason): FallbackReason {
  return typeof value === "string" && (FALLBACK_REASONS as readonly string[]).includes(value)
    ? value as FallbackReason
    : fallback;
}

function valueAt(record: PlainRecord, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function fullResultFrom(value: unknown): PlainRecord {
  if (!isRecord(value)) return {};
  if (isRecord(value.fullResult)) return value.fullResult;
  if (isRecord(value.data) && isRecord(value.data.fullResult)) return value.data.fullResult;
  return value;
}

function toAuditMatch(value: unknown, sourceIndex: number): AuditMatch | null {
  if (!isRecord(value)) return null;
  const fullResult = fullResultFrom(value);
  const rawId = firstDefined(
    value.matchId,
    value.match_id,
    value.id,
    fullResult.matchId,
    fullResult.match_id,
    fullResult.id,
  );
  const canonicalId = normalizeMatchId(rawId);
  const metadata = isRecord(fullResult.matchInfo) ? fullResult.matchInfo : {};
  const createdAt = asString(firstDefined(
    fullResult.createdAt,
    fullResult.created_at,
    value.createdAt,
    value.created_at,
    metadata.date,
    value.updated_at,
  ));
  const matchType = asString(firstDefined(
    value.matchType,
    value.match_type,
    fullResult.matchType,
    metadata.matchType,
  ));
  const gameMode = asString(firstDefined(
    value.gameMode,
    value.game_mode,
    fullResult.gameMode,
    metadata.mode,
  ));
  const mapName = asString(firstDefined(
    value.mapName,
    value.map_name,
    fullResult.mapName,
    metadata.mapId,
    metadata.map,
  ));
  const score = asNumber(firstDefined(
    value.score,
    value.benchmarkScore,
    valueAt(fullResult, "benchmark", "score"),
  ));

  return {
    id: canonicalId && MATCH_ID.test(canonicalId) ? canonicalId : null,
    rawId,
    createdAt,
    matchType,
    gameMode,
    mapName,
    score,
    fullResult,
    metadata: isRecord(value.metadata)
      ? {
          attributes: isRecord(value.metadata.attributes) ? value.metadata.attributes : undefined,
          participants: Array.isArray(value.metadata.participants)
            ? value.metadata.participants.filter(isRecord)
            : [],
          rosters: Array.isArray(value.metadata.rosters)
            ? value.metadata.rosters.filter(isRecord)
            : [],
          telemetry: Array.isArray(value.metadata.telemetry) ? value.metadata.telemetry : [],
          myStats: isRecord(value.metadata.myStats) ? value.metadata.myStats : undefined,
          teamStats: Array.isArray(value.metadata.teamStats)
            ? value.metadata.teamStats.filter(isRecord)
            : undefined,
          myAccountId: asString(value.metadata.myAccountId) || undefined,
          myRosterId: asString(value.metadata.myRosterId) || undefined,
          eliteBenchmark: isRecord(value.metadata.eliteBenchmark)
            ? value.metadata.eliteBenchmark
            : undefined,
        }
      : undefined,
    sourceIndex,
  };
}

function matchCandidates(matches: readonly AuditMatch[]): RecentMatchCandidate<AuditMatch>[] {
  return matches.map((match): RecentMatchCandidate<AuditMatch> => ({
    id: typeof match.rawId === "string" ? match.rawId : match.id,
    createdAt: match.createdAt,
    matchType: match.matchType,
    gameMode: match.gameMode,
    mapName: match.mapName,
    sourceIndex: match.sourceIndex,
    value: match,
  }));
}

function selectTargetMatch(matches: readonly AuditMatch[]): AuditMatch | null {
  const selection = selectRecentMatches(matchCandidates(matches), { limit: 1 });
  return selection.selected[0]?.value || null;
}

function normalizeContext(
  document: FixtureDocument,
  nickname: string,
): AuditContext {
  const teamNames = new Set<string>();
  const teamAccountIds = new Set<string>();
  const fixtureNames = document.teamNames;
  const fixtureAccounts = document.teamAccountIds;
  if (Array.isArray(fixtureNames)) {
    fixtureNames.forEach((value) => {
      const normalized = typeof value === "string" ? normalizeName(value) : "";
      if (normalized) teamNames.add(normalized);
    });
  }
  if (Array.isArray(fixtureAccounts)) {
    fixtureAccounts.forEach((value) => {
      if (typeof value === "string" && value.trim()) teamAccountIds.add(value.trim());
    });
  }
  if (nickname) teamNames.add(normalizeName(nickname));
  return { teamNames, teamAccountIds };
}

function syntheticParticipants(
  myStats: PlainRecord,
  context: AuditContext,
): { participants: PlainRecord[]; rosters: PlainRecord[]; myRosterId: string } {
  const participants: PlainRecord[] = [];
  const myAccountId = asString(firstDefined(myStats.playerId, myStats.accountId)) || "fixture-account";
  const myParticipantId = "fixture-participant-me";
  participants.push({
    id: myParticipantId,
    type: "participant",
    attributes: { accountId: myAccountId, stats: myStats },
  });

  const teammateNames = Array.from(context.teamNames)
    .filter((name) => name !== normalizeName(asString(myStats.name) || ""));
  const teammateIds = Array.from(context.teamAccountIds)
    .filter((accountId) => accountId !== myAccountId);
  const teammateRefs: PlainRecord[] = [];
  teammateNames.forEach((name, index) => {
    const participantId = `fixture-participant-team-${index}`;
    const accountId = teammateIds[index] || `fixture-teammate-${index}`;
    const stats: PlainRecord = {
      name,
      playerId: accountId,
      kills: 0,
      assists: 0,
      damageDealt: 0,
      winPlace: asNumber(myStats.winPlace, 100),
      timeSurvived: asNumber(myStats.timeSurvived),
    };
    participants.push({
      id: participantId,
      type: "participant",
      attributes: { accountId, stats },
    });
    teammateRefs.push({ type: "participant", id: participantId });
  });

  const myRosterId = "fixture-roster-me";
  const rosterRefs = [{ type: "participant", id: myParticipantId }, ...teammateRefs];
  return {
    participants,
    rosters: [{
      id: myRosterId,
      type: "roster",
      relationships: { participants: { data: rosterRefs } },
    }],
    myRosterId,
  };
}

function buildEngineSeed(
  match: AuditMatch | null,
  context: AuditContext,
  nickname: string,
  metadata?: MatchMetadata,
): AuditEngineSeed {
  const fullResult = match?.fullResult || {};
  const providedStats = metadata?.myStats || valueAt(fullResult, "stats");
  const myStats: PlainRecord = {
    ...(isRecord(providedStats) ? providedStats : {}),
    name: isRecord(providedStats) && asString(providedStats.name)
      ? providedStats.name
      : nickname || "FixturePlayer",
  };
  const accountId = asString(firstDefined(
    metadata?.myAccountId,
    myStats.playerId,
    myStats.accountId,
    valueAt(fullResult, "player_id"),
    Array.from(context.teamAccountIds)[0],
  )) || `${normalizeName(nickname || "fixtureplayer")}-account`;
  if (myStats.playerId === undefined && myStats.accountId === undefined) myStats.playerId = accountId;

  const metadataParticipants = metadata?.participants?.filter(isRecord) || [];
  const metadataRosters = metadata?.rosters?.filter(isRecord) || [];
  const synthetic = syntheticParticipants(myStats, context);
  const participants = metadataParticipants.length > 0
    ? metadataParticipants
    : (Array.isArray(valueAt(fullResult, "participants"))
      ? (valueAt(fullResult, "participants") as unknown[]).filter(isRecord)
      : synthetic.participants);
  const rosters = metadataRosters.length > 0
    ? metadataRosters
    : (Array.isArray(valueAt(fullResult, "rosters"))
      ? (valueAt(fullResult, "rosters") as unknown[]).filter(isRecord)
      : synthetic.rosters);
  const rosterId = asString(firstDefined(
    metadata?.myRosterId,
    valueAt(fullResult, "myRosterId"),
    rosters[0]?.id,
    synthetic.myRosterId,
  )) || synthetic.myRosterId;
  const teamStats = metadata?.teamStats?.filter(isRecord).length
    ? metadata.teamStats.filter(isRecord)
    : (Array.isArray(valueAt(fullResult, "team"))
      ? (valueAt(fullResult, "team") as unknown[])
        .map((member) => isRecord(member) && isRecord(member.stats) ? member.stats : member)
        .filter(isRecord)
      : [myStats]);
  const matchAttr: PlainRecord = {
    ...(metadata?.attributes || {}),
    id: asString(firstDefined(metadata?.attributes?.id, match?.id, match?.rawId)) || "fixture-match",
    createdAt: asString(firstDefined(
      metadata?.attributes?.createdAt,
      match?.createdAt,
      valueAt(fullResult, "createdAt"),
    )) || new Date(0).toISOString(),
    gameMode: asString(firstDefined(
      metadata?.attributes?.gameMode,
      match?.gameMode,
      valueAt(fullResult, "gameMode"),
    )) || "squad",
    mapName: asString(firstDefined(
      metadata?.attributes?.mapName,
      metadata?.attributes?.mapId,
      match?.mapName,
      valueAt(fullResult, "mapName"),
    )) || "Erangel_Main",
    matchType: asString(firstDefined(
      metadata?.attributes?.matchType,
      match?.matchType,
      valueAt(fullResult, "matchType"),
    )) || "official",
  };
  const eliteBenchmark = isRecord(metadata?.eliteBenchmark)
    ? metadata.eliteBenchmark
    : isRecord(fullResult.eliteBenchmark)
      ? fullResult.eliteBenchmark
      : { avgDamage: 400, avgKills: 3 };
  return {
    matchAttr,
    rosters,
    participants,
    myStats,
    teamStats,
    eliteBenchmark,
    myAccountId: accountId,
    myRosterId: rosterId,
  };
}

function parseFixtureDocument(value: unknown, nickname: string): AuditInput {
  if (!isRecord(value) || !Array.isArray(value.matches)) throw new Error("fixture_shape_invalid");
  const document = value as FixtureDocument;
  const rawMatches = Array.isArray(document.matches) ? document.matches : [];
  const matches = rawMatches
    .map((candidate, index) => toAuditMatch(candidate, index))
    .filter((candidate): candidate is AuditMatch => candidate !== null);
  const telemetry = Array.isArray(document.telemetry) ? document.telemetry : [];
  const sensitiveValues: string[] = [];
  const addSensitive = (candidate: unknown) => {
    if (typeof candidate === "string" && candidate.trim().length >= 4) sensitiveValues.push(candidate);
  };
  addSensitive(nickname);
  matches.forEach((match) => {
    addSensitive(match.rawId);
    const stats = valueAt(match.fullResult, "stats");
    if (isRecord(stats)) {
      addSensitive(stats.name);
      addSensitive(stats.playerId);
      addSensitive(stats.accountId);
    }
    addSensitive(match.fullResult.player_id);
  });
  const context = normalizeContext(document, nickname);
  const targetMatch = selectTargetMatch(matches);
  const metadata = targetMatch?.metadata || document.metadata;
  return {
    matches,
    telemetry,
    context,
    targetMatch,
    engineSeed: buildEngineSeed(targetMatch, context, nickname, metadata),
    sensitiveValues,
  };
}

function createBuiltinFixture(nickname: string): AuditInput {
  const normalized = normalizeName(nickname || "fixtureplayer");
  const telemetry: unknown[] = [
    { _T: "LogMatchStart", _D: "2026-08-27T00:00:00.000Z" },
    {
      _T: "LogPlayerAttack",
      _D: "2026-08-27T00:00:01.000Z",
      attacker: { name: nickname || "FixturePlayer", accountId: "account.fixture", loc: { x: 1, y: 2 } },
      weapon: { itemId: "Item_Weapon_Grenade_C" },
      damage: 10,
    },
    {
      _T: "LogPlayerTakeDamage",
      _D: "2026-08-27T00:00:01.500Z",
      attacker: { name: nickname || "FixturePlayer", accountId: "account.fixture", loc: { x: 1, y: 2 } },
      victim: { name: "Enemy0", accountId: "account.enemy.0", loc: { x: 3, y: 4 } },
      damageCauserName: "WeapM416_C",
      damage: 10,
    },
    {
      _T: "LogPlayerPosition",
      _D: "2026-08-27T00:00:01.750Z",
      character: { name: nickname || "FixturePlayer", accountId: "account.fixture", loc: { x: 5, y: 6 } },
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      _T: "LogPlayerPosition",
      _D: `2026-08-27T00:00:${String(index + 2).padStart(2, "0")}.000Z`,
      character: {
        name: `Enemy${index}`,
        accountId: `account.enemy.${index}`,
        loc: { x: index, y: index },
      },
    })),
  ];
  const fullResult: PlainRecord = {
    matchId: "fixture-match",
    player_id: normalized,
    platform: "steam",
    stats: {
      name: nickname || "FixturePlayer",
      playerId: "account.fixture",
      kills: 1,
      assists: 0,
      damageDealt: 100,
      processedDamageDealt: 100,
      winPlace: 10,
      timeSurvived: 600,
      DBNOs: 1,
    },
    benchmark: { score: 1 },
  };
  const context: AuditContext = {
    teamNames: new Set([normalized]),
    teamAccountIds: new Set(["account.fixture"]),
  };
  const targetMatch: AuditMatch = {
    id: "fixture-match",
    rawId: "fixture-match",
    createdAt: "2026-08-27T00:00:00.000Z",
    matchType: "official",
    gameMode: "squad",
    mapName: "Erangel_Main",
    score: 1,
    fullResult,
    sourceIndex: 0,
  };
  return {
    matches: [{
      id: "fixture-match",
      rawId: "fixture-match",
      createdAt: "2026-08-27T00:00:00.000Z",
      matchType: "official",
      gameMode: "squad",
      mapName: "Erangel_Main",
      score: 1,
      fullResult,
      sourceIndex: 0,
    }],
    telemetry,
    context,
    targetMatch,
    engineSeed: buildEngineSeed(targetMatch, context, nickname),
    sensitiveValues: [nickname, "FixturePlayer", "fixture-match", "account.fixture"],
  };
}

async function loadSyntheticInput(
  options: AccuracyAuditOptions,
  nickname: string,
): Promise<{ input: AuditInput; fixtureFailed: boolean }> {
  if (options.fixture !== undefined) {
    try {
      return { input: parseFixtureDocument(options.fixture, nickname), fixtureFailed: false };
    } catch {
      return { input: createBuiltinFixture(nickname), fixtureFailed: true };
    }
  }
  const fixturePath = options.fixturePath || DEFAULT_FIXTURE_PATH;
  try {
    const file = await readFile(fixturePath, "utf8");
    return { input: parseFixtureDocument(JSON.parse(file), nickname), fixtureFailed: false };
  } catch {
    return { input: createBuiltinFixture(nickname), fixtureFailed: true };
  }
}

function extractParticipantContext(
  body: unknown,
  nickname: string,
): { context: AuditContext; metadata: MatchMetadata } {
  if (!isRecord(body)) throw new Error("match_shape_invalid");
  const data = isRecord(body.data) ? body.data : {};
  const attributes = isRecord(data.attributes) ? data.attributes : {};
  const included = Array.isArray(body.included) ? body.included.filter(isRecord) : [];
  const participants = included.filter((item) => item.type === "participant");
  const rosters = included.filter((item) => item.type === "roster");
  const target = participants.find((participant) => {
    const stats = valueAt(participant, "attributes", "stats");
    return isRecord(stats) && normalizeName(asString(stats.name) || "") === normalizeName(nickname);
  });
  if (!target) throw new Error("player_not_in_match");

  const participantId = asString(target.id);
  const roster = rosters.find((candidate) => {
    const references = valueAt(candidate, "relationships", "participants", "data");
    return Array.isArray(references) && references.some((reference) => isRecord(reference) && reference.id === participantId);
  });
  const memberIds = Array.isArray(valueAt(roster || {}, "relationships", "participants", "data"))
    ? valueAt(roster || {}, "relationships", "participants", "data") as unknown[]
    : [target];
  const members = memberIds
    .map((reference) => {
      if (isRecord(reference) && reference.id) return participants.find((participant) => participant.id === reference.id);
      return isRecord(reference) ? reference : null;
    })
    .filter((member): member is PlainRecord => member !== null && isRecord(member));
  const teamNames = new Set<string>();
  const teamAccountIds = new Set<string>();
  members.forEach((member) => {
    const stats = valueAt(member, "attributes", "stats");
    if (!isRecord(stats)) return;
    const name = normalizeName(asString(stats.name) || "");
    if (name) teamNames.add(name);
    const accountId = asString(firstDefined(stats.playerId, stats.accountId, valueAt(member, "attributes", "accountId")));
    if (accountId) teamAccountIds.add(accountId);
  });
  const targetStats = valueAt(target, "attributes", "stats");
  const myStats = isRecord(targetStats) ? targetStats : {};
  const myAccountId = asString(firstDefined(
    valueAt(myStats, "playerId"),
    valueAt(myStats, "accountId"),
    valueAt(target, "attributes", "accountId"),
  ));
  const matchId = asString(valueAt(data, "id"));
  return {
    context: { teamNames, teamAccountIds },
    metadata: {
      attributes: { ...attributes, ...(matchId ? { id: matchId } : {}) },
      participants,
      rosters,
      telemetry: [],
      myStats,
      teamStats: members
        .map((member) => valueAt(member, "attributes", "stats"))
        .filter(isRecord),
      myAccountId: myAccountId || undefined,
      myRosterId: asString(roster?.id) || undefined,
      eliteBenchmark: { avgDamage: 400, avgKills: 3 },
    },
  };
}

async function fetchOfficialMatch(
  matchId: string,
  nickname: string,
  platform: AccuracyAuditPlatform,
  apiKey: string,
  fetchFn: AuditFetch,
): Promise<{ input: AuditContext; events: unknown[]; metadata: MatchMetadata }> {
  const matchUrl = `https://api.pubg.com/shards/${platform}/matches/${encodeURIComponent(matchId)}`;
  let response: Response;
  try {
    response = await fetchFn(matchUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/vnd.api+json",
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("match_read_failed");
  }
  if (!response.ok) throw new Error("match_read_failed");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("match_read_failed");
  }

  let context: AuditContext;
  let metadata: MatchMetadata;
  try {
    const extracted = extractParticipantContext(body, nickname);
    context = extracted.context;
    metadata = extracted.metadata;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "player_not_in_match";
    if (reason === "player_not_in_match") throw new Error(reason);
    throw new Error("match_read_failed");
  }

  const included = isRecord(body) && Array.isArray(body.included) ? body.included.filter(isRecord) : [];
  const asset = included.find((item) => item.type === "asset");
  const assetUrl = asString(valueAt(asset || {}, "attributes", "URL"));
  if (!assetUrl) throw new Error("asset_missing");

  let telemetryResponse: Response;
  try {
    // Official telemetry assets are public URLs; do not send the PUBG key here.
    telemetryResponse = await fetchFn(assetUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new Error("telemetry_read_failed");
  }
  if (!telemetryResponse.ok) throw new Error("telemetry_read_failed");

  let telemetryBody: unknown;
  try {
    telemetryBody = await telemetryResponse.json();
  } catch {
    throw new Error("telemetry_shape_invalid");
  }
  const events = Array.isArray(telemetryBody)
    ? telemetryBody
    : isRecord(telemetryBody) && Array.isArray(telemetryBody.events)
      ? telemetryBody.events
      : null;
  if (!events) throw new Error("telemetry_shape_invalid");
  metadata.telemetry = events;
  return { input: context, events, metadata };
}

function parseRows(
  rows: unknown,
  nickname: string,
  platform: AccuracyAuditPlatform,
): AuditMatch[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is PlainRecord => isRecord(row))
    .filter((row) => {
      const rowPlayer = asString(row.player_id);
      const rowPlatform = asString(row.platform);
      return (!rowPlayer || normalizeName(rowPlayer) === normalizeName(nickname)) &&
        (!rowPlatform || normalizePlatform(rowPlatform) === platform);
    })
    .map((row, index) => toAuditMatch(row, index))
    .filter((match): match is AuditMatch => match !== null && match.id !== null);
}

async function loadRealInput(
  options: AccuracyAuditOptions,
  nickname: string,
  platform: AccuracyAuditPlatform,
  limit: number,
  env: Record<string, string | undefined>,
): Promise<{ input: AuditInput; target: AuditMatch }> {
  const apiKey = env.PUBG_API_KEY?.trim();
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !supabaseUrl || !serviceRoleKey) throw new Error("missing_credentials");

  const supabase: ReadOnlySupabaseClient = options.supabase || createClient(
    supabaseUrl,
    serviceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ) as unknown as ReadOnlySupabaseClient;

  let result: { data: unknown; error: unknown };
  try {
    result = await supabase
      .from("processed_match_telemetry")
      .select("match_id,player_id,platform,data,updated_at")
      .eq("player_id", normalizeName(nickname))
      .eq("platform", platform)
      .order("updated_at", { ascending: false })
      .limit(limit);
  } catch {
    throw new Error("database_read_failed");
  }
  if (result.error || !Array.isArray(result.data)) throw new Error("database_read_failed");

  const matches = parseRows(result.data, nickname, platform);
  if (matches.length === 0) throw new Error("no_valid_processed_rows");

  const candidates = matches.map((match): RecentMatchCandidate<AuditMatch> => ({
    id: typeof match.rawId === "string" ? match.rawId : match.id,
    createdAt: match.createdAt,
    matchType: match.matchType,
    gameMode: match.gameMode,
    mapName: match.mapName,
    sourceIndex: match.sourceIndex,
    value: match,
  }));
  const selection = selectRecentMatches(candidates, { limit: 1 });
  const target = selection.selected[0]?.value;
  if (!target?.id) throw new Error("no_valid_processed_rows");

  const fetchFn = options.fetchFn || fetch;
  const official = await fetchOfficialMatch(target.id, nickname, platform, apiKey, fetchFn);
  const sensitiveValues = [nickname, target.id, ...matches.map((match) => String(match.rawId || ""))];
  const storedStats = valueAt(target.fullResult, "stats");
  const officialMetadata: MatchMetadata = {
    ...official.metadata,
    // Keep the canonical cached stats on the audit input. This allows both
    // engine runs to use exactly the same persisted performance context even
    // when the official participant payload has a newer display shape.
    myStats: {
      ...(isRecord(official.metadata.myStats) ? official.metadata.myStats : {}),
      ...(isRecord(storedStats) ? storedStats : {}),
    },
  };
  const context = official.input;
  return {
    input: {
      matches,
      telemetry: official.events,
      context,
      targetMatch: target,
      engineSeed: buildEngineSeed(target, context, nickname, officialMetadata),
      sensitiveValues,
    },
    target,
  };
}

function legacyLocation(value: unknown): PlainRecord | undefined {
  if (!isRecord(value)) return undefined;
  const x = asNumber(value.x, Number.NaN);
  const y = asNumber(value.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.round(x), y: Math.round(y), z: Math.round(asNumber(value.z)) };
}

const LEGACY_ACTORS = [
  "attacker",
  "victim",
  "killer",
  "maker",
  "dBNOMaker",
  "finisher",
  "character",
  "recaller",
  "reviver",
  "item",
  "recallingPlayer",
  "recalledPlayer",
] as const;

const LEGACY_SCALARS = [
  "damage",
  "damageReason",
  "damageTypeCategory",
  "damageCauserName",
  "damageCauser",
  "distance",
  "weapon",
  "weaponId",
  "dBNOId",
  "phase",
  "isGame",
  "attackId",
  "killerDamageInfo",
  "finishDamageInfo",
  "dBNODamageInfo",
  "reviveType",
  "vehicle",
] as const;

function legacyProjectEvent(event: unknown): PlainRecord | null {
  if (!isRecord(event) || typeof event._T !== "string") return null;
  const result: PlainRecord = { _T: event._T };
  if (event._D !== undefined) result._D = event._D;
  LEGACY_ACTORS.forEach((key) => {
    if (event[key] === undefined) return;
    const value = event[key];
    if (typeof value === "string") {
      result[key] = { name: value };
      return;
    }
    if (!isRecord(value)) return;
    result[key] = {
      name: firstDefined(value.name, value.characterName, value.itemId),
      accountId: firstDefined(value.accountId, value.playerId),
      teamId: value.teamId,
      location: legacyLocation(value.location),
      vehicle: value.vehicle,
    };
  });
  if (Array.isArray(event.recalledPlayers)) {
    result.recalledPlayers = event.recalledPlayers.map((value) => {
      if (!isRecord(value)) return {};
      return {
        name: firstDefined(value.name, value.characterName),
        accountId: firstDefined(value.accountId, value.playerId),
        teamId: value.teamId,
        location: legacyLocation(value.location),
      };
    });
  }
  LEGACY_SCALARS.forEach((key) => {
    if (event[key] !== undefined) result[key] = event[key];
  });
  if (isRecord(event.common) && event.common.isGame !== undefined) {
    result.common = { isGame: event.common.isGame };
  } else if (isRecord(event.Common) && event.Common.IsGame !== undefined) {
    result.Common = { IsGame: event.Common.IsGame };
  }
  if (event._T === "LogGameStatePeriodic" && isRecord(event.gameState)) {
    result.gameState = {
      safetyZonePosition: legacyLocation(event.gameState.safetyZonePosition),
      safetyZoneRadius: Math.round(asNumber(event.gameState.safetyZoneRadius)),
      poisonGasWarningPosition: legacyLocation(event.gameState.poisonGasWarningPosition),
      poisonGasWarningRadius: event.gameState.poisonGasWarningRadius == null
        ? null
        : Math.round(asNumber(event.gameState.poisonGasWarningRadius)),
    };
  }
  if (event._T === "LogMatchEnd") {
    if (event.allWeaponStats !== undefined) result.allWeaponStats = event.allWeaponStats;
    if (event.characters !== undefined) result.characters = event.characters;
  }
  return result;
}

function legacyFilter(events: readonly unknown[], context: AuditContext): PlainRecord[] {
  let enemyPositionOrdinal = 0;
  return events.flatMap((event) => {
    if (!isRecord(event) || typeof event._T !== "string") return [];
    if (event._T === "LogPlayerPosition") {
      const character = isRecord(event.character) ? event.character : {};
      const name = normalizeName(asString(firstDefined(character.name, character.characterName)) || "");
      const accountId = asString(firstDefined(character.accountId, character.playerId));
      if (context.teamNames.has(name) || (accountId !== null && context.teamAccountIds.has(accountId))) {
        const projected = legacyProjectEvent(event);
        return projected ? [projected] : [];
      }
      enemyPositionOrdinal += 1;
      if (enemyPositionOrdinal % 10 !== 0) return [];
    } else if (!LEGACY_EVENT_ALLOWLIST.has(event._T)) {
      return [];
    }
    const projected = legacyProjectEvent(event);
    return projected ? [projected] : [];
  });
}

function isTeamActor(actor: unknown, context: AuditContext): boolean {
  if (!isRecord(actor)) return false;
  const name = normalizeName(asString(firstDefined(actor.name, actor.characterName)) || "");
  const accountId = asString(firstDefined(actor.accountId, actor.playerId));
  return context.teamNames.has(name) || (accountId !== null && context.teamAccountIds.has(accountId));
}

function rejectionCounts(
  entries: Array<{ reason: string }>,
): Record<string, number> {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.reason] = (counts[entry.reason] || 0) + 1;
    return counts;
  }, {});
}

function legacyMatchReason(match: AuditMatch): string | null {
  if (!match.id) return "missing_id";
  const mode = (match.gameMode || "").toLowerCase();
  if (["event", "arcade", "custom", "training"].some((token) => mode.includes(token))) {
    return "mode_excluded";
  }
  const map = (match.mapName || "").toLowerCase();
  if (map.includes("safehouse") || map.includes("range_main") || map.includes("training")) {
    return "map_excluded";
  }
  return null;
}

function legacyDateTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareLegacyRecency(left: AuditMatch, right: AuditMatch): number {
  const leftDate = legacyDateTimestamp(left.createdAt);
  const rightDate = legacyDateTimestamp(right.createdAt);
  if (leftDate !== null || rightDate !== null) {
    if (leftDate === null) return 1;
    if (rightDate === null) return -1;
    if (leftDate !== rightDate) return rightDate - leftDate;
  }
  if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
  const leftId = String(left.id || "");
  const rightId = String(right.id || "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function metricMap(match: AuditMatch | null): Record<string, number> {
  if (!match) {
    return {
      eventCount: 0,
      positionSampleCount: 0,
      teamPositionCount: 0,
      enemyPositionCount: 0,
      redeployCharacterCount: 0,
      officialAssistArrayCount: 0,
      officialTeamKillerArrayCount: 0,
      carePackageLocationCount: 0,
      attackEventCount: 0,
      vehicleEventCount: 0,
      topLevelThrowableWeaponPresent: 0,
      processedDamageDealt: 0,
      storedProcessedDamageDealt: 0,
      initiativeSampleCount: 0,
      duelWins: 0,
      duelLosses: 0,
      damage: 0,
      processedDamage: 0,
      kills: 0,
      assists: 0,
      dbnos: 0,
      winPlace: 0,
      timeSurvived: 0,
      benchmarkScore: 0,
      teamDamageShare: 0,
      isolationIndex: 0,
      tradeKills: 0,
      revives: 0,
      utilityThrows: 0,
      utilityHits: 0,
    };
  }
  return {
    damage: round(asNumber(valueAt(match.fullResult, "stats", "damageDealt"))),
    processedDamage: round(asNumber(valueAt(match.fullResult, "stats", "processedDamageDealt",))),
    processedDamageDealt: round(asNumber(firstDefined(
      valueAt(match.fullResult, "stats", "processedDamageDealt"),
      valueAt(match.fullResult, "processedDamageDealt"),
    ))),
    storedProcessedDamageDealt: round(asNumber(firstDefined(
      valueAt(match.fullResult, "stats", "processedDamageDealt"),
      valueAt(match.fullResult, "processedDamageDealt"),
    ))),
    kills: round(asNumber(valueAt(match.fullResult, "stats", "kills"))),
    assists: round(asNumber(valueAt(match.fullResult, "stats", "assists"))),
    dbnos: round(asNumber(valueAt(match.fullResult, "stats", "DBNOs"))),
    winPlace: round(asNumber(valueAt(match.fullResult, "stats", "winPlace"))),
    timeSurvived: round(asNumber(valueAt(match.fullResult, "stats", "timeSurvived"))),
    benchmarkScore: round(match.score),
    teamDamageShare: round(asNumber(valueAt(match.fullResult, "teamImpact", "teamDamageShare"))),
    isolationIndex: round(asNumber(valueAt(match.fullResult, "isolationData", "isolationIndex"))),
    tradeKills: round(asNumber(valueAt(match.fullResult, "tradeStats", "tradeKills"))),
    revives: round(asNumber(valueAt(match.fullResult, "tradeStats", "revCount"))),
    utilityThrows: round(asNumber(valueAt(match.fullResult, "combatPressure", "utilityStats", "throwCount"))),
    utilityHits: round(asNumber(valueAt(match.fullResult, "combatPressure", "utilityStats", "hitCount"))),
    initiativeSampleCount: round(asNumber(firstDefined(
      valueAt(match.fullResult, "initiativeSampleCount"),
      valueAt(match.fullResult, "initiativeStats", "sampleCount"),
    ))),
    duelWins: round(asNumber(valueAt(match.fullResult, "duelStats", "wins"))),
    duelLosses: round(asNumber(valueAt(match.fullResult, "duelStats", "losses"))),
  };
}

function engineMetricMap(
  input: AuditInput,
  nickname: string,
  telemetry: readonly PlainRecord[],
): Record<string, number> {
  const seed = input.engineSeed;
  try {
    const engine = new AnalysisEngine(
      asString(seed.myStats.name) || nickname || "FixturePlayer",
      seed.myAccountId,
      new Set(input.context.teamNames),
      new Set(input.context.teamAccountIds),
      new Set<string>(),
      new Set<string>(),
      seed.myRosterId,
      "lite",
    );
    const result = engine.run(
      telemetry as PlainRecord[],
      seed.matchAttr,
      seed.rosters,
      seed.participants,
      seed.myStats,
      seed.teamStats,
      seed.eliteBenchmark,
    ) as unknown as PlainRecord;
    return {
      processedDamageDealt: round(asNumber(valueAt(result, "stats", "processedDamageDealt"))),
      initiativeSampleCount: round(asNumber(valueAt(result, "initiativeSampleCount"))),
      duelWins: round(asNumber(valueAt(result, "duelStats", "wins"))),
      duelLosses: round(asNumber(valueAt(result, "duelStats", "losses"))),
    };
  } catch {
    // Do not substitute persisted values for a failed engine run: that would
    // make the before/after comparison look valid while omitting the actual
    // telemetry input. The caller converts a real-mode failure to a labeled
    // synthetic fixture audit; explicit synthetic failures surface to tests.
    throw new Error("engine_run_failed");
  }
}

function hasActorFallback(event: PlainRecord): boolean {
  return ["attacker", "victim", "killer", "character", "maker", "reviver"].some((key) => {
    const actor = event[key];
    return isRecord(actor) && actor.location === undefined && actor.loc !== undefined;
  });
}

function telemetryMap(
  events: readonly PlainRecord[],
  rawCount: number,
  context: AuditContext,
): Record<string, number> {
  const map: Record<string, number> = {
    rawEvents: rawCount,
    totalEvents: events.length,
    droppedEvents: Math.max(0, rawCount - events.length),
    positionEvents: 0,
    enemyPositionEvents: 0,
    teamPositionEvents: 0,
    attackEvents: 0,
    killEvents: 0,
    damageEvents: 0,
    utilityEvents: 0,
    vehicleEvents: 0,
    carePackageEvents: 0,
    redeployEvents: 0,
    recallEvents: 0,
    zoneEvents: 0,
    officialArrayEvents: 0,
    officialAssistArrayEvents: 0,
    officialTeamKillerArrayEvents: 0,
    nestedLocationEvents: 0,
    canonicalActorLocationEvents: 0,
    canonicalItemPackageLocationEvents: 0,
    canonicalVehicleEvents: 0,
    canonicalThrowableWeaponEvents: 0,
      canonicalRedeployCharacterEntries: 0,
      actorLocFallbackEvents: 0,
      topLevelWeaponEvents: 0,
      topLevelThrowableWeaponEvents: 0,
      redeployCharacterEntries: 0,
  };
  const eventTypeCounts = new Map<string, number>();
  events.forEach((event) => {
    const type = typeof event._T === "string" ? event._T : "";
    if (type) {
      const eventKey = `eventType_${fingerprint(type)}`;
      eventTypeCounts.set(eventKey, (eventTypeCounts.get(eventKey) || 0) + 1);
    }
    if (type === "LogPlayerPosition") {
      map.positionEvents += 1;
      const actor = isRecord(event.character) ? event.character : {};
      if (isTeamActor(actor, context)) map.teamPositionEvents += 1;
      else map.enemyPositionEvents += 1;
    }
    if (type === "LogPlayerAttack") map.attackEvents += 1;
    if (type === "LogPlayerKill" || type === "LogPlayerKillV2") map.killEvents += 1;
    if (type === "LogPlayerTakeDamage" || type === "LogProjectileHit") map.damageEvents += 1;
    if (["LogPlayerUseThrowable", "LogThrowableUse", "LogExplosiveExplode"].includes(type)) map.utilityEvents += 1;
    if (["LogVehicleRide", "LogVehicleLeave"].includes(type)) map.vehicleEvents += 1;
    if (["LogCarePackageSpawn", "LogCarePackageLand"].includes(type)) map.carePackageEvents += 1;
    if (type.toLowerCase() === "logplayerredeploy" || type.toLowerCase() === "logplayerredeploybrstart") {
      map.redeployEvents += 1;
      if (Array.isArray(event.characters)) map.redeployCharacterEntries += event.characters.length;
    }
    if (["LogPlayerRecall", "LogPlayerRecallShip"].includes(type)) map.recallEvents += 1;
    if (["LogGameStatePeriodic", "LogPhaseStart", "LogPhaseChange"].includes(type)) map.zoneEvents += 1;
    if (Array.isArray(event.assists_AccountId)) {
      map.officialArrayEvents += 1;
      map.officialAssistArrayEvents += 1;
    }
    if (Array.isArray(event.teamKillers_AccountId)) {
      if (!Array.isArray(event.assists_AccountId)) map.officialArrayEvents += 1;
      map.officialTeamKillerArrayEvents += 1;
    }
    if (isRecord(event.itemPackage) && isRecord(event.itemPackage.location)) {
      map.nestedLocationEvents += 1;
      map.canonicalItemPackageLocationEvents += 1;
    }
    if (["attacker", "victim", "killer", "finisher", "maker", "dBNOMaker", "character", "reviver"].some((key) => {
      const actor = event[key];
      return isRecord(actor) && isRecord(actor.location);
    })) map.canonicalActorLocationEvents += 1;
    if (isRecord(event.vehicle)) map.canonicalVehicleEvents += 1;
    if (event.weapon !== undefined) map.canonicalThrowableWeaponEvents += 1;
    if (Array.isArray(event.characters)) map.canonicalRedeployCharacterEntries += event.characters.length;
    if (hasActorFallback(event)) map.actorLocFallbackEvents += 1;
    if (event.weapon !== undefined) map.topLevelWeaponEvents += 1;
    if (type === "LogPlayerUseThrowable" && event.weapon !== undefined) {
      map.topLevelThrowableWeaponEvents += 1;
    }
  });
  eventTypeCounts.forEach((count, key) => {
    map[key] = count;
  });
  return map;
}

function compareNumericMaps(
  legacy: Record<string, number>,
  next: Record<string, number>,
): NumericComparison {
  const keys = new Set([...Object.keys(legacy), ...Object.keys(next)]);
  const legacySafe: Record<string, number> = {};
  const nextSafe: Record<string, number> = {};
  const delta: Record<string, number> = {};
  keys.forEach((key) => {
    const oldValue = round(asNumber(legacy[key]));
    const newValue = round(asNumber(next[key]));
    legacySafe[key] = oldValue;
    nextSafe[key] = newValue;
    delta[key] = round(newValue - oldValue);
  });
  return { legacy: legacySafe, next: nextSafe, delta };
}

function buildReport(
  input: AuditInput,
  nickname: string,
  platform: AccuracyAuditPlatform,
  source: AccuracyAuditSource,
  fallbackReason: FallbackReason | null,
): AccuracyAuditReport {
  const selection = selectRecentMatches(matchCandidates(input.matches), { limit: 10 });
  const nextSelected = selection.selected.map((candidate) => candidate.value);
  const legacyValid = input.matches.filter((match) => legacyMatchReason(match) === null);
  const legacyRecentPool = [...legacyValid].sort(compareLegacyRecency).slice(0, 10);
  const legacyBest5 = [...legacyRecentPool]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  // Single-match metrics intentionally use one canonical target for both
  // sides. Selection differences belong only in recentSelection; otherwise a
  // high-scoring old match can be mistaken for a telemetry-contract change.
  const targetMatch = input.targetMatch || nextSelected[0] || legacyValid[0] || input.matches[0] || null;

  const legacyPoolIndexes = new Set(legacyRecentPool.map((match) => match.sourceIndex));
  const legacyExcludedEntries = input.matches.flatMap((match) => {
    let reason = legacyMatchReason(match);
    if (!reason && !legacyPoolIndexes.has(match.sourceIndex)) reason = "over_limit";
    return reason ? [{ idFingerprint: match.id ? fingerprint(match.id) : null, reason }] : [];
  });
  const nextExcludedEntries = selection.rejected.map((rejection) => ({
    idFingerprint: rejection.id ? fingerprint(rejection.id) : null,
    reason: rejection.reason,
  }));
  const legacyFingerprints = legacyBest5
    .map((match) => match.id)
    .filter((id): id is string => Boolean(id))
    .map(fingerprint);
  const nextFingerprints = nextSelected
    .map((match) => match.id)
    .filter((id): id is string => Boolean(id))
    .map(fingerprint);

  const rawEvents = input.telemetry;
  const legacyTelemetry = legacyFilter(rawEvents, input.context);
  const nextTelemetry = filterTelemetryEvents(rawEvents, {
    mode: "lite",
    teamNames: input.context.teamNames,
    teamAccountIds: input.context.teamAccountIds,
  });
  const legacyTelemetryMap = telemetryMap(legacyTelemetry, rawEvents.length, input.context);
  const nextTelemetryMap = telemetryMap(nextTelemetry, rawEvents.length, input.context);
  const targetMetrics = metricMap(targetMatch);
  const legacyEngineMetrics = engineMetricMap(input, nickname, legacyTelemetry);
  const nextEngineMetrics = engineMetricMap(input, nickname, nextTelemetry);

  const legacySingleMetrics = {
    ...targetMetrics,
    ...legacyEngineMetrics,
    eventCount: legacyTelemetry.length,
    positionSampleCount: legacyTelemetryMap.positionEvents,
    teamPositionCount: legacyTelemetryMap.teamPositionEvents,
    enemyPositionCount: legacyTelemetryMap.enemyPositionEvents,
    redeployCharacterCount: legacyTelemetryMap.redeployCharacterEntries,
    officialAssistArrayCount: legacyTelemetryMap.officialAssistArrayEvents,
    officialTeamKillerArrayCount: legacyTelemetryMap.officialTeamKillerArrayEvents,
    carePackageLocationCount: legacyTelemetryMap.nestedLocationEvents,
    attackEventCount: legacyTelemetryMap.attackEvents,
    vehicleEventCount: legacyTelemetryMap.vehicleEvents,
    topLevelThrowableWeaponPresent: legacyTelemetryMap.topLevelThrowableWeaponEvents > 0 ? 1 : 0,
  };
  const nextSingleMetrics = {
    ...targetMetrics,
    ...nextEngineMetrics,
    eventCount: nextTelemetry.length,
    positionSampleCount: nextTelemetryMap.positionEvents,
    teamPositionCount: nextTelemetryMap.teamPositionEvents,
    enemyPositionCount: nextTelemetryMap.enemyPositionEvents,
    redeployCharacterCount: nextTelemetryMap.redeployCharacterEntries,
    officialAssistArrayCount: nextTelemetryMap.officialAssistArrayEvents,
    officialTeamKillerArrayCount: nextTelemetryMap.officialTeamKillerArrayEvents,
    carePackageLocationCount: nextTelemetryMap.nestedLocationEvents,
    attackEventCount: nextTelemetryMap.attackEvents,
    vehicleEventCount: nextTelemetryMap.vehicleEvents,
    topLevelThrowableWeaponPresent: nextTelemetryMap.topLevelThrowableWeaponEvents > 0 ? 1 : 0,
  };

  return {
    schemaVersion: "1",
    source,
    fallbackReason,
    playerFingerprint: fingerprint(normalizeName(nickname)),
    platform,
    loadedMatchCount: input.matches.length,
    versions: {
      result: RESULT_VERSION,
      telemetry: TELEMETRY_VERSION,
      aiCache: AI_CACHE_VERSION,
    },
    singleMatchMetrics: compareNumericMaps(legacySingleMetrics, nextSingleMetrics),
    recentSelection: {
      legacyCount: legacyBest5.length,
      nextCount: nextSelected.length,
      legacyMatchFingerprints: legacyFingerprints,
      nextMatchFingerprints: nextFingerprints,
      legacyExcluded: rejectionCounts(legacyExcludedEntries),
      nextExcluded: rejectionCounts(nextExcludedEntries),
      legacyRecentPoolCount: legacyRecentPool.length,
      legacyBest5Count: legacyBest5.length,
      nextLimit: 10,
      legacyExcludedCount: legacyExcludedEntries.length,
      nextExcludedCount: nextExcludedEntries.length,
      legacyRejectionCounts: rejectionCounts(legacyExcludedEntries),
      nextRejectionCounts: rejectionCounts(nextExcludedEntries),
      legacySelectionFingerprint: fingerprint(legacyFingerprints.join("|")),
      nextSelectionFingerprint: fingerprint(nextFingerprints.join("|")),
    },
    telemetry: compareNumericMaps(legacyTelemetryMap, nextTelemetryMap),
    remoteWritesAttempted: 0,
    externalAiCalls: 0,
  };
}

function assertRedacted(report: AccuracyAuditReport, sensitiveValues: readonly string[]): void {
  const serialized = JSON.stringify(report);
  if (/https?:\/\//i.test(serialized) || /\bLog[A-Za-z0-9_]+\b/.test(serialized)) {
    throw new Error("audit_redaction_failed");
  }
  // Keep identity-shaped property names out of the public schema as well as values.
  if (/accountId|playerId|matchId/.test(serialized)) throw new Error("audit_redaction_failed");
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.trim().length >= 4 && serialized.includes(value)) {
      throw new Error("audit_redaction_failed");
    }
  }
}

function extractFallbackReason(error: unknown): FallbackReason {
  const message = error instanceof Error ? error.message : error;
  return fixedFallbackReason(message, "database_read_failed");
}

function resolveNickname(options: AccuracyAuditOptions, env: Record<string, string | undefined>): string {
  return String(options.nickname ?? env.PUBG_AUDIT_NICKNAME ?? "").trim();
}

export async function runAccuracyAudit(
  options: AccuracyAuditOptions = {},
): Promise<AccuracyAuditReport> {
  if (!options.env) dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
  const env = options.env || process.env;
  const requestedPlatform = options.platform ?? env.PUBG_AUDIT_PLATFORM ?? "steam";
  const normalizedPlatform = normalizePlatform(requestedPlatform);
  const platform = normalizedPlatform || "steam";
  const limit = boundedLimit(options.limit ?? env.PUBG_AUDIT_LIMIT);
  const requestedNickname = resolveNickname(options, env);
  const explicitSynthetic = options.source === "synthetic_fixture";
  let nickname = requestedNickname;
  let source: AccuracyAuditSource = "synthetic_fixture";
  let fallbackReason: FallbackReason | null = explicitSynthetic ? "explicit_synthetic_fixture" : null;
  let input: AuditInput;

  if (!explicitSynthetic && !normalizedPlatform) fallbackReason = "invalid_platform";

  if (!explicitSynthetic && !requestedNickname) {
    fallbackReason = "missing_nickname";
    nickname = "FixturePlayer";
  }

  if (!explicitSynthetic && requestedNickname && normalizedPlatform) {
    try {
      const real = await loadRealInput(options, requestedNickname, platform, limit, env);
      input = real.input;
      source = "real_read_only";
      nickname = requestedNickname;
      fallbackReason = null;
    } catch (error) {
      fallbackReason = extractFallbackReason(error);
      const synthetic = await loadSyntheticInput(options, requestedNickname || "FixturePlayer");
      input = synthetic.input;
      if (synthetic.fixtureFailed && fallbackReason === null) fallbackReason = "fixture_read_failed";
      nickname = requestedNickname || "FixturePlayer";
    }
  } else {
    const synthetic = await loadSyntheticInput(options, nickname || "FixturePlayer");
    input = synthetic.input;
    if (synthetic.fixtureFailed && fallbackReason === null) fallbackReason = "fixture_read_failed";
    if (!nickname) nickname = "FixturePlayer";
  }

  let report: AccuracyAuditReport;
  try {
    report = buildReport(input, nickname, platform, source, fallbackReason);
  } catch (error) {
    const isEngineFailure = error instanceof Error && error.message === "engine_run_failed";
    if (source !== "real_read_only" || !isEngineFailure) throw new Error("audit_engine_failed");
    const synthetic = await loadSyntheticInput(options, requestedNickname || "FixturePlayer");
    input = synthetic.input;
    source = "synthetic_fixture";
    fallbackReason = "engine_run_failed";
    nickname = requestedNickname || "FixturePlayer";
    report = buildReport(input, nickname, platform, source, fallbackReason);
  }
  assertRedacted(report, input.sensitiveValues);

  if (options.output) {
    try {
      const outputPath = path.resolve(process.cwd(), options.output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch {
      throw new Error("audit_output_failed");
    }
  }
  return report;
}

function parseCliArgs(argv: readonly string[], env: Record<string, string | undefined>): AccuracyAuditOptions {
  const options: AccuracyAuditOptions = {
    source: "real_read_only",
    nickname: env.PUBG_AUDIT_NICKNAME,
    platform: (env.PUBG_AUDIT_PLATFORM as AccuracyAuditPlatform | undefined) || "steam",
    limit: env.PUBG_AUDIT_LIMIT ? boundedLimit(env.PUBG_AUDIT_LIMIT) : DEFAULT_LIMIT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--nickname" && value) {
      options.nickname = value;
      index += 1;
    } else if (flag === "--platform" && value) {
      if (!normalizePlatform(value)) throw new Error("cli_invalid_platform");
      options.platform = value;
      index += 1;
    } else if (flag === "--limit" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw new Error("cli_invalid_limit");
      options.limit = parsed;
      index += 1;
    } else if (flag === "--output" && value) {
      options.output = value;
      index += 1;
    } else {
      throw new Error("cli_invalid_argument");
    }
  }
  return options;
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
  dotenv.config({ quiet: true });
  try {
    const options = parseCliArgs(process.argv.slice(2), process.env);
    const report = await runAccuracyAudit(options);
    // This is intentionally the already-redacted report; no raw input is logged.
    console.info(JSON.stringify(report, null, 2));
  } catch {
    console.error("[pubg-ai-accuracy] audit_failed");
    process.exitCode = 1;
  }
}

if (isDirectRun()) {
  void main();
}
