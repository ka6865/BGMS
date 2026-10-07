import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from 'node:zlib';
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  deleteExpiredMatchSourceFromR2,
  deleteExpiredPersonalMatchObjectFromR2,
  isR2Configured,
  listR2ObjectsByPrefix,
  readObjectForVerification,
  restoreR2ObjectFromRetentionBackup,
  decodeMaybeGzip,
  type R2ObjectVerificationRead,
} from "../lib/pubg-analysis/r2Service";
import {
  assessMatchRetentionCleanup,
  MATCH_DETAIL_RETENTION_DAYS,
  type MatchRetentionAccountEvidence,
  type MatchRetentionObjectCandidate,
  type RetainedPerformanceRow,
} from "../lib/pubg-analysis/matchRetentionCleanup";
import { getMatchDetailRetention } from "../lib/pubg-analysis/matchRetention";
import dotenv from "dotenv";
import { parseSharedTelemetrySource, buildSharedTelemetrySourceKey } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { buildTelemetryAnalyzeCacheKey, buildTelemetryCacheKey } from "../lib/pubg-analysis/telemetryCacheKey";
import { sealRecoveryBytes, openRecoveryBytes } from "./r2_recovery_archive";
import { preserveExpiredMatchPerformance, planLegacyRetentionBindings } from '../lib/pubg-analysis/retentionPerformanceRecovery';
import { planLegacyTeamRetentionRecovery, preserveLegacyTeamRetentionPackets,
  type LegacyTeamEventArtifact } from '../lib/pubg-analysis/legacyTeamRetentionPreservation';
import { MAX_RETENTION_BATCH_OBJECTS, MAX_RETENTION_BATCH_BYTES, RETENTION_SCAN_LIMIT,
  RETENTION_SCAN_TIME_MS, selectRetentionBatchObjects } from '../lib/pubg-analysis/matchRetentionBatch';
import { planLegacyMapRetentionRecovery, preserveLegacyMapRetentionPacket } from '../lib/pubg-analysis/legacyMapRetentionRecovery';

const ROW_LIMIT = 101;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const FIRST_BATCH_OBJECTS = MAX_RETENTION_BATCH_OBJECTS;
const ACCOUNT_ID = /^account\.[A-Za-z0-9_-]+$/;
const FORMATS = { manifest: 1, backup: 1 } as const;

type Platform = "steam" | "kakao";
type PlatformFilter = Platform | "all";
type Mode = "dry-run" | "prepare-backup" | "apply";
type Args = {
  mode: Mode;
  platform: PlatformFilter;
  accountId?: string;
  scanLimit: number;
  matchId?: string;
  limit: number;
  maxPages: number;
  manifestPath: string;
  backupPath?: string;
  backupUploadVerified: boolean;
  preservePerformance?: boolean;
};
type BasicMatch = {
  account_id: string | null; player_id: string; platform: string; match_id: string; played_at: string;
  game_mode: string; map_name: string; kills: number; damage: number; win_place: number; match_type: string;
};
type RegistryRow = {
  id: number; match_id: string; platform: string; player_id: string; mode: string;
  telemetry_version: number; storage_path: string; status: string; lease_token?: string | null;
  lease_expires_at: string | null; updated_at: string;
};
type ObjectProof = MatchRetentionObjectCandidate & {
  platform: Platform;
  matchId: string;
  playedAt: string | null;
  registryId?: number;
  registryUpdatedAt?: string;
  registrySnapshot?: RegistryRow;
  masterPathReferenced?: boolean;
};
type PlannedMatch = {
  platform: Platform;
  matchId: string;
  playedAt: string | null;
  reasons: string[];
  accountCount: number;
  objectCount: number;
  bytes: number;
};
type Manifest = {
  format: number;
  planId: string;
  createdAt: string;
  projectRef: string;
  platform: PlatformFilter;
  accountId?: string;
  scanLimit: number;
  matchId?: string;
  limit: number;
  maxPages: number;
  matches: PlannedMatch[];
  objects: ObjectProof[];
  legacyListings: Array<{ pages: number; truncated: boolean; objects: number }>;
  cursorGeneration?: number;
  nextCursor?: { played_at: string; platform: Platform; match_id: string } | null;
  preservation?: { linkedAccounts: number; savedSummaries: number; recoveredSummaries: number };
};
type BackupObject = ObjectProof & {
  bodyBase64: string;
  contentType: string | null;
  contentEncoding: string | null;
};
type BackupPayload = { format: number; planSha256: string; projectRef: string; objects: BackupObject[] };
type Inspection = { manifest: Manifest; supabase: SupabaseClient; env: Record<string, string | undefined> };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("unexpected-cli-argument");
    if (token === "--apply" || token === "--prepare-backup" || token === "--backup-upload-verified" || token === '--preserve-performance') {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("cli-value-missing");
    values.set(token, value);
    index += 1;
  }
  if (flags.has("--apply") && flags.has("--prepare-backup")) throw new Error("cli-mode-conflict");
  const mode: Mode = flags.has("--apply") ? "apply" : flags.has("--prepare-backup") ? "prepare-backup" : "dry-run";
  const platform = values.get("--platform");
  const accountId = values.get("--account-id");
  const limit = Number(values.get("--limit") ?? "1");
  const maxPages = Number(values.get("--max-pages") ?? "1");
  const scanLimit = Number(values.get("--scan-limit") ?? "100");
  const matchId = values.get("--match-id");
  const manifestPath = values.get("--manifest") ?? "";
  const backupPath = values.get("--backup-artifact");
  const allowed = new Set(["--platform", "--account-id", "--limit", "--max-pages", "--scan-limit", "--match-id", "--manifest", "--backup-artifact"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new Error("cli-option-unknown");
  if ((platform !== "steam" && platform !== "kakao" && platform !== "all")
    || (accountId !== undefined && !ACCOUNT_ID.test(accountId)) || (platform !== "all" && !accountId)
    || !Number.isInteger(limit) || limit < 1 || limit > FIRST_BATCH_OBJECTS
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20
    || !Number.isInteger(scanLimit) || scanLimit < 100 || scanLimit > RETENTION_SCAN_LIMIT
    || (matchId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(matchId))
    || !manifestPath || (mode !== "dry-run" && !backupPath)
    || (mode === "dry-run" && (backupPath || flags.has('--preserve-performance')))
    || (mode === 'apply' && flags.has('--preserve-performance'))) throw new Error("cli-arguments-invalid");
  return { mode, platform, accountId, scanLimit, matchId, limit, maxPages, manifestPath: resolve(manifestPath), backupPath: backupPath ? resolve(backupPath) : undefined,
    backupUploadVerified: flags.has("--backup-upload-verified"), preservePerformance: flags.has('--preserve-performance') };
}

async function writePrivateNewFile(path: string, body: Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(body); await file.sync(); }
  finally { await file.close(); }
}

