import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { parseSharedTelemetrySource } from "./sharedTelemetrySourceContract";
import { buildTelemetryPlayerKey } from "./telemetryCacheKey";
import { parseTelemetryPayload } from "./telemetryPayload";
import { containsTelemetryAccountEvidence } from "./telemetrySource";
import { isCanonicalMatchId, parseTelemetryPlatform, type TelemetryPlatform } from "./telemetryIdentity";

type Row = Record<string, unknown>;
type CopyKind = "legacy-byte-duplicate" | "superseded-map";
type ObjectEntry = { key: string; bytes: number; etag: string; modified?: string };
type BodyHash = { key: string; etag: string; bytes: number; sha256: string; source: "sample-read" | "fresh-read" };
type VerifiedSharedSource = {
  source: NonNullable<ReturnType<typeof parseSharedTelemetrySource>>;
  key: string;
  sha256: string;
};

export type FreshArchivedBody = {
  key: string;
  etag: string;
  bytes: number;
  body: Uint8Array;
  contentEncoding?: string;
};

export type ArchivedCopyComparisonInput = {
  snapshot: unknown;
  plan: unknown;
  classified?: unknown;
  sampleSnapshots?: unknown[];
  freshBodies?: FreshArchivedBody[];
  now?: number;
};

export type ArchivedCopyPrivateRow = {
  kind: CopyKind | "unknown";
  candidateKey?: string;
  keepKey?: string;
  candidateBytes?: number;
  keepBytes?: number;
  candidateEtag?: string;
  keepEtag?: string;
  candidateSha256?: string;
  keepSha256?: string;
  sourceKey?: string;
  sourceSha256?: string;
  bodyComparison: "equal" | "different" | "missing" | "conflict";
  hashEvidence: "fresh-read" | "prior-read" | "mixed" | "none";
  planIdentityShapeMatched: boolean;
  metadataMatched: boolean;
  legacyArrayShapeVerified: boolean;
  commonSourceConversionProven: boolean;
  personalizedFullProjectionMarker: boolean;
  currentReadVerified: boolean;
  recalculationVerified: false;
  deletionEligible: false;
  blockers: string[];
};

export type ArchivedCopyComparisonSummary = {
  schemaVersion: 1;
  readOnly: true;
  inputs: {
    inventoryComplete: boolean;
    databaseMetadataComplete: boolean;
    classificationComplete: boolean;
    planComplete: boolean;
    sampleEvidenceComplete: boolean;
    freshObjectReads: number;
    freshReadBound: 20;
  };
  totals: {
    plannedPairs: number;
    metadataMatchedPairs: number;
    planIdentityShapeMatchedPairs: number;
    byteComparisonProvenPairs: number;
    exactByteDuplicatePairs: number;
    byteDifferentPairs: number;
    freshByteDuplicatePairs: number;
    commonSourceConversionProvenPairs: number;
    identicalLegacyArrayPairs: number;
    supersededMapPairs: number;
    projectionFullMarkers: number;
    provenCandidates: number;
    deletionEligibleCandidates: 0;
  };
  blockers: Record<string, number>;
};

export type ArchivedCopyComparisonResult = {
  summary: ArchivedCopyComparisonSummary;
  privateRows: ArchivedCopyPrivateRow[];
};

const MAX_INVENTORY_OBJECTS = 100_000;
const MAX_PLAN_PAIRS = 10_000;
const MAX_SAMPLE_SNAPSHOTS = 8;
const MAX_SAMPLE_RECORDS = 1_000;
const MAX_FRESH_OBJECTS = 20;
const MAX_FRESH_BODY_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BODY_BYTES = 128 * 1024 * 1024;
const MAX_COMPARISON_MS = 120_000;
const DATABASE_TABLES = [
  "match_master_telemetry", "telemetry_map_cache_entries", "processed_match_telemetry",
  "pubg_player_matches", "pubg_player_match_discovery", "match_stats_raw", "global_benchmarks",
  "match_ai_coaching_cache", "attachments", "board_image_objects", "bonus_items",
  "crate_item_assets", "crate_items", "crate_templates", "prime_parcel_items", "support_attachments",
] as const;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashBytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function asObjectEntry(value: unknown): ObjectEntry | null {
  if (!isRecord(value) || typeof value.key !== "string" || !value.key || value.key.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value.key)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || typeof value.etag !== "string" || !value.etag || value.etag.length > 512) return null;
  return {
    key: value.key,
    bytes: value.bytes as number,
    etag: value.etag,
    ...(typeof value.modified === "string" ? { modified: value.modified } : {}),
  };
}

