import { createHash } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import type { PlayerMatchRecord } from "../pubg/playerMatches";
import { hasObservedPlayerMatchValues } from "../pubg/playerMatches";
import { getMatchDetailRetention, MATCH_DETAIL_RETENTION_DAYS } from "./matchRetention";
import { buildSharedTelemetrySourceKey } from "./sharedTelemetrySourceContract";
import { buildTelemetryAnalyzeCacheKey, buildTelemetryCacheKey } from "./telemetryCacheKey";
import type { TelemetryMode, TelemetryPlatform } from "./telemetryIdentity";

const ACCOUNT_ID = /^account\.[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OMITTED_SUMMARY_FIELDS = new Set(["timeline", "tacticalTimeline", "mapData", "team", "victims", "events"]);

export type RetainedPerformanceRow = {
  platform: string;
  account_id: string;
  match_id: string;
  player_id: string;
  played_at: string;
  source_checksum: string;
  summary_version: number;
  summary: unknown;
  calculation_version?: number;
  result_version?: number;
  benchmark?: unknown;
  score?: number | null;
  tier?: string | null;
  ranking_eligible?: boolean;
};

export type MatchRetentionAccountEvidence = {
  accountId: string;
  basicMatch: unknown;
  processedRows: unknown[];
  retainedPerformanceRows: unknown[];
  /** False only after inspecting personal maps, jobs and benchmark references. */
  detailReferenced?: boolean;
};

export function isBasicOnlyRetentionEvidence(evidence: MatchRetentionAccountEvidence): boolean {
  return isRecord(evidence.basicMatch) && evidence.basicMatch.retention_scope === "basic_only"
    && evidence.detailReferenced === false && evidence.processedRows.length === 0
    && evidence.retainedPerformanceRows.length === 0;
}

export type MatchRetentionObjectCandidate = {
  kind: "shared-source" | "personal-map" | "personal-analysis" | "legacy-analysis";
  key: string;
  etag: string;
  sizeBytes: number;
  sha256: string;
  accountId?: string;
  playerId?: string;
  mode?: TelemetryMode;
  telemetryVersion?: number;
  registryId?: number;
  registryUpdatedAt?: string;
  /** Exact master pointer that may be cleared only after this map object is deleted. */
  masterPathReferenced?: boolean;
  /** Legacy objects are identity-matched; old detail is intentionally not reconstructed after expiry. */
  reconstructionVerified?: boolean;
};

export type MatchRetentionCleanupInput = {
  matchId: string;
  platform: TelemetryPlatform;
  playedAt: string | null;
  now?: number;
  accounts: MatchRetentionAccountEvidence[];
  referencedAccountIds: string[];
  source?: {
    valid: boolean;
    playedAt: string | null;
    participantAccountIds: string[];
    participants: Array<{
      accountId: string;
      playerId: string;
      kills: number;
      damageDealt: number;
      winPlace: number;
    }>;
  };
  activeMapLease: boolean;
  pendingOrActiveDiscovery: boolean;
  pendingOrActivePerformanceJob: boolean;
  masterStoragePaths: string[];
  objects: MatchRetentionObjectCandidate[];
};

export type MatchRetentionCleanupAssessment = {
  eligible: boolean;
  reasons: string[];
  retainedAccountCount: number;
  plannedObjectCount: number;
  plannedBytes: number;
  objects: MatchRetentionObjectCandidate[];
};

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parsedDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function containsOmittedSummaryField(value: unknown, seen = new Set<object>()): boolean {
  if (Array.isArray(value)) return value.some((item) => containsOmittedSummaryField(item, seen));
  if (!isRecord(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.entries(value).some(([key, child]) => {
    if (OMITTED_SUMMARY_FIELDS.has(key)) return !Array.isArray(child) || child.length > 0;
    return containsOmittedSummaryField(child, seen);
  });
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])]));
}

export function computeFullResultSourceChecksum(fullResult: unknown): string | null {
  if (!isRecord(fullResult)) return null;
  return createHash("sha256").update(JSON.stringify(sortJsonKeys(fullResult)), "utf8").digest("hex");
}