function projectRefFromUrl(url: string): string {
  try { return new URL(url).hostname.split(".")[0]; }
  catch { throw new Error("supabase-url-invalid"); }
}

async function rows<T>(db: SupabaseClient, table: string, columns: string, matchId: string, platform: Platform): Promise<T[]> {
  let query = db.from(table).select(columns).eq("match_id", matchId);
  // This legacy shared table is keyed by match_id and has no platform column.
  // Exact platform/account storage paths are still checked before deletion.
  if (table !== "match_master_telemetry") query = query.eq("platform", platform);
  const { data, error } = await query.limit(ROW_LIMIT)
    .abortSignal(AbortSignal.timeout(15_000));
  if (error) throw new Error(`retention-query-failed:${table}:${error.code ?? "unknown"}`);
  if ((data ?? []).length >= ROW_LIMIT) throw new Error(`retention-reference-limit:${table}`);
  return (data ?? []) as T[];
}

function normalized(value: unknown): string { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function isActiveLease(token: unknown, expires: unknown, now: number): boolean {
  return Boolean(token) || (typeof expires === "string" && Number.isFinite(Date.parse(expires)) && Date.parse(expires) > now);
}
function isUnfinished(state: unknown): boolean { return ["pending", "retry", "running"].includes(String(state ?? "").toLowerCase()); }

function mapRegistryAccount(row: RegistryRow, basics: BasicMatch[]): string | null {
  if (ACCOUNT_ID.test(row.player_id)) return basics.some((basic) => basic.account_id === row.player_id) ? row.player_id : null;
  const candidates = basics.filter((basic) => normalized(basic.player_id) === normalized(row.player_id));
  return candidates.length === 1 && candidates[0].account_id ? candidates[0].account_id : null;
}

async function readExactObject(key: string): Promise<R2ObjectVerificationRead | null> {
  return readObjectForVerification(key, { maxBytes: MAX_OBJECT_BYTES });
}

async function readLegacyTeamArtifacts(match: BasicMatch, processed: Array<Record<string, any>>,
  budget: { decodedLegacyBytes: number }): Promise<LegacyTeamEventArtifact[]> {
  const legacy = await listR2ObjectsByPrefix(`${match.match_id}_`, { maxPages: 1, maxObjects: 100 });
  if (legacy.truncated) return [];
  const candidates = legacy.objects.filter(object => {
    const identity = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([a-z0-9._-]+)_v[1-9][0-9]*_analyze\.json$/i.exec(object.key);
    return identity?.[1] === match.match_id && processed.some(p => p.match_id === match.match_id
      && p.platform === match.platform && normalized(p.player_id) === normalized(identity[2]) && p.data?.fullResult);
  });
  if (!candidates.length || candidates.length > 3) return [];
  const artifacts: LegacyTeamEventArtifact[] = [];
  for (const candidate of candidates) {
    const available = 32 * 1024 * 1024 - budget.decodedLegacyBytes;
    if (available <= 0 || candidate.sizeBytes > 8 * 1024 * 1024) return [];
    const object = await readObjectForVerification(candidate.key, { maxBytes: 8 * 1024 * 1024 });
    if (!object || object.etag !== candidate.etag || object.sizeBytes !== candidate.sizeBytes) return [];
    try {
      const bytes = object.body[0] === 0x1f && object.body[1] === 0x8b
        ? gunzipSync(object.body, { maxOutputLength: available }) : object.body;
      if (bytes.length > available) return [];
      budget.decodedLegacyBytes += bytes.length;
      const events = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(events)) return [];
      artifacts.push({ key: candidate.key, sha256: sha256(object.body), events });
    } catch { return []; }
  }
  return artifacts;
}