function inventoryDatabaseComplete(snapshot: Row): boolean {
  const database = snapshot.database;
  const report = isRecord(snapshot.report) ? snapshot.report : {};
  const tableRows = isRecord(report.tableRows) ? report.tableRows : null;
  if (!isRecord(database) || !tableRows) return false;
  return DATABASE_TABLES.every((table) => (
    Array.isArray(database[table])
    && Number.isSafeInteger(tableRows[table])
    && tableRows[table] === (database[table] as unknown[]).length
  ));
}

type SnapshotView = {
  validShape: boolean;
  inventoryComplete: boolean;
  databaseMetadataComplete: boolean;
  reportComplete: boolean;
  objectMap: Map<string, ObjectEntry>;
  sampleHashes: BodyHash[];
};

function inspectSnapshot(value: unknown, requireDatabase: boolean): SnapshotView {
  const empty: SnapshotView = {
    validShape: false, inventoryComplete: false, databaseMetadataComplete: false,
    reportComplete: false, objectMap: new Map(), sampleHashes: [],
  };
  if (!isRecord(value) || !isRecord(value.report) || !Array.isArray(value.objects)) return empty;
  const report = value.report;
  const rows = value.objects;
  if (rows.length > MAX_INVENTORY_OBJECTS || !Number.isSafeInteger(report.pages)
    || (report.pages as number) < 1 || (report.pages as number) > 100
    || !Number.isSafeInteger(report.objects) || report.objects !== rows.length
    || report.readOnly !== true) return empty;

  const objectMap = new Map<string, ObjectEntry>();
  let totalBytes = 0;
  for (const row of rows) {
    const entry = asObjectEntry(row);
    if (!entry || objectMap.has(entry.key)) return empty;
    objectMap.set(entry.key, entry);
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes)) return empty;
  }
  if (Number.isSafeInteger(report.bytes) && report.bytes !== totalBytes) return empty;
  const inventoryComplete = report.inventoryComplete === true
    || (report.inventoryComplete === undefined && report.complete === true);
  const databaseMetadataComplete = inventoryDatabaseComplete(value);
  if (requireDatabase && !databaseMetadataComplete) {
    return { ...empty, validShape: true, inventoryComplete, reportComplete: report.complete === true, objectMap };
  }

  const sampleHashes: BodyHash[] = [];
  const sampleRows = Array.isArray(value.samples) ? value.samples : [];
  if (sampleRows.length > MAX_SAMPLE_RECORDS) return empty;
  for (const sample of sampleRows) {
    if (!isRecord(sample) || typeof sample.key !== "string" || typeof sample.etag !== "string"
      || !validSha256(sample.sha256) || !Number.isSafeInteger(sample.compressedBytes)) continue;
    const item = objectMap.get(sample.key);
    if (!item || item.etag !== sample.etag || item.bytes !== sample.compressedBytes) continue;
    sampleHashes.push({ key: sample.key, etag: sample.etag, bytes: item.bytes, sha256: sample.sha256.toLowerCase(), source: "sample-read" });
  }
  return {
    validShape: true,
    inventoryComplete,
    databaseMetadataComplete,
    reportComplete: report.complete === true,
    objectMap,
    sampleHashes,
  };
}

function inspectClassified(value: unknown, inventoryCount: number): { complete: boolean; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  if (!isRecord(value) || !Array.isArray(value.objects) || value.objects.length !== inventoryCount
    || value.objects.length > MAX_INVENTORY_OBJECTS) return { complete: false, rows };
  for (const item of value.objects) {
    if (!isRecord(item) || typeof item.key !== "string" || rows.has(item.key)) return { complete: false, rows: new Map() };
    rows.set(item.key, item);
  }
  return { complete: rows.size === inventoryCount, rows };
}

function inspectPlan(value: unknown): { complete: boolean; rows: Row[] } {
  if (!isRecord(value) || !Array.isArray(value.plans) || value.plans.length > MAX_PLAN_PAIRS
    || !isRecord(value.summary) || !isRecord(value.summary.total)) return { complete: false, rows: [] };
  const total = value.summary.total;
  if (total.objects !== value.plans.length) return { complete: false, rows: value.plans.filter(isRecord) };
  const actual = new Map<string, number>();
  for (const row of value.plans) {
    if (!isRecord(row) || typeof row.kind !== "string") return { complete: false, rows: [] };
    actual.set(row.kind, (actual.get(row.kind) ?? 0) + 1);
  }
  for (const kind of ["legacy-byte-duplicate", "superseded-map"]) {
    const expected = isRecord(value.summary[kind]) ? (value.summary[kind] as Row).objects : undefined;
    if (expected !== (actual.get(kind) ?? 0)) return { complete: false, rows: value.plans.filter(isRecord) };
  }
  return { complete: true, rows: value.plans.filter(isRecord) };
}