export function legacyMapBasicSnapshot(basic: Record<string, any>): Record<string, any> {
  return Object.fromEntries(['account_id', 'player_id', 'platform', 'match_id', 'played_at', 'game_mode', 'map_name',
    'kills', 'damage', 'win_place', 'match_type', 'knocks', 'survival_time'].map(key => [key, basic[key]]));
}

/** 미확인 유형은 유지하며 전용 지도 보존 근거가 있을 때만 정리를 허용한다. */
export function hasRetainedLegacyMapEvidence(value: unknown, basic: Record<string, any>): boolean {
  if (!isRecord(value) || !isRecord(value.summary)) return false;
  const s = value.summary, e = s.retentionRecoveryEvidence;
  return s.retentionRecoveryContext === 'partial-legacy-map-events' && s.performanceHistorical === true
    && s.performanceOnly === true && value.calculation_version === 0 && value.result_version === 0
    && value.ranking_eligible === false && value.score == null && value.tier == null && value.benchmark == null
    && isRecord(e) && e.kind === 'legacy-map-retention-v1' && SHA256.test(e.sha256)
    && isDeepStrictEqual(e.basicSnapshot, legacyMapBasicSnapshot(basic))
    && value.source_checksum === computeFullResultSourceChecksum(s)
    && s.matchType === basic.match_type && s.mapName === basic.map_name && s.gameMode === basic.game_mode;
}

function basicMatchMatchesIdentity(
  value: unknown,
  input: { matchId: string; platform: string; playedAt: string; accountId: string },
): value is PlayerMatchRecord {
  if (!hasObservedPlayerMatchValues(value) || !isRecord(value)) return false;
  return value.match_id === input.matchId
    && value.platform === input.platform
    && value.account_id === input.accountId
    && ACCOUNT_ID.test(input.accountId)
    && normalized(value.player_id).length > 0
    && parsedDate(value.played_at) === parsedDate(input.playedAt)
    && typeof value.match_type === "string"
    && value.match_type.trim().length > 0
    && !["unknown", "unavailable"].includes(value.match_type.trim().toLowerCase());
}

function retainedPerformanceMatchesBasic(
  value: unknown,
  basic: PlayerMatchRecord,
  expected: { matchId: string; platform: string; accountId: string },
  fullResults: unknown[],
): boolean {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.summary.stats)) return false;
  if (value.match_id !== expected.matchId || value.platform !== expected.platform
    || value.account_id !== expected.accountId
    || normalized(value.player_id) !== normalized(basic.player_id)
    || value.summary_version !== 1 || !SHA256.test(value.source_checksum)
    || parsedDate(value.played_at) !== parsedDate(basic.played_at)) return false;

  const summary = value.summary;
  const stats = summary.stats;
  if ((summary.matchId ?? summary.match_id) !== expected.matchId
    || normalized(stats.name) !== normalized(basic.player_id)
    || stats.playerId !== expected.accountId
    || stats.kills !== basic.kills
    || !Number.isFinite(stats.damageDealt) || Math.floor(stats.damageDealt) !== basic.damage
    || stats.winPlace !== basic.win_place
    || Buffer.byteLength(JSON.stringify(summary), "utf8") > 32_768
    || containsOmittedSummaryField(summary)) return false;

  // If the full source snapshot is still present, bind the retained compact row to it.
  const availableFullResults = fullResults.filter(isRecord);
  const matchingSources = availableFullResults.filter((fullResult) =>
    computeFullResultSourceChecksum(fullResult) === value.source_checksum);
  if (availableFullResults.length > 0 && matchingSources.length === 0) return false;
  return true;
}