async function inspectOneMatch(input: {
  db: SupabaseClient; match: BasicMatch; args: Args; now: number; projectRef: string;
  legacyListings: Manifest["legacyListings"];
  recoveryBudget?: { calculations: number; linkedAccounts: number; savedSummaries: number; recoveredSummaries: number; decodedLegacyBytes: number };
}): Promise<{ plan: PlannedMatch; objects: ObjectProof[]; eligibleObjectCount?: number }> {
  const { db, match, args, now } = input;
  const platform = match.platform as Platform;
  const [basics, processed, performances, registry, masters, discoveries, jobs, benchmarks] = await Promise.all([
    rows<BasicMatch>(db, "pubg_player_matches", args.preservePerformance ? "*" : "account_id,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,knocks,survival_time", match.match_id, platform),
    rows<Record<string, any>>(db, "processed_match_telemetry", args.preservePerformance ? "*" : "match_id,platform,player_id,data", match.match_id, platform),
    rows<RetainedPerformanceRow & Record<string, any>>(db, "pubg_match_performance", "platform,account_id,match_id,player_id,played_at,calculation_version,result_version,score,tier,benchmark,ranking_eligible,source_checksum,summary_version,summary", match.match_id, platform),
    rows<RegistryRow>(db, "telemetry_map_cache_entries", args.preservePerformance ? "*" : "id,match_id,platform,player_id,mode,telemetry_version,storage_path,status,lease_token,lease_expires_at,updated_at", match.match_id, platform),
    rows<{ storage_path: string | null }>(db, "match_master_telemetry", "storage_path", match.match_id, platform),
    rows<Record<string, any>>(db, "pubg_player_match_discovery", "account_id,state,lease_token,lease_expires_at", match.match_id, platform),
    rows<Record<string, any>>(db, "pubg_performance_jobs", "account_id,state,lease_token,lease_expires_at", match.match_id, platform),
    rows<{ player_id: string }>(db, "global_benchmarks", "player_id", match.match_id, platform),
  ]);
  const refs = new Set<string>();
  let unresolvedRef = basics.some((row) => !row.account_id || !ACCOUNT_ID.test(row.account_id));
  basics.forEach((row) => row.account_id && refs.add(row.account_id));
  for (const row of [...performances, ...discoveries, ...jobs]) {
    if (typeof row.account_id === "string" && ACCOUNT_ID.test(row.account_id)) refs.add(row.account_id);
    else unresolvedRef = true;
  }
  for (const row of [...processed, ...benchmarks]) {
    const player = typeof row.player_id === "string" ? normalized(row.player_id) : "";
    const matches = basics.filter((basic) => normalized(basic.player_id) === player && basic.account_id);
    if (matches.length === 1) refs.add(matches[0].account_id!);
    else unresolvedRef = true;
  }
  for (const row of registry) {
    const accountId = mapRegistryAccount(row, basics);
    if (accountId) refs.add(accountId);
    else unresolvedRef = true;
  }
  if (unresolvedRef) refs.add("unresolved-reference");

  const activeMapLease = registry.some((row) => row.status !== "ready" || isActiveLease(row.lease_token, row.lease_expires_at, now));
  const pendingDiscovery = discoveries.some((row) => isUnfinished(row.state) || isActiveLease(row.lease_token, row.lease_expires_at, now));
  const pendingJob = jobs.some((row) => isUnfinished(row.state) || isActiveLease(row.lease_token, row.lease_expires_at, now));
  if (args.preservePerformance && !activeMapLease && !pendingDiscovery && !pendingJob) {
    let source = null;
    // 기존 DB 결과를 우선하며 계정 연결이나 누락 성과 복구에 필요한 공통 원본만 읽는다.
    const legacyBindings = planLegacyRetentionBindings(basics, processed as any[]);
    const needsSource = basics.some(b => (!b.account_id && !legacyBindings.some(proof => proof.before.player_id === b.player_id)) || (!processed.some(p => normalized(p.player_id) === normalized(b.player_id)
      && p.data?.fullResult) && !performances.some(p => p.account_id === b.account_id && p.summary != null)));
    if (needsSource) {
      let key: string | null = null;
      try { key = buildSharedTelemetrySourceKey(match.match_id, platform); } catch { /* Noncanonical match remains protected. */ }
      if (key) {
        const object = await readExactObject(key);
        if (object) {
          try {
            const text = decodeMaybeGzip(object.body);
            if (Buffer.byteLength(text) <= 64 * 1024 * 1024)
              source = parseSharedTelemetrySource(JSON.parse(text), match.match_id, platform);
          } catch { /* Invalid source is protected, never used for recovery. */ }
        }
      }
    }
    const preserved = await preserveExpiredMatchPerformance(db, { matchId: match.match_id, platform, basics,
      processed: processed as any[], performances, source, now,
      maxCalculations: Math.max(0, 5 - (input.recoveryBudget?.calculations ?? 0)) });
    if (input.recoveryBudget) {
      input.recoveryBudget.calculations += preserved.recoveredSummaries;
      input.recoveryBudget.recoveredSummaries += preserved.recoveredSummaries;
      input.recoveryBudget.linkedAccounts += preserved.linkedAccounts;
      input.recoveryBudget.savedSummaries += preserved.savedSummaries;
    }
    if (preserved.linkedAccounts || preserved.savedSummaries) {
      // 저장 후 DB를 다시 읽어 전체 참조와 원본 checksum을 검증한다.
      return inspectOneMatch({ ...input, args: { ...args, preservePerformance: false } });
    }
    if (!source && needsSource && input.recoveryBudget && input.recoveryBudget.calculations < 5) {
      const artifacts = await readLegacyTeamArtifacts(match, processed, input.recoveryBudget);
      const planned = planLegacyTeamRetentionRecovery({ basics, processed: processed as any[], performances, artifacts,
        now, maxCalculations: 5 - input.recoveryBudget.calculations });
      input.recoveryBudget.calculations += planned.calculations;
      const saved = await preserveLegacyTeamRetentionPackets(db, planned.packets);
      input.recoveryBudget.linkedAccounts += saved;
      input.recoveryBudget.savedSummaries += saved;
      input.recoveryBudget.recoveredSummaries += saved;
      if (saved) return inspectOneMatch({ ...input,
        match: { ...match, played_at: planned.packets[0].expectedBasic.played_at },
        args: { ...args, preservePerformance: false } });
    }
    // Full replay maps contain measured combat events even without official
    // metadata or a personal analysis. Preserve those observations separately.
    if (!source && needsSource && input.recoveryBudget && input.recoveryBudget.calculations < 5) {
      for (const basic of basics) {
        if (input.recoveryBudget.calculations >= 5) break;
        if (basic.account_id !== null || processed.some(p => normalized(p.player_id) === normalized(basic.player_id))
          || performances.some(p => normalized(p.player_id) === normalized(basic.player_id))) continue;
        const candidates = registry.filter(r => r.mode === 'full' && r.status === 'ready' && ACCOUNT_ID.test(r.player_id));
        if (candidates.length !== 1) continue;
        const r = candidates[0];
        let key;
        try { key = buildTelemetryCacheKey({ matchId: match.match_id, platform, playerId: r.player_id,
          mode: 'full', telemetryVersion: r.telemetry_version }); } catch { continue; }
        if (key !== r.storage_path) continue;
        const object = await readObjectForVerification(key, { maxBytes: 8 * 1024 * 1024 });
        if (!object) continue;
        const available = 32 * 1024 * 1024 - input.recoveryBudget.decodedLegacyBytes;
        let payload;
        try {
          if (available <= 0) continue;
          const bytes = object.body[0] === 0x1f && object.body[1] === 0x8b
            ? gunzipSync(object.body, { maxOutputLength: available }) : object.body;
          if (bytes.length > available) continue;
          input.recoveryBudget.decodedLegacyBytes += bytes.length;
          payload = JSON.parse(bytes.toString('utf8'));
        } catch { continue; }
        input.recoveryBudget.calculations++;
        const packet = planLegacyMapRetentionRecovery({ before: basic, registry: r, payload, key,
          sha256: sha256(object.body), etag: object.etag, sizeBytes: object.sizeBytes, now });
        if (!packet) continue;
        await preserveLegacyMapRetentionPacket(db, packet);
        input.recoveryBudget.linkedAccounts++;
        input.recoveryBudget.savedSummaries++;
        input.recoveryBudget.recoveredSummaries++;
        return inspectOneMatch({ ...input, args: { ...args, preservePerformance: false } });
      }
    }
  }
  const evidence: MatchRetentionAccountEvidence[] = [...refs].filter((id) => ACCOUNT_ID.test(id)).map((accountId) => {
    const accountBasics = basics.filter((row) => row.account_id === accountId);
    const basicMatch = accountBasics.length === 1 ? accountBasics[0] : null;
    const nickname = normalized(basicMatch?.player_id);
    return {
      accountId,
      basicMatch,
      processedRows: processed.filter((row) => normalized(row.player_id) === nickname),
      retainedPerformanceRows: performances.filter((row) => row.account_id === accountId),
    };
  });
  const noActiveWork = !activeMapLease && !pendingDiscovery && !pendingJob;
  const masterPaths = masters.map((row) => row.storage_path).filter((value): value is string => typeof value === "string");
  const baseAssessment = assessMatchRetentionCleanup({
    matchId: match.match_id, platform, playedAt: match.played_at, now,
    accounts: evidence, referencedAccountIds: [...refs], activeMapLease,
    pendingOrActiveDiscovery: pendingDiscovery, pendingOrActivePerformanceJob: pendingJob,
    masterStoragePaths: masterPaths, objects: [],
  });
  const hardReasons = baseAssessment.reasons.filter((reason) => reason !== "no_verified_objects");
  if (hardReasons.length > 0 || !noActiveWork) {
    return { plan: { platform, matchId: match.match_id, playedAt: match.played_at, reasons: hardReasons.length ? hardReasons : ["active_work"],
      accountCount: baseAssessment.retainedAccountCount, objectCount: 0, bytes: 0 }, objects: [] };
  }

  const keys: Array<ObjectProof & { registry?: RegistryRow }> = [];
  try {
    const sharedKey = buildSharedTelemetrySourceKey(match.match_id, platform);
    keys.push({ kind: "shared-source", key: sharedKey, etag: "pending", sizeBytes: 1, sha256: "0".repeat(64), platform,
      matchId: match.match_id, playedAt: match.played_at });
  } catch { /* Noncanonical IDs have no shared-source key. */ }
  for (const row of registry) {
    const accountId = mapRegistryAccount(row, basics);
    const version = Number(row.telemetry_version);
    if (!accountId || !Number.isInteger(version) || version < 1 || !["lite", "full"].includes(row.mode)) continue;
    const identity = { matchId: match.match_id, platform, playerId: accountId, mode: row.mode as "lite" | "full", telemetryVersion: version };
    let canonicalMap: string;
    let analysisKey: string;
    try { canonicalMap = buildTelemetryCacheKey(identity); analysisKey = buildTelemetryAnalyzeCacheKey(identity); }
    catch { continue; }
    if (row.storage_path !== canonicalMap || row.status !== "ready") continue;
    keys.push({ kind: "personal-map", key: canonicalMap, etag: "pending", sizeBytes: 1, sha256: "0".repeat(64), platform,
      matchId: match.match_id, playedAt: match.played_at,
      accountId, playerId: normalized(basics.find((basic) => basic.account_id === accountId)?.player_id), mode: identity.mode,
      telemetryVersion: version, registryId: row.id, registryUpdatedAt: row.updated_at, registry: row });
    keys.push({ kind: "personal-analysis", key: analysisKey, etag: "pending", sizeBytes: 1, sha256: "0".repeat(64), platform,
      matchId: match.match_id, playedAt: match.played_at,
      accountId, playerId: normalized(basics.find((basic) => basic.account_id === accountId)?.player_id), mode: identity.mode, telemetryVersion: version });
  }
  const legacy = await listR2ObjectsByPrefix(`${match.match_id}_`, { maxPages: args.maxPages, maxObjects: 100 });
  input.legacyListings.push({ pages: legacy.pages, truncated: legacy.truncated, objects: legacy.objects.length });
  for (const listed of legacy.objects) {
    for (const basic of basics) {
      if (!basic.account_id) continue;
      const version = Number(listed.key.match(new RegExp(`^${match.match_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_${normalized(basic.player_id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)_analyze\\.json$`))?.[1]);
      if (Number.isInteger(version) && version > 0) {
        keys.push({ kind: "legacy-analysis", key: listed.key, etag: "pending", sizeBytes: listed.sizeBytes, sha256: "0".repeat(64), platform,
          matchId: match.match_id, playedAt: match.played_at,
          accountId: basic.account_id, playerId: normalized(basic.player_id), telemetryVersion: version });
        break;
      }
    }
  }

  // Analysis needs its registry identity until it is removed; delete the map last.
  const priority = { "shared-source": 0, "personal-analysis": 1, "legacy-analysis": 2, "personal-map": 3 };
  const uniqueKeys = [...new Map(keys.map((item) => [item.key, item])).values()]
    .sort((a, b) => priority[a.kind] - priority[b.kind]);
  const objectProofs: ObjectProof[] = [];
  let sourceEvidence: NonNullable<Parameters<typeof assessMatchRetentionCleanup>[0]["source"]> | undefined;
  for (const candidate of uniqueKeys) {
    const object = await readExactObject(candidate.key);
    if (!object) continue;
    const proof: ObjectProof = { ...candidate, etag: object.etag, sizeBytes: object.sizeBytes,
      sha256: sha256(object.body), masterPathReferenced: masterPaths.includes(candidate.key) && candidate.kind === "personal-map" };
    if (candidate.registry) proof.registrySnapshot = candidate.registry;
    delete (proof as any).registry;
    if (candidate.kind === "shared-source") {
      try {
        const parsed = parseSharedTelemetrySource(JSON.parse(decodeMaybeGzip(object.body)), match.match_id, platform);
        if (!parsed) continue;
        const included = parsed.matchData.included.filter((item: any) => item?.type === "participant");
        const participants = included.map((item: any) => ({
          accountId: item.attributes?.stats?.playerId || item.attributes?.accountId,
          playerId: item.attributes?.stats?.name,
          kills: item.attributes?.stats?.kills,
          damageDealt: item.attributes?.stats?.damageDealt,
          winPlace: item.attributes?.stats?.winPlace,
        })).filter((item: any) => typeof item.accountId === "string");
        sourceEvidence = { valid: true, playedAt: parsed.matchData.data.attributes.createdAt,
          participantAccountIds: participants.map((item: any) => item.accountId), participants };
      } catch { continue; }
    }
    objectProofs.push(proof);
  }
  const assessment = assessMatchRetentionCleanup({
    matchId: match.match_id, platform, playedAt: match.played_at, now,
    accounts: evidence, referencedAccountIds: [...refs], source: sourceEvidence,
    activeMapLease, pendingOrActiveDiscovery: pendingDiscovery, pendingOrActivePerformanceJob: pendingJob,
    masterStoragePaths: masterPaths, objects: objectProofs,
  });
  const selected = assessment.objects.slice(0, args.limit) as ObjectProof[];
  // 삭제 가능한 legacy가 목록 앞에 남아 있을 때만 같은 경기를 이어서 검사한다.
  // 보호 대상만 반복해서 보이는 잘린 목록은 기록하고 다음 경기로 이동한다.
  const moreLegacyMayRemain = legacy.truncated && assessment.objects.some(object => object.kind === 'legacy-analysis');
  return { plan: { platform, matchId: match.match_id, playedAt: match.played_at,
    reasons: [...assessment.reasons, ...(legacy.truncated ? ['legacy_listing_truncated'] : [])],
    accountCount: assessment.retainedAccountCount, objectCount: selected.length,
      bytes: selected.reduce((sum, object) => sum + object.sizeBytes, 0) }, objects: selected,
    eligibleObjectCount: assessment.objects.length + (moreLegacyMayRemain ? 1 : 0) };
}