function equalObjectMetadata(planObject: unknown, inventory: ObjectEntry | undefined): boolean {
  if (!isRecord(planObject) || !inventory) return false;
  return planObject.key === inventory.key && planObject.bytes === inventory.bytes && planObject.etag === inventory.etag;
}

function matchesClassifiedObject(planObject: unknown, classifiedObject: Row | undefined): boolean {
  if (!isRecord(planObject) || !classifiedObject || planObject.key !== classifiedObject.key
    || planObject.bytes !== classifiedObject.bytes || planObject.etag !== classifiedObject.etag) return false;
  const left = isRecord(planObject.identity) ? planObject.identity : null;
  const right = isRecord(classifiedObject.identity) ? classifiedObject.identity : null;
  if (!left || !right) return false;
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  if ([...fields].some((field) => left[field] !== right[field])) return false;
  return planObject.category === classifiedObject.category;
}

function normalizeVersion(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const match = /^v?(\d{1,6})$/i.exec(value);
  return match ? Number(match[1]) : null;
}

function sameLegacyIdentity(candidate: Row, keep: Row): boolean {
  const left = isRecord(candidate.identity) ? candidate.identity : null;
  const right = isRecord(keep.identity) ? keep.identity : null;
  return Boolean(left && right && isCanonicalMatchId(left.match) && left.match === right.match
    && typeof left.nickname === "string" && left.nickname.trim().length > 0
    && typeof right.nickname === "string" && right.nickname.trim().length > 0
    && typeof left.kind === "string" && left.kind === right.kind);
}

function sameMapIdentity(candidate: Row, keep: Row): boolean {
  const left = isRecord(candidate.identity) ? candidate.identity : null;
  const right = isRecord(keep.identity) ? keep.identity : null;
  if (!left || !right || !isCanonicalMatchId(left.match) || left.match !== right.match) return false;
  if (left.platform !== right.platform || left.player !== right.player || left.mode !== right.mode || left.kind !== right.kind) return false;
  try { parseTelemetryPlatform(left.platform); } catch { return false; }
  if (typeof left.player !== "string" || !/^[a-f0-9]{32}$/.test(left.player)) return false;
  if (left.mode !== "lite" && left.mode !== "full") return false;
  const candidateVersion = normalizeVersion(left.version);
  const keepVersion = normalizeVersion(right.version);
  return candidateVersion !== null && keepVersion !== null && candidateVersion < keepVersion;
}

function readPlanObjects(row: Row): { candidate: Row | null; keep: Row | null } {
  return {
    candidate: isRecord(row.candidate) ? row.candidate : null,
    keep: isRecord(row.keep) ? row.keep : null,
  };
}

function decodeBody(body: Uint8Array, contentEncoding?: string): Buffer | null {
  try {
    const bytes = Buffer.from(body);
    const encoding = contentEncoding?.trim().toLowerCase();
    if (encoding === "br" || encoding === "brotli") return brotliDecompressSync(bytes, { maxOutputLength: MAX_DECODED_BODY_BYTES });
    if (encoding === "gzip" || (bytes[0] === 0x1f && bytes[1] === 0x8b)) return gunzipSync(bytes, { maxOutputLength: MAX_DECODED_BODY_BYTES });
    if (encoding && encoding !== "identity") return null;
    if (bytes.length > MAX_DECODED_BODY_BYTES) return null;
    return bytes;
  } catch { return null; }
}

function parseBody(body: Uint8Array, contentEncoding?: string): unknown | null {
  const decoded = decodeBody(body, contentEncoding);
  if (!decoded) return null;
  try { return JSON.parse(decoded.toString("utf8")) as unknown; } catch { return null; }
}

function bodyEvents(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.events)) return value.events;
  if (Array.isArray(value.telemetry)) return value.telemetry;
  return null;
}