function accountHasPreservedSnapshot(
  evidence: MatchRetentionAccountEvidence,
  input: { matchId: string; platform: string; playedAt: string },
): boolean {
  const expected = { ...input, accountId: evidence.accountId };
  const rawBasic = evidence.basicMatch;
  const mapEvidence = isRecord(rawBasic) && evidence.retainedPerformanceRows.some(row =>
    hasRetainedLegacyMapEvidence(row, rawBasic));
  // A partial replay summary preserves existing observed stats without inventing
  // a classification. The usual evidence still requires a known match type.
  const basicForValidation = mapEvidence && isRecord(rawBasic)
    ? { ...rawBasic, match_type: 'retained-map-observations' } : rawBasic;
  if (!basicMatchMatchesIdentity(basicForValidation, expected)) return false;
  if (isBasicOnlyRetentionEvidence(evidence)) return true;
  const basic = rawBasic as PlayerMatchRecord;
  const processedRows = evidence.processedRows.filter((row) => isRecord(row)
    && row.match_id === expected.matchId && row.platform === expected.platform
    && normalized(row.player_id) === normalized(basic.player_id));
  const fullResults = processedRows.map((row) => isRecord(row) && isRecord(row.data) ? row.data.fullResult : null);
  // fullResult alone is not a durable retention snapshot. It is used only to
  // verify source_checksum when the compact row and source coexist.
  const retainedRows = evidence.retainedPerformanceRows.filter((row) => isRecord(row)
    && row.match_id === expected.matchId && row.platform === expected.platform
    && row.account_id === expected.accountId);
  const validRetainedSummary = retainedRows.some((row) =>
    retainedPerformanceMatchesBasic(row, basic, expected, fullResults));
  return validRetainedSummary;
}