async function inspect(options: Args, env: Record<string, string | undefined> = process.env,
  storedManifest?: Manifest): Promise<Inspection> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) throw new Error("retention-supabase-credentials-missing");
  if (!isR2Configured()) throw new Error("retention-r2-credentials-missing");
  const projectRef = projectRefFromUrl(url);
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  if (storedManifest) {
    if (storedManifest.format !== FORMATS.manifest || storedManifest.projectRef !== projectRef
      || storedManifest.platform !== options.platform || storedManifest.accountId !== options.accountId
      || storedManifest.matchId !== options.matchId || storedManifest.limit !== options.limit
      || storedManifest.scanLimit !== options.scanLimit || storedManifest.maxPages !== options.maxPages
      || !Array.isArray(storedManifest.objects) || storedManifest.objects.length > FIRST_BATCH_OBJECTS
      || !Number.isFinite(Date.parse(storedManifest.createdAt))
      || Date.now() - Date.parse(storedManifest.createdAt) > 3_600_000) {
      throw new Error("retention-manifest-scope-invalid");
    }
    return { manifest: storedManifest, supabase: db, env };
  }
  const now = Date.now();
  const cutoff = new Date(now - MATCH_DETAIL_RETENTION_DAYS * 86_400_000).toISOString();
  const globalScan = options.platform === "all" && !options.accountId && !options.matchId;
  let cursor: { played_at: string | null; platform: Platform | null; match_id: string | null; generation: number } | null = null;
  if (globalScan) {
    const { data, error: cursorError } = await db.from("pubg_archive_cleanup_cursor").select("played_at,platform,match_id,generation")
      .eq("id", 1).abortSignal(AbortSignal.timeout(15_000)).single();
    if (cursorError || !data) throw new Error("retention-cursor-read-failed");
    cursor = data;
  }
  let candidateQuery = globalScan ? db.rpc('list_retention_archive_candidates', {
    p_limit: options.scanLimit, p_cutoff: cutoff, p_after_played_at: cursor?.played_at ?? null,
    p_after_platform: cursor?.platform ?? null, p_after_match_id: cursor?.match_id ?? null,
  }).select("account_id,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type") : db.from("pubg_player_matches")
    .select("account_id,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type")
    .lt("played_at", cutoff).order("played_at", { ascending: true })
    .order("platform", { ascending: true }).order("match_id", { ascending: true });
  if (cursor?.played_at && cursor.platform && cursor.match_id) {
    if (!Number.isFinite(Date.parse(cursor.played_at)) || !["steam", "kakao"].includes(cursor.platform)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.match_id)) throw new Error("retention-cursor-invalid");
    if (!globalScan) candidateQuery = candidateQuery.or(`played_at.gt.${cursor.played_at},and(played_at.eq.${cursor.played_at},platform.gt.${cursor.platform}),and(played_at.eq.${cursor.played_at},platform.eq.${cursor.platform},match_id.gt.${cursor.match_id})`);
  }
  if (options.accountId) candidateQuery = candidateQuery.eq("account_id", options.accountId);
  if (options.platform !== "all") candidateQuery = candidateQuery.eq("platform", options.platform);
  else candidateQuery = candidateQuery.in("platform", ["steam", "kakao"]);
  if (options.matchId) candidateQuery = candidateQuery.eq("match_id", options.matchId);
  const { data: candidateRows, error } = await candidateQuery.limit(options.scanLimit).abortSignal(AbortSignal.timeout(15_000));
  if (error) throw new Error(`retention-candidate-query-failed:${error.code ?? "unknown"}`);
  const legacyListings: Manifest["legacyListings"] = [];
  const matches: PlannedMatch[] = [];
  const objects: ObjectProof[] = [];
  const visited = new Set<string>();
  let nextCursor: Manifest["nextCursor"] = null;
  const started = Date.now();
  const recoveryBudget = { calculations: 0, linkedAccounts: 0, savedSummaries: 0, recoveredSummaries: 0, decodedLegacyBytes: 0 };
  for (const match of (candidateRows ?? []) as BasicMatch[]) {
    const key = `${match.platform}:${match.match_id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (getMatchDetailRetention(match.played_at, now).status !== "expired") continue;
    const remaining = options.limit - objects.length;
    const result = await inspectOneMatch({ db, match, args: { ...options, limit: remaining }, now, projectRef, legacyListings, recoveryBudget });
    const remainingBytes = MAX_RETENTION_BATCH_BYTES - objects.reduce((sum, o) => sum + o.sizeBytes, 0);
    let selected = remainingBytes > 0 ? selectRetentionBatchObjects(result.objects, { maxObjects: remaining, maxBytes: remainingBytes }) : [];
    // 분석 객체의 식별자는 map registry에 의존하므로 분석이 남아 있으면 map을 먼저 지우지 않는다.
    selected = selected.filter(object => object.kind !== 'personal-map' || !result.objects.some(analysis =>
      analysis.kind === 'personal-analysis' && analysis.accountId === object.accountId
      && analysis.mode === object.mode && analysis.telemetryVersion === object.telemetryVersion
      && !selected.includes(analysis)));
    matches.push({ ...result.plan, platform: match.platform as Platform, objectCount: selected.length,
      bytes: selected.reduce((sum, o) => sum + o.sizeBytes, 0) });
    objects.push(...selected);
    const partialMatch = selected.length < (result.eligibleObjectCount ?? result.objects.length);
    // 한 경기 도중 상한에 도달하면 다음 실행도 같은 경기의 남은 자료를 처리한다.
    if (!partialMatch) nextCursor = { played_at: match.played_at, platform: match.platform as Platform, match_id: match.match_id };
    else if (!nextCursor && cursor?.played_at && cursor.platform && cursor.match_id)
      nextCursor = { played_at: cursor.played_at, platform: cursor.platform, match_id: cursor.match_id };
    if (partialMatch || objects.length >= options.limit || Date.now() - started > RETENTION_SCAN_TIME_MS) break;
  }
  const manifest: Manifest = { format: FORMATS.manifest, planId: randomUUID(),
    createdAt: new Date(now).toISOString(), projectRef,
    platform: options.platform, accountId: options.accountId, scanLimit: options.scanLimit, matchId: options.matchId,
    limit: options.limit, maxPages: options.maxPages,
    matches, objects: objects.slice(0, options.limit), legacyListings,
    preservation: { linkedAccounts: recoveryBudget.linkedAccounts, savedSummaries: recoveryBudget.savedSummaries,
      recoveredSummaries: recoveryBudget.recoveredSummaries },
    ...(globalScan ? { cursorGeneration: cursor!.generation, nextCursor } : {}) };
  return { manifest, supabase: db, env };
}

function manifestDigest(manifest: Manifest): string { return sha256(stableJson(manifest)); }

async function saveManifest(manifest: Manifest, path: string): Promise<void> {
  await writePrivateNewFile(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
}

async function prepareBackup(manifest: Manifest, path: string, secret: string): Promise<void> {
  if (!secret.trim()) throw new Error("retention-backup-key-missing");
  const objects: BackupObject[] = [];
  let bytes = 0;
  for (const proof of manifest.objects) {
    const latest = await readExactObject(proof.key);
    if (!latest || latest.etag !== proof.etag || latest.sizeBytes !== proof.sizeBytes || sha256(latest.body) !== proof.sha256) {
      throw new Error("retention-backup-object-changed");
    }
    bytes += latest.sizeBytes;
    if (bytes > MAX_OBJECT_BYTES) throw new Error("retention-backup-size-limit");
    objects.push({ ...proof, bodyBase64: latest.body.toString("base64"), contentType: latest.contentType, contentEncoding: latest.contentEncoding });
  }
  const payload: BackupPayload = { format: FORMATS.backup, planSha256: manifestDigest(manifest), projectRef: manifest.projectRef, objects };
  await writePrivateNewFile(path, sealRecoveryBytes(Buffer.from(JSON.stringify(payload), "utf8"), secret));
}

function verifyBackupAgainstManifest(payload: BackupPayload, manifest: Manifest): boolean {
  if (payload.format !== FORMATS.backup || payload.planSha256 !== manifestDigest(manifest)
    || payload.projectRef !== manifest.projectRef || payload.objects.length !== manifest.objects.length) return false;
  return manifest.objects.every((proof, index) => {
    const backup = payload.objects[index];
    if (backup.key !== proof.key || backup.etag !== proof.etag || backup.sizeBytes !== proof.sizeBytes || backup.sha256 !== proof.sha256) return false;
    const body = Buffer.from(backup.bodyBase64, "base64");
    return body.length === proof.sizeBytes && sha256(body) === proof.sha256;
  });
}

async function decryptBackup(path: string, secret: string): Promise<BackupPayload> {
  if (!secret.trim()) throw new Error("retention-backup-key-missing");
  try { return JSON.parse(openRecoveryBytes(await readFile(path), secret).toString("utf8")) as BackupPayload; }
  catch { throw new Error("retention-backup-invalid"); }
}

async function recheckMatchEligibility(db: SupabaseClient, proof: ObjectProof, manifest: Manifest, now: number): Promise<void> {
  if (!['steam', 'kakao'].includes(proof.platform) || !proof.playedAt
    || getMatchDetailRetention(proof.playedAt, now).status !== 'expired'
    || (manifest.platform !== 'all' && proof.platform !== manifest.platform)
    || (manifest.matchId && proof.matchId !== manifest.matchId)) throw new Error('retention-date-scope-recheck-failed');
  const basics = await rows<BasicMatch>(db, 'pubg_player_matches',
    'account_id,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type', proof.matchId, proof.platform);
  const basic = basics.find(row => !manifest.accountId || row.account_id === manifest.accountId);
  if (!basic || Date.parse(basic.played_at) !== Date.parse(proof.playedAt)) throw new Error('retention-basic-recheck-failed');
  // Reuse the complete initial assessment: every reference, checksum, measured
  // basic value, active job, lease and shared-source participant is checked again.
  const fresh = await inspectOneMatch({ db, match: basic, now, projectRef: manifest.projectRef, legacyListings: [],
    args: { mode: 'dry-run', platform: proof.platform, accountId: basic.account_id ?? undefined,
      scanLimit: 100, matchId: proof.matchId, limit: FIRST_BATCH_OBJECTS, maxPages: manifest.maxPages, manifestPath: '', backupUploadVerified: false } });
  const current = fresh.objects.find(object => object.key === proof.key);
  if (!current || stableJson(current) !== stableJson(proof)) throw new Error('retention-final-evidence-changed');
}

async function rollbackObject(backup: BackupObject): Promise<void> {
  await restoreR2ObjectFromRetentionBackup({ key: backup.key, body: Buffer.from(backup.bodyBase64, "base64"), sha256: backup.sha256,
    contentType: backup.contentType, contentEncoding: backup.contentEncoding });
}

async function applyPlan(inspection: Inspection, backup: BackupPayload): Promise<{ deleted: number; bytes: number }> {
  const { manifest, supabase, env } = inspection;
  const currentProject = projectRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (currentProject !== manifest.projectRef) throw new Error("retention-project-changed");
  if (manifest.objects.length > FIRST_BATCH_OBJECTS || manifest.objects.reduce((sum, object) => sum + object.sizeBytes, 0) > MAX_OBJECT_BYTES) {
    throw new Error("retention-first-batch-bound-exceeded");
  }
  if (!verifyBackupAgainstManifest(backup, manifest)) throw new Error("retention-backup-plan-mismatch");
  const byKey = new Map(backup.objects.map((item) => [item.key, item]));
  let deleted = 0;
  let bytes = 0;
  for (const proof of manifest.objects) {
    const backupObject = byKey.get(proof.key);
    if (!backupObject) throw new Error("retention-backup-object-missing");
    await recheckMatchEligibility(supabase, proof, manifest, Date.now());
    const latest = await readExactObject(proof.key);
    if (!latest || latest.etag !== proof.etag || latest.sizeBytes !== proof.sizeBytes || sha256(latest.body) !== proof.sha256) {
      throw new Error("retention-object-final-recheck-failed");
    }
    let registryDeleted = false;
    let masterPointerCleared = false;
    try {
      if (proof.kind === "shared-source") {
        const { data: basicRows, error } = await supabase.from("pubg_player_matches").select("account_id")
          .eq("match_id", proof.matchId).eq("platform", proof.platform).limit(ROW_LIMIT);
        if (error || (basicRows ?? []).length >= ROW_LIMIT) throw new Error("retention-source-reference-recheck-failed");
        const refs = [...new Set((basicRows ?? []).map((row: any) => row.account_id).filter((id: unknown): id is string => typeof id === "string" && ACCOUNT_ID.test(id)))];
        await deleteExpiredMatchSourceFromR2({ matchId: proof.matchId, platform: proof.platform, playedAt: proof.playedAt!,
          referencedAccountIds: refs, preservedAccountIds: refs, noActiveWork: true, expectedEtag: proof.etag,
          expectedSizeBytes: proof.sizeBytes, expectedSha256: proof.sha256 });
      } else {
        await deleteExpiredPersonalMatchObjectFromR2({ kind: proof.kind as "personal-map" | "personal-analysis" | "legacy-analysis",
          key: proof.key, matchId: proof.matchId, platform: proof.platform, accountId: proof.accountId!, playerId: proof.playerId!,
          mode: proof.mode, telemetryVersion: proof.telemetryVersion!, playedAt: proof.playedAt!, compactSnapshotPreserved: true,
          noActiveWork: true, expectedEtag: proof.etag, expectedSizeBytes: proof.sizeBytes, expectedSha256: proof.sha256 });
      }
      if (proof.masterPathReferenced) {
        const { data, error } = await supabase.from('match_master_telemetry').update({ storage_path: null })
          .eq('match_id', proof.matchId).eq('storage_path', proof.key).select('match_id');
        if (error || !Array.isArray(data) || data.length !== 1) throw new Error('retention-master-pointer-clear-failed');
        masterPointerCleared = true;
      }
      if (proof.kind === 'personal-map' && proof.registryId !== undefined) {
        const { data, error } = await supabase.from('telemetry_map_cache_entries').delete().eq('id', proof.registryId)
          .eq('storage_path', proof.key).eq('status', 'ready').eq('updated_at', proof.registryUpdatedAt)
          .is('lease_token', null).select('id');
        if (error || !Array.isArray(data) || data.length !== 1) throw new Error('retention-registry-cleanup-failed');
        registryDeleted = true;
      }
    } catch (error) {
      try {
        await rollbackObject(backupObject);
        if (masterPointerCleared || proof.masterPathReferenced) {
          // A failed transport can hide a committed pointer update. Restore only
          // a now-null pointer; never replace another worker's new object.
          const { data, error: restoreError } = await supabase.from('match_master_telemetry').update({ storage_path: proof.key })
            .eq('match_id', proof.matchId).is('storage_path', null).select('match_id');
          if (restoreError) throw new Error('retention-master-restore-unverified');
          if (data?.length !== 1) {
            const current = await rows<{ storage_path: string | null }>(supabase, 'match_master_telemetry', 'storage_path', proof.matchId, proof.platform);
            if (current.length !== 1 || current[0].storage_path !== proof.key) throw new Error('retention-master-restore-unverified');
          }
        }
        if (proof.registrySnapshot) {
          const { data: existing, error: readError } = await supabase.from('telemetry_map_cache_entries').select('*')
            .eq('id', proof.registryId).maybeSingle();
          if (readError) throw new Error('retention-registry-restore-read-failed');
          if (!existing) {
            // Never replace a concurrently inserted identity or lease.
            const { error: restoreError } = await supabase.from('telemetry_map_cache_entries').insert(proof.registrySnapshot);
            if (restoreError) throw new Error('retention-registry-restore-conflict');
          } else if (existing.storage_path !== proof.key || existing.status !== 'ready'
            || existing.lease_token || existing.updated_at !== proof.registryUpdatedAt) {
            throw new Error('retention-registry-restore-conflict');
          }
        } else if (registryDeleted) throw new Error('retention-registry-backup-missing');
      } catch { throw new Error("retention-delete-failed-restore-unverified"); }
      throw error;
    }
    deleted += 1;
    bytes += proof.sizeBytes;
  }
  return { deleted, bytes };
}

export async function runExpiredMatchArchiveCleanup(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  dotenv.config({ path: env.BGMS_ENV_FILE || '.env.local', quiet: true });
  const options = parseArgs(argv);
  if (options.limit > FIRST_BATCH_OBJECTS) throw new Error('retention-first-batch-bound-exceeded');
  const storedManifest = options.mode === 'apply'
    ? JSON.parse(await readFile(options.manifestPath, 'utf8')) as Manifest : undefined;
  const inspection = await inspect(options, env, storedManifest);
  const { manifest } = inspection;
  const reasonCounts: Record<string, number> = {};
  for (const match of manifest.matches) {
    for (const reason of match.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  if (options.mode === 'dry-run') {
    await saveManifest(manifest, options.manifestPath);
    console.info(JSON.stringify({ mode: options.mode, matches: manifest.matches.length, eligibleObjects: manifest.objects.length,
      candidateBytes: manifest.objects.reduce((sum, object) => sum + object.sizeBytes, 0), legacyLists: manifest.legacyListings.length,
      truncatedLegacyLists: manifest.legacyListings.filter(entry => entry.truncated).length, preservation: manifest.preservation, reasonCounts }));
    return;
  }
  if (options.mode === 'prepare-backup') {
    await saveManifest(manifest, options.manifestPath);
    await prepareBackup(manifest, options.backupPath!, env.R2_RECOVERY_ARCHIVE_KEY ?? '');
    console.info(JSON.stringify({ mode: options.mode, matches: manifest.matches.length, eligibleObjects: manifest.objects.length,
      candidateBytes: manifest.objects.reduce((sum, object) => sum + object.sizeBytes, 0), backupArtifact: basename(options.backupPath!),
      backupBytes: (await stat(options.backupPath!)).size, preservation: manifest.preservation, reasonCounts }));
    return;
  }
  if (!options.backupUploadVerified && env.R2_RETENTION_BACKUP_UPLOAD_VERIFIED !== 'true') {
    throw new Error('retention-backup-upload-not-verified');
  }
  const backup = await decryptBackup(options.backupPath!, env.R2_RECOVERY_ARCHIVE_KEY ?? '');
  const result = await applyPlan(inspection, backup);
  if (manifest.cursorGeneration !== undefined) {
    const { data, error } = await inspection.supabase.from('pubg_archive_cleanup_cursor')
      .update({ played_at: manifest.nextCursor?.played_at ?? null, platform: manifest.nextCursor?.platform ?? null,
        match_id: manifest.nextCursor?.match_id ?? null, generation: manifest.cursorGeneration + 1, updated_at: new Date().toISOString() })
      .eq('id', 1).eq('generation', manifest.cursorGeneration).select('id').abortSignal(AbortSignal.timeout(15_000));
    if (error || data?.length !== 1) throw new Error('retention-cursor-update-failed');
  }
  const backupBytes = (await stat(options.backupPath!)).size;
  console.info(JSON.stringify({ mode: options.mode, deletedObjects: result.deleted, removedBytes: result.bytes,
    backupBytes, netBytesIncludingTemporaryBackup: result.bytes - backupBytes,
    scannedMatches: manifest.matches.length, preservation: manifest.preservation, reasonCounts }));
}

const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  runExpiredMatchArchiveCleanup().catch((error: unknown) => {
    const message = error instanceof Error ? error.message.split("\n", 1)[0] : "unknown";
    console.error(`Expired match archive cleanup stopped: ${message}`);
    process.exitCode = 1;
  });
}