function eventSubset(events: unknown[], sourceEvents: unknown[]): boolean {
  const sourceCounts = new Map<string, number>();
  for (const event of sourceEvents) {
    const key = JSON.stringify(event);
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  for (const event of events) {
    const key = JSON.stringify(event);
    const count = sourceCounts.get(key) ?? 0;
    if (!count) return false;
    sourceCounts.set(key, count - 1);
  }
  return true;
}

function freshSourceIndex(freshBodies: FreshArchivedBody[]): Map<string, VerifiedSharedSource> {
  const result = new Map<string, VerifiedSharedSource>();
  for (const row of freshBodies) {
    const match = /^telemetry-source\/v\d+\/(steam|kakao)\/([^/]+)\.json$/.exec(row.key);
    if (!match) continue;
    const platform = match[1] as TelemetryPlatform;
    const matchId = match[2];
    if (!isCanonicalMatchId(matchId)) continue;
    const parsed = parseBody(row.body, row.contentEncoding);
    const source = parseSharedTelemetrySource(parsed, matchId, platform);
    if (!source) continue;
    const key = `${matchId}\0${platform}`;
    result.set(key, { source, key: row.key, sha256: hashBytes(row.body) });
  }
  return result;
}

function accountMatchesSource(
  kind: CopyKind,
  candidate: Row,
  keep: Row,
  source: NonNullable<ReturnType<typeof parseSharedTelemetrySource>>,
  database: Row,
): { accountIds: string[]; valid: boolean } {
  const participants = source.matchData.included.filter((row: unknown) => isRecord(row) && row.type === "participant");
  const participantRecords = participants as Row[];
  let matchedParticipants: Row[] = [];
  let accountIds: string[] = [];

  if (kind === "legacy-byte-duplicate") {
    const left = isRecord(candidate.identity) ? candidate.identity : {};
    const right = isRecord(keep.identity) ? keep.identity : {};
    if (left.match !== source.matchId || right.match !== source.matchId
      || typeof left.nickname !== "string" || typeof right.nickname !== "string") return { valid: false, accountIds };
    for (const nicknameValue of new Set([left.nickname, right.nickname])) {
      const nickname = nicknameValue.toLocaleLowerCase("en-US");
      const matches = participantRecords.filter((participant) => {
        const attributes = isRecord(participant.attributes) ? participant.attributes : {};
        const stats = isRecord(attributes.stats) ? attributes.stats : {};
        return typeof stats.name === "string" && stats.name.toLocaleLowerCase("en-US") === nickname;
      });
      if (matches.length !== 1) return { valid: false, accountIds };
      matchedParticipants.push(matches[0]);
    }
  } else {
    const left = isRecord(candidate.identity) ? candidate.identity : {};
    const right = isRecord(keep.identity) ? keep.identity : {};
    if (left.match !== source.matchId || right.match !== source.matchId || left.platform !== source.platform || right.platform !== source.platform) return { valid: false, accountIds };
    matchedParticipants = participantRecords.filter((participant) => {
      const attributes = isRecord(participant.attributes) ? participant.attributes : {};
      const stats = isRecord(attributes.stats) ? attributes.stats : {};
      const id = stats.playerId || attributes.accountId;
      return typeof id === "string" && buildTelemetryPlayerKey(id) === left.player;
    });
  }

  if (kind === "superseded-map" && matchedParticipants.length === 0) return { valid: false, accountIds };
  for (const participant of matchedParticipants) {
    const attributes = isRecord(participant.attributes) ? participant.attributes : {};
    const stats = isRecord(attributes.stats) ? attributes.stats : {};
    const participantAccount = stats.playerId || attributes.accountId;
    if (typeof participantAccount !== "string" || !participantAccount
      || !containsTelemetryAccountEvidence(source.events, participantAccount)) return { valid: false, accountIds };
    accountIds.push(participantAccount);
  }
  accountIds = [...new Set(accountIds)];
  if (!accountIds.length) return { valid: false, accountIds };

  const matchRows = Array.isArray(database.pubg_player_matches) ? database.pubg_player_matches : [];
  const officialMatchLink = accountIds.every((accountId) => matchRows.some((row: unknown) => isRecord(row)
    && row.match_id === source.matchId && row.account_id === accountId && row.platform === source.platform));
  if (!officialMatchLink) return { accountIds, valid: false };

  if (kind === "superseded-map") {
    const mapRows = Array.isArray(database.telemetry_map_cache_entries) ? database.telemetry_map_cache_entries : [];
    const hasMatchingRegistry = mapRows.some((row: unknown) => isRecord(row)
      && row.match_id === source.matchId && row.platform === source.platform
      && typeof row.player_id === "string" && buildTelemetryPlayerKey(row.player_id) === (isRecord(candidate.identity) ? candidate.identity.player : undefined)
      && (row.storage_path === candidate.key || row.storage_path === keep.key));
    return { accountIds, valid: hasMatchingRegistry };
  }
  return { accountIds, valid: true };
}

function provesCommonSourceConversion(
  kind: CopyKind,
  candidate: Row,
  keep: Row,
  sourceRecord: VerifiedSharedSource | undefined,
  freshByKey: Map<string, FreshArchivedBody>,
  database: Row,
): { valid: boolean; sourceKey?: string; sourceSha256?: string } {
  if (!sourceRecord || kind !== "legacy-byte-duplicate") return { valid: false };
  const identity = isRecord(candidate.identity) ? candidate.identity : {};
  if (typeof identity.match !== "string" || identity.match !== sourceRecord.source.matchId) return { valid: false };
  const leftBody = freshByKey.get(String(candidate.key));
  const rightBody = freshByKey.get(String(keep.key));
  if (!leftBody || !rightBody) return { valid: false, sourceKey: sourceRecord.key, sourceSha256: sourceRecord.sha256 };
  const left = parseBody(leftBody.body, leftBody.contentEncoding);
  const right = parseBody(rightBody.body, rightBody.contentEncoding);
  const leftEvents = bodyEvents(left);
  const rightEvents = bodyEvents(right);
  const account = accountMatchesSource(kind, candidate, keep, sourceRecord.source, database);
  if (!leftEvents || !rightEvents || !account.valid
    || !account.accountIds.every((accountId) => containsTelemetryAccountEvidence(leftEvents, accountId))
    || !account.accountIds.every((accountId) => containsTelemetryAccountEvidence(rightEvents, accountId))
    || !eventSubset(leftEvents, sourceRecord.source.events)
    || !eventSubset(rightEvents, sourceRecord.source.events)) {
    return { valid: false, sourceKey: sourceRecord.key, sourceSha256: sourceRecord.sha256 };
  }
  return { valid: true, sourceKey: sourceRecord.key, sourceSha256: sourceRecord.sha256 };
}

function validateMapPayload(
  candidate: Row,
  keep: Row,
  freshByKey: Map<string, FreshArchivedBody>,
): boolean {
  const validate = (row: Row): boolean => {
    const identity = isRecord(row.identity) ? row.identity : null;
    if (!identity) return false;
    const version = normalizeVersion(identity.version);
    const body = freshByKey.get(String(row.key));
    if (!version || !body) return false;
    const parsed = parseBody(body.body, body.contentEncoding);
    if (!isRecord(parsed)) return false;
    try {
      parseTelemetryPayload(parsed, {
        matchId: String(identity.match),
        platform: identity.platform as TelemetryPlatform,
        playerKey: String(identity.player),
        mode: identity.mode as "lite" | "full",
        telemetryVersion: version,
      });
      return true;
    } catch { return false; }
  };
  return validate(candidate) && validate(keep);
}

function mapRegistryReferenceCount(database: Row, key: string): number {
  const rows = Array.isArray(database.telemetry_map_cache_entries) ? database.telemetry_map_cache_entries : [];
  return rows.filter((row: unknown) => isRecord(row) && row.storage_path === key).length;
}

function addBlocker(blockers: Set<string>, value: string): void { blockers.add(value); }

export function compareArchivedMatchCopies(input: ArchivedCopyComparisonInput): ArchivedCopyComparisonResult {
  const started = Date.now();
  const checkTime = () => {
    if (Date.now() - started > MAX_COMPARISON_MS) throw new Error("archived-copy-time-bound");
  };
  const base = inspectSnapshot(input.snapshot, true);
  const plan = inspectPlan(input.plan);
  const classified = inspectClassified(input.classified, base.objectMap.size);
  const sampleSnapshots = input.sampleSnapshots ?? [];
  if (sampleSnapshots.length > MAX_SAMPLE_SNAPSHOTS) throw new Error("archived-copy-sample-bound");
  const extraViews = sampleSnapshots.map((snapshot) => inspectSnapshot(snapshot, false));
  const sampleEvidenceComplete = base.validShape && base.reportComplete && base.sampleHashes.length <= MAX_SAMPLE_RECORDS
    && extraViews.every((view) => view.validShape && view.inventoryComplete && view.reportComplete);
  const freshBodies = input.freshBodies ?? [];
  if (freshBodies.length > MAX_FRESH_OBJECTS) throw new Error("archived-copy-fresh-read-bound");
  let freshBytesTotal = 0;
  const freshByKey = new Map<string, FreshArchivedBody>();
  const objectCatalog = new Map<string, ObjectEntry>(base.objectMap);
  for (const view of extraViews) for (const [key, entry] of view.objectMap) {
    const existing = objectCatalog.get(key);
    if (!existing || existing.bytes === entry.bytes && existing.etag === entry.etag) objectCatalog.set(key, entry);
  }
  for (const row of freshBodies) {
    checkTime();
    if (typeof row.key !== "string" || typeof row.etag !== "string" || !Number.isSafeInteger(row.bytes)
      || row.bytes < 0 || row.bytes > MAX_FRESH_BODY_BYTES || row.body.byteLength !== row.bytes
      || freshByKey.has(row.key)) throw new Error("archived-copy-fresh-metadata-invalid");
    freshBytesTotal += row.bytes;
    if (freshBytesTotal > 128 * 1024 * 1024) throw new Error("archived-copy-fresh-size-bound");
    const item = objectCatalog.get(row.key);
    if (!item || item.etag !== row.etag || item.bytes !== row.bytes) continue;
    freshByKey.set(row.key, row);
  }

  const hashEvidence = new Map<string, BodyHash>();
  const hashConflicts = new Set<string>();
  const trustedSampleHashes = [
    ...(base.reportComplete && base.inventoryComplete ? base.sampleHashes : []),
    ...extraViews.flatMap((view) => view.reportComplete && view.inventoryComplete ? view.sampleHashes : []),
  ];
  for (const evidence of trustedSampleHashes) {
    const previous = hashEvidence.get(evidence.key);
    if (previous && (previous.sha256 !== evidence.sha256 || previous.etag !== evidence.etag || previous.bytes !== evidence.bytes)) {
      hashConflicts.add(evidence.key);
    } else hashEvidence.set(evidence.key, evidence);
  }
  for (const [key, body] of freshByKey) {
    const fresh: BodyHash = { key, etag: body.etag, bytes: body.bytes, sha256: hashBytes(body.body), source: "fresh-read" };
    const previous = hashEvidence.get(key);
    if (previous && (previous.sha256 !== fresh.sha256 || previous.etag !== fresh.etag || previous.bytes !== fresh.bytes)) hashConflicts.add(key);
    hashEvidence.set(key, fresh);
  }

  const sources = freshSourceIndex([...freshByKey.values()]);
  const database = isRecord(input.snapshot) && isRecord(input.snapshot.database) ? input.snapshot.database : {};
  const rows: ArchivedCopyPrivateRow[] = [];
  const blockerTotals: Record<string, number> = {};
  let metadataMatchedPairs = 0;
  let planIdentityShapeMatchedPairs = 0;
  let byteComparisonProvenPairs = 0;
  let exactByteDuplicatePairs = 0;
  let byteDifferentPairs = 0;
  let freshByteDuplicatePairs = 0;
  let commonSourceConversionProvenPairs = 0;
  let identicalLegacyArrayPairs = 0;
  let supersededMapPairs = 0;
  let projectionFullMarkers = 0;
  let provenCandidates = 0;

  for (const rawPlanRow of plan.rows) {
    checkTime();
    const kind = rawPlanRow.kind === "legacy-byte-duplicate" || rawPlanRow.kind === "superseded-map"
      ? rawPlanRow.kind : "unknown";
    const { candidate, keep } = readPlanObjects(rawPlanRow);
    const candidateKey = typeof candidate?.key === "string" ? candidate.key : undefined;
    const keepKey = typeof keep?.key === "string" ? keep.key : undefined;
    const candidateInventory = candidateKey ? base.objectMap.get(candidateKey) : undefined;
    const keepInventory = keepKey ? base.objectMap.get(keepKey) : undefined;
    const candidateClassified = candidateKey ? classified.rows.get(candidateKey) : undefined;
    const keepClassified = keepKey ? classified.rows.get(keepKey) : undefined;
    const metadataMatched = equalObjectMetadata(candidate, candidateInventory) && equalObjectMetadata(keep, keepInventory)
      && matchesClassifiedObject(candidate, candidateClassified) && matchesClassifiedObject(keep, keepClassified);
    if (metadataMatched) metadataMatchedPairs++;

    const identityMatched = kind === "legacy-byte-duplicate" && candidate && keep
      ? sameLegacyIdentity(candidate, keep)
      : kind === "superseded-map" && candidate && keep ? sameMapIdentity(candidate, keep) : false;
    if (identityMatched) planIdentityShapeMatchedPairs++;

    const candidateHash = candidateKey ? hashEvidence.get(candidateKey) : undefined;
    const keepHash = keepKey ? hashEvidence.get(keepKey) : undefined;
    const hashConflict = Boolean((candidateKey && hashConflicts.has(candidateKey)) || (keepKey && hashConflicts.has(keepKey)));
    const hashesAvailable = Boolean(candidateHash && keepHash && metadataMatched && candidateHash.etag === candidate?.etag
      && keepHash.etag === keep?.etag && candidateHash.bytes === candidate?.bytes && keepHash.bytes === keep?.bytes);
    const bodyComparison: ArchivedCopyPrivateRow["bodyComparison"] = hashConflict ? "conflict"
      : !hashesAvailable ? "missing" : candidateHash!.sha256 === keepHash!.sha256 ? "equal" : "different";
    if (bodyComparison === "equal") {
      byteComparisonProvenPairs++;
      exactByteDuplicatePairs++;
      if (candidateHash?.source === "fresh-read" && keepHash?.source === "fresh-read") freshByteDuplicatePairs++;
    }
    if (bodyComparison === "different") byteDifferentPairs++;
    if (kind === "superseded-map") supersededMapPairs++;

    const freshCandidate = candidateKey ? freshByKey.get(candidateKey) : undefined;
    const freshKeep = keepKey ? freshByKey.get(keepKey) : undefined;
    const currentReadVerified = Boolean(freshCandidate && freshKeep && metadataMatched);
    const candidateParsedBody = freshCandidate ? parseBody(freshCandidate.body, freshCandidate.contentEncoding) : null;
    const keepParsedBody = freshKeep ? parseBody(freshKeep.body, freshKeep.contentEncoding) : null;
    const legacyArrayShapeVerified = kind === "legacy-byte-duplicate"
      && Array.isArray(candidateParsedBody) && Array.isArray(keepParsedBody);
    if (bodyComparison === "equal" && metadataMatched && identityMatched && legacyArrayShapeVerified) identicalLegacyArrayPairs++;
    const personalizedFullProjectionMarker = [freshCandidate, freshKeep].some((body) => {
      if (!body) return false;
      const parsed = parseBody(body.body, body.contentEncoding);
      return isRecord(parsed) && parsed.projection === "full";
    });
    if (personalizedFullProjectionMarker) projectionFullMarkers++;

    const blockers = new Set<string>();
    if (!base.validShape || !base.inventoryComplete || !base.reportComplete) addBlocker(blockers, "snapshot-incomplete");
    if (!base.databaseMetadataComplete) addBlocker(blockers, "database-metadata-incomplete");
    if (!classified.complete) addBlocker(blockers, "classification-incomplete");
    if (!plan.complete) addBlocker(blockers, "plan-incomplete");
    if (!metadataMatched) addBlocker(blockers, "inventory-metadata-conflict");
    if (!identityMatched) addBlocker(blockers, "match-platform-account-identity-unproven");
    if (hashConflict) addBlocker(blockers, "body-hash-evidence-conflict");
    else if (bodyComparison === "missing") addBlocker(blockers, "full-byte-sha256-missing");
    else if (bodyComparison === "different") addBlocker(blockers, "body-sha256-differs");
    if (!currentReadVerified) addBlocker(blockers, "fresh-current-body-reads-missing");

    const sourceIdentity = isRecord(candidate?.identity) ? candidate!.identity : {};
    const sourcePlatform = sourceIdentity.platform;
    let sourceRecord: VerifiedSharedSource | undefined;
    if (typeof sourceIdentity.match === "string") {
      if (sourcePlatform === "steam" || sourcePlatform === "kakao") {
        sourceRecord = sources.get(`${sourceIdentity.match}\0${sourcePlatform}`);
      } else if (kind === "legacy-byte-duplicate") {
        const matches = [...sources.values()].filter((entry) => entry.source.matchId === sourceIdentity.match);
        if (matches.length === 1) sourceRecord = matches[0];
      }
    }
    const sourceProof = candidate && keep && kind !== "unknown"
      ? bodyComparison === "equal"
        ? provesCommonSourceConversion(kind, candidate, keep, sourceRecord, freshByKey, database)
        : { valid: false as const }
      : { valid: false as const };
    if (sourceProof.valid) commonSourceConversionProvenPairs++;
    if (!sourceProof.valid) addBlocker(blockers, "complete-common-source-conversion-unproven");

    if (kind === "legacy-byte-duplicate") {
      addBlocker(blockers, "legacy-recovery-alias-consumption-unverified");
    } else if (kind === "superseded-map") {
      if (candidateKey && mapRegistryReferenceCount(database, candidateKey) > 0) addBlocker(blockers, "superseded-map-still-referenced");
      else addBlocker(blockers, "current-map-reference-and-lease-recheck-missing");
      if (!candidate || !keep || !validateMapPayload(candidate, keep, freshByKey)) addBlocker(blockers, "map-payload-read-or-identity-unverified");
    }
    addBlocker(blockers, "recalculation-proof-missing");
    if (input.snapshot && isRecord(input.snapshot) && isRecord(input.snapshot.report)
      && input.snapshot.report.atomicSnapshot !== true) addBlocker(blockers, "database-r2-snapshot-not-atomic");

    for (const blocker of blockers) blockerTotals[blocker] = (blockerTotals[blocker] ?? 0) + 1;
    if (blockers.size === 0) provenCandidates++;
    rows.push({
      kind,
      ...(candidateKey ? { candidateKey } : {}), ...(keepKey ? { keepKey } : {}),
      ...(Number.isSafeInteger(candidate?.bytes) ? { candidateBytes: candidate!.bytes as number } : {}),
      ...(Number.isSafeInteger(keep?.bytes) ? { keepBytes: keep!.bytes as number } : {}),
      ...(typeof candidate?.etag === "string" ? { candidateEtag: candidate.etag } : {}),
      ...(typeof keep?.etag === "string" ? { keepEtag: keep.etag } : {}),
      ...(candidateHash ? { candidateSha256: candidateHash.sha256 } : {}),
      ...(keepHash ? { keepSha256: keepHash.sha256 } : {}),
      ...(sourceProof.sourceKey ? { sourceKey: sourceProof.sourceKey } : {}),
      ...(sourceProof.sourceSha256 ? { sourceSha256: sourceProof.sourceSha256 } : {}),
      bodyComparison,
      hashEvidence: !candidateHash || !keepHash ? "none"
        : candidateHash.source === "fresh-read" && keepHash.source === "fresh-read" ? "fresh-read"
          : candidateHash.source === "sample-read" && keepHash.source === "sample-read" ? "prior-read" : "mixed",
      planIdentityShapeMatched: identityMatched,
      metadataMatched,
      legacyArrayShapeVerified,
      commonSourceConversionProven: sourceProof.valid,
      ...(sourceProof.sourceKey ? { sourceKey: sourceProof.sourceKey } : {}),
      ...(sourceProof.sourceSha256 ? { sourceSha256: sourceProof.sourceSha256 } : {}),
      personalizedFullProjectionMarker,
      currentReadVerified,
      recalculationVerified: false,
      deletionEligible: false,
      blockers: [...blockers].sort(),
    } as ArchivedCopyPrivateRow);
  }

  const inputs = {
    inventoryComplete: base.validShape && base.inventoryComplete && base.reportComplete,
    databaseMetadataComplete: base.databaseMetadataComplete,
    classificationComplete: classified.complete,
    planComplete: plan.complete,
    sampleEvidenceComplete,
    freshObjectReads: freshByKey.size,
    freshReadBound: MAX_FRESH_OBJECTS as 20,
  };
  return {
    summary: {
      schemaVersion: 1,
      readOnly: true,
      inputs,
      totals: {
        plannedPairs: plan.rows.length,
        metadataMatchedPairs,
        planIdentityShapeMatchedPairs,
        byteComparisonProvenPairs,
        exactByteDuplicatePairs,
        byteDifferentPairs,
        freshByteDuplicatePairs,
        commonSourceConversionProvenPairs,
        identicalLegacyArrayPairs,
        supersededMapPairs,
        projectionFullMarkers,
        provenCandidates,
        deletionEligibleCandidates: 0,
      },
      blockers: blockerTotals,
    },
    privateRows: rows,
  };
}

export function validateFreshReadManifestHeader(value: unknown, now = Date.now()): { observedAt: string; rows: Row[] } {
  if (!isRecord(value) || value.version !== 1 || value.readOnly !== true || value.complete !== true
    || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))
    || !Array.isArray(value.objects) || value.objects.length > MAX_FRESH_OBJECTS) {
    throw new Error("archived-copy-fresh-manifest-invalid");
  }
  const observedAt = Date.parse(value.observedAt);
  if (observedAt > now + 5 * 60_000 || now - observedAt > 24 * 60 * 60_000) {
    throw new Error("archived-copy-fresh-manifest-stale");
  }
  const rows: Row[] = [];
  for (const row of value.objects) {
    if (!isRecord(row) || typeof row.key !== "string" || !row.key || typeof row.etag !== "string"
      || !row.etag || !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0
      || (row.bytes as number) > MAX_FRESH_BODY_BYTES || typeof row.file !== "string" || !row.file
      || (row.contentEncoding !== undefined && typeof row.contentEncoding !== "string")) {
      throw new Error("archived-copy-fresh-manifest-invalid");
    }
    rows.push(row);
  }
  return { observedAt: value.observedAt, rows };
}

export const ARCHIVED_COPY_LIMITS = {
  maxInventoryObjects: MAX_INVENTORY_OBJECTS,
  maxPlanPairs: MAX_PLAN_PAIRS,
  maxFreshObjects: MAX_FRESH_OBJECTS,
  maxFreshBodyBytes: MAX_FRESH_BODY_BYTES,
  maxDecodedBodyBytes: MAX_DECODED_BODY_BYTES,
  maxComparisonMs: MAX_COMPARISON_MS,
} as const;