function isExactPersonalObject(
  object: MatchRetentionObjectCandidate,
  account: MatchRetentionAccountEvidence,
  matchId: string,
  platform: TelemetryPlatform,
): boolean {
  if (object.kind === "shared-source") return false;
  if (object.accountId !== account.accountId || !Number.isSafeInteger(object.telemetryVersion)
    || (object.telemetryVersion ?? 0) <= 0) return false;
  if (object.kind === "legacy-analysis") {
    if (object.playerId !== normalized((account.basicMatch as PlayerMatchRecord).player_id)) return false;
    const escapedMatchId = matchId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedPlayerId = object.playerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escapedMatchId}_${escapedPlayerId}_v${object.telemetryVersion}_analyze\\.json$`)
      .test(object.key);
  }
  if (!object.mode) return false;
  const identity = {
    matchId,
    platform,
    playerId: account.accountId,
    mode: object.mode,
    telemetryVersion: object.telemetryVersion as number,
  };
  try {
    return object.key === (object.kind === "personal-map"
      ? buildTelemetryCacheKey(identity)
      : buildTelemetryAnalyzeCacheKey(identity));
  } catch {
    return false;
  }
}

function validObjectFacts(object: MatchRetentionObjectCandidate): boolean {
  return typeof object.key === "string" && object.key.length > 0
    && typeof object.etag === "string" && object.etag.trim().length > 0
    && Number.isSafeInteger(object.sizeBytes) && object.sizeBytes > 0
    && SHA256.test(object.sha256);
}

export function assessMatchRetentionCleanup(
  input: MatchRetentionCleanupInput,
): MatchRetentionCleanupAssessment {
  const reasons = new Set<string>();
  const objectExclusionReasons = new Set<string>();
  const now = input.now ?? Date.now();
  const retention = getMatchDetailRetention(input.playedAt, now);
  if (retention.status !== "expired") {
    reasons.add(retention.status === "unknown" ? "played_at_unknown" : "match_not_expired");
  }
  const playedAtMs = parsedDate(input.playedAt);
  if (playedAtMs === null) reasons.add("played_at_unknown");
  if (input.activeMapLease) reasons.add("active_map_lease");
  if (input.pendingOrActiveDiscovery) reasons.add("discovery_backlog_or_lease");
  if (input.pendingOrActivePerformanceJob) reasons.add("performance_backlog_or_lease");

  const uniqueRefs = [...new Set(input.referencedAccountIds)];
  if (uniqueRefs.length === 0 || uniqueRefs.some((accountId) => !ACCOUNT_ID.test(accountId))) {
    reasons.add("account_references_unknown");
  }
  const evidenceByAccount = new Map(input.accounts.map((item) => [item.accountId,
    input.objects.some(object => object.kind !== 'shared-source' && object.accountId === item.accountId)
      ? { ...item, detailReferenced: true } : item]));
  if (uniqueRefs.some((accountId) => !evidenceByAccount.has(accountId))) reasons.add("account_snapshot_missing");
  let retainedAccountCount = 0;
  if (playedAtMs !== null) {
    for (const accountId of uniqueRefs) {
      const evidence = evidenceByAccount.get(accountId);
      if (evidence && accountHasPreservedSnapshot(evidence, {
        matchId: input.matchId,
        platform: input.platform,
        playedAt: input.playedAt!,
      })) retainedAccountCount += 1;
      else reasons.add("account_snapshot_unverified");
    }
  }

  const source = input.source;
  const expectedSourceKey = (() => {
    try { return buildSharedTelemetrySourceKey(input.matchId, input.platform); }
    catch { return null; }
  })();
  const sourceAccountsCovered = Boolean(source?.valid && playedAtMs !== null
    && parsedDate(source.playedAt) === playedAtMs
    && uniqueRefs.every((accountId) => {
      if (!source.participantAccountIds.includes(accountId)) return false;
      const account = evidenceByAccount.get(accountId);
      const basic = account?.basicMatch;
      const participants = source.participants.filter((participant) => participant.accountId === accountId);
      return hasObservedPlayerMatchValues(basic) && participants.length === 1
        && normalized(participants[0].playerId) === normalized(basic.player_id)
        && participants[0].kills === basic.kills
        && Math.floor(participants[0].damageDealt) === basic.damage
        && participants[0].winPlace === basic.win_place;
    }));
  const knownPaths = new Set(input.masterStoragePaths);
  const objects: MatchRetentionObjectCandidate[] = [];
  for (const object of input.objects) {
    if (!validObjectFacts(object)) { objectExclusionReasons.add("object_facts_incomplete"); continue; }
    if (object.kind === "shared-source") {
      if (!expectedSourceKey || object.key !== expectedSourceKey) {
        objectExclusionReasons.add("shared_source_key_mismatch");
        continue;
      }
      if (knownPaths.has(object.key)) {
        objectExclusionReasons.add("master_storage_path_reference");
        continue;
      }
      if (!sourceAccountsCovered || uniqueRefs.some((accountId) => !evidenceByAccount.has(accountId))) {
        objectExclusionReasons.add("shared_source_reference_not_preserved");
        continue;
      }
      objects.push(object);
      continue;
    }

    const account = evidenceByAccount.get(object.accountId ?? "");
    if (!account || !isExactPersonalObject(object, account, input.matchId, input.platform)) {
      objectExclusionReasons.add("personal_object_identity_unverified");
      continue;
    }
    const mapOnlyRows = account.retainedPerformanceRows.filter(row =>
      isRecord(account.basicMatch) && hasRetainedLegacyMapEvidence(row, account.basicMatch));
    if (mapOnlyRows.length) {
      const exactSourceCovered = object.kind === 'personal-map' && mapOnlyRows.some(row => {
        if (!isRecord(row) || !isRecord(row.summary)) return false;
        const proof = row.summary.retentionRecoveryEvidence;
        return proof.key === object.key && proof.sha256 === object.sha256
          && proof.etag === object.etag && proof.sizeBytes === object.sizeBytes;
      });
      if (!exactSourceCovered) { objectExclusionReasons.add('partial_map_summary_covers_map_only'); continue; }
    }
    if (knownPaths.has(object.key) && object.kind !== "personal-map") {
      objectExclusionReasons.add("master_storage_path_reference");
      continue;
    }
    objects.push(knownPaths.has(object.key) ? { ...object, masterPathReferenced: true } : object);
  }

  if (reasons.size > 0) {
    return { eligible: false, reasons: [...reasons].sort(), retainedAccountCount,
      plannedObjectCount: 0, plannedBytes: 0, objects: [] };
  }
  const resultReasons = [...objectExclusionReasons].sort();
  if (objects.length === 0) resultReasons.push("no_verified_objects");
  return { eligible: objects.length > 0, reasons: resultReasons,
    retainedAccountCount, plannedObjectCount: objects.length,
    plannedBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0), objects };
}

export function isExpiredByMatchPlayedAt(playedAt: unknown, now = Date.now()): boolean {
  return getMatchDetailRetention(playedAt, now).status === "expired";
}

export { MATCH_DETAIL_RETENTION_DAYS };
