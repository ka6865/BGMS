import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildSharedTelemetrySourceKey } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { buildTelemetryAnalyzeCacheKey, buildTelemetryCacheKey } from "../lib/pubg-analysis/telemetryCacheKey";
import { isCanonicalMatchId, type TelemetryMode, type TelemetryPlatform } from "../lib/pubg-analysis/telemetryIdentity";
import { isR2Configured, listR2ObjectsByPrefix, readObjectForVerification } from "../lib/pubg-analysis/r2Service";
import { sealRecoveryBytes } from "./r2_recovery_archive";

export const RECOVERY_MATCH_LIMIT = 30;
export const RECOVERY_DB_ROW_LIMIT = 101;
export const RECOVERY_OBJECT_LIMIT = 8;
export const RECOVERY_OBJECT_BYTES_LIMIT = 8 * 1024 * 1024;
export const RECOVERY_STORED_BYTES_LIMIT = 64 * 1024 * 1024;
export const RECOVERY_DECODED_BYTES_LIMIT = 32 * 1024 * 1024;
export const RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;
const TABLES = [
  "pubg_player_matches",
  "processed_match_telemetry",
  "pubg_match_performance",
  "match_stats_raw",
  "telemetry_map_cache_entries",
  "match_master_telemetry",
] as const;
const PLATFORM = new Set<TelemetryPlatform>(["steam", "kakao"]);

export type RecoveryRequest = { matchId: string; platform: TelemetryPlatform };
type MatchRows = Record<(typeof TABLES)[number], Record<string, unknown>[]>;
type RecoveryObject = {
  key: string;
  etag: string;
  sizeBytes: number;
  sha256: string;
  contentEncoding: string | null;
  bodyBase64: string;
};
type ReadObject = { key: string; etag: string; sizeBytes: number; contentEncoding: string | null; body: Buffer };
type RecoveryMatchSnapshot = {
  request: RecoveryRequest;
  rows: MatchRows;
  skippedCandidateCount: number;
  missingKeys: string[];
  legacyListingTruncated: boolean;
};
type RecoveryPayload = { requests: RecoveryRequest[]; matches: RecoveryMatchSnapshot[]; objects: RecoveryObject[] };
export type RecoverySummary = {
  requestedMatches: number;
  databaseRows: number;
  databaseTablesRead: number;
  r2Configured: boolean;
  r2ObjectsRead: number;
  r2BytesRead: number;
  decodedBytes: number;
  kinds: Record<string, number>;
  legacyListings: number;
  legacyTruncated: number;
  encryptedBytes: number;
};

export function formatRecoverySummary(summary: RecoverySummary): string {
  return JSON.stringify(summary);
}

export function parseRecoveryMatches(input: string): RecoveryRequest[] {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("recovery-matches-json-invalid"); }
  if (!Array.isArray(value) || value.length < 1 || value.length > RECOVERY_MATCH_LIMIT) throw new Error("recovery-matches-count-invalid");
  const seen = new Set<string>();
  return value.map((item): RecoveryRequest => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("recovery-match-invalid");
    const keys = Object.keys(item);
    const request = item as Record<string, unknown>;
    if (keys.length !== 2 || !keys.includes("matchId") || !keys.includes("platform")
      || typeof request.matchId !== "string" || !isCanonicalMatchId(request.matchId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.matchId)
      || typeof request.platform !== "string" || !PLATFORM.has(request.platform as TelemetryPlatform)) {
      throw new Error("recovery-match-invalid");
    }
    const parsed = { matchId: request.matchId, platform: request.platform as TelemetryPlatform };
    const identity = `${parsed.platform}:${parsed.matchId}`;
    if (seen.has(identity)) throw new Error("recovery-match-duplicate");
    seen.add(identity);
    return parsed;
  });
}

function sha256(body: Buffer): string { return createHash("sha256").update(body).digest("hex"); }
function safeNickname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const nickname = value.trim().toLowerCase();
  return nickname.length <= 160 && !/[\/\\\u0000-\u001f]/.test(nickname) ? nickname || null : null;
}
function decodeBounded(body: Buffer): number {
  if (body.length > RECOVERY_OBJECT_BYTES_LIMIT) throw new Error("recovery-object-size-limit");
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return body.length;
  return gunzipSync(body, { maxOutputLength: RECOVERY_DECODED_BYTES_LIMIT + 1 }).length;
}
function classifyObject(body: Buffer, key: string, request: RecoveryRequest): string {
  if (key === buildSharedTelemetrySourceKey(request.matchId, request.platform)) return "shared-source";
  try {
    const decoded = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b
      ? gunzipSync(body, { maxOutputLength: RECOVERY_DECODED_BYTES_LIMIT + 1 }).toString("utf8")
      : body.toString("utf8");
    const value: unknown = JSON.parse(decoded);
    if (Array.isArray(value)) return "event-array";
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const data = record.data;
      const fullResultWrapper = record.fullResult || (typeof data === "object" && data !== null && "fullResult" in data);
      const directMatchAnalysis = (record.matchId === request.matchId || record.match_id === request.matchId)
        && typeof record.stats === "object" && record.stats !== null && !Array.isArray(record.stats);
      if (fullResultWrapper || directMatchAnalysis) return "full-analysis";
    }
  } catch { /* Non-JSON and malformed data are summarized without contents. */ }
  return "other";
}

function canonicalCandidates(request: RecoveryRequest, rows: MatchRows): Array<{ key: string; kind: string }> {
  const basics = rows.pubg_player_matches;
  const candidates = new Map<string, string>();
  try { candidates.set(buildSharedTelemetrySourceKey(request.matchId, request.platform), "shared-source"); } catch { /* Invalid identity has no shared key. */ }

  const basicAccounts = new Map<string, string>();
  const nicknameAccounts = new Map<string, Set<string>>();
  for (const row of basics) {
    const account = typeof row.account_id === "string" && /^account\.[A-Za-z0-9_-]+$/.test(row.account_id) ? row.account_id : null;
    const nickname = safeNickname(row.player_id);
    if (account && nickname) {
      const accounts = nicknameAccounts.get(nickname) ?? new Set<string>();
      accounts.add(account);
      nicknameAccounts.set(nickname, accounts);
    }
    if (account) basicAccounts.set(account, account);
  }
  for (const [nickname, accounts] of nicknameAccounts) if (accounts.size === 1) basicAccounts.set(nickname, [...accounts][0]);
  const registry = [...rows.telemetry_map_cache_entries].sort((a, b) => Number(b.telemetry_version) - Number(a.telemetry_version));
  for (const row of registry) {
    if (row.match_id !== request.matchId || row.platform !== request.platform || row.status !== "ready") continue;
    const version = Number(row.telemetry_version);
    const mode = row.mode as TelemetryMode;
    const account = typeof row.player_id === "string" ? basicAccounts.get(row.player_id) ?? basicAccounts.get(safeNickname(row.player_id) ?? "") : undefined;
    if (!account || !Number.isInteger(version) || version < 1 || (mode !== "lite" && mode !== "full")) continue;
    const identity = { matchId: request.matchId, platform: request.platform, playerId: account, mode, telemetryVersion: version };
    try {
      const mapKey = buildTelemetryCacheKey(identity);
      if (row.storage_path !== mapKey) continue;
      candidates.set(mapKey, "map");
      candidates.set(buildTelemetryAnalyzeCacheKey(identity), "analysis");
    } catch { /* Invalid registry identity is excluded. */ }
  }

  const allowed = new Set(candidates.keys());
  for (const row of rows.match_master_telemetry) {
    if (row.match_id === request.matchId && typeof row.storage_path === "string" && allowed.has(row.storage_path)) {
      candidates.set(row.storage_path, candidates.get(row.storage_path)!);
    }
  }

  return [...candidates].map(([key, kind]) => ({ key, kind }));
}

export type RecoveryInspectorDependencies = {
  readRows: (request: RecoveryRequest, table: (typeof TABLES)[number], timeoutMs: number) => Promise<Record<string, unknown>[]>;
  r2Configured: () => boolean;
  listLegacy: (prefix: string) => Promise<{ objects: Array<{ key: string; sizeBytes: number; etag: string }>; pages: number; truncated: boolean }>;
  readObject: (key: string, maxBytes: number) => Promise<ReadObject | null>;
  seal: (body: Buffer, secret: string) => Buffer;
  writeCiphertext: (path: string, body: Buffer) => Promise<void>;
  now?: () => number;
};

export async function inspectExpiredMatchRecovery(input: {
  requests: RecoveryRequest[]; outputPath: string; secret: string;
}, deps: RecoveryInspectorDependencies): Promise<RecoverySummary> {
  const started = (deps.now ?? Date.now)();
  const matches: RecoveryPayload["matches"] = [];
  let databaseTablesRead = 0;
  let databaseRows = 0;
  for (const request of input.requests) {
    const rows = {} as MatchRows;
    for (const table of TABLES) {
      const remainingMs = RECOVERY_TIMEOUT_MS - ((deps.now ?? Date.now)() - started);
      if (remainingMs <= 0) throw new Error("recovery-inspection-timeout");
      const result = await deps.readRows(request, table, Math.min(15_000, remainingMs));
      if (!Array.isArray(result) || result.length >= RECOVERY_DB_ROW_LIMIT) throw new Error("recovery-db-row-limit");
      rows[table] = result;
      databaseTablesRead += 1;
      databaseRows += result.length;
    }
    matches.push({ request, rows, skippedCandidateCount: 0, missingKeys: [], legacyListingTruncated: false });
  }

  const configured = deps.r2Configured();
  const payload: RecoveryPayload = { requests: input.requests, matches, objects: [] };
  const kinds: Record<string, number> = { "event-array": 0, "full-analysis": 0, "shared-source": 0, other: 0 };
  let r2BytesRead = 0;
  let decodedBytes = 0;
  let legacyListings = 0;
  let legacyTruncated = 0;
  if (configured) {
    for (const match of matches) {
      if ((deps.now ?? Date.now)() - started >= RECOVERY_TIMEOUT_MS) throw new Error("recovery-inspection-timeout");
      const { request, rows } = match;
      const allowed = canonicalCandidates(request, rows);
      const legacy = await deps.listLegacy(`${request.matchId}_`);
      legacyListings += legacy.pages;
      if (legacy.truncated) legacyTruncated += 1;
      match.legacyListingTruncated = legacy.truncated;
      const basicNicknames = new Set(rows.pubg_player_matches.map((row) => safeNickname(row.player_id)).filter((x): x is string => x !== null));
      for (const listed of legacy.objects) {
        if (!listed.key.startsWith(`${request.matchId}_`)) continue;
        const matchLegacy = listed.key.match(/^([0-9a-f-]{36})_(.+)_v([1-9][0-9]*)_analyze\.json$/i);
        if (!matchLegacy || matchLegacy[1].toLowerCase() !== request.matchId.toLowerCase() || !basicNicknames.has(matchLegacy[2].toLowerCase())) continue;
        allowed.push({ key: listed.key, kind: "legacy-analysis" });
      }
      const candidates = [...new Map(allowed.map((candidate) => [candidate.key, candidate])).values()];
      const shared = candidates.filter((candidate) => candidate.kind === "shared-source");
      const versioned = candidates.filter((candidate) => candidate.kind !== "shared-source")
        .sort((a, b) => Number(/(?:\/v|_v)(\d+)(?:\/|_)/.exec(b.key)?.[1] ?? 0) - Number(/(?:\/v|_v)(\d+)(?:\/|_)/.exec(a.key)?.[1] ?? 0));
      const unique = [...shared, ...versioned].slice(0, RECOVERY_OBJECT_LIMIT);
      match.skippedCandidateCount = Math.max(0, candidates.length - unique.length);
      for (const candidate of unique) {
        if ((deps.now ?? Date.now)() - started >= RECOVERY_TIMEOUT_MS) throw new Error("recovery-inspection-timeout");
        const object = await deps.readObject(candidate.key, RECOVERY_OBJECT_BYTES_LIMIT);
        if (!object) { match.missingKeys.push(candidate.key); continue; }
        if (object.body.length > RECOVERY_OBJECT_BYTES_LIMIT || object.sizeBytes > RECOVERY_OBJECT_BYTES_LIMIT
          || object.body.length !== object.sizeBytes) throw new Error("recovery-object-size-invalid");
        r2BytesRead += object.body.length;
        if (r2BytesRead > RECOVERY_STORED_BYTES_LIMIT) throw new Error("recovery-total-size-limit");
        decodedBytes += decodeBounded(object.body);
        if (decodedBytes > RECOVERY_DECODED_BYTES_LIMIT) throw new Error("recovery-decoded-size-limit");
        const kind = classifyObject(object.body, object.key, request);
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        payload.objects.push({ key: object.key, etag: object.etag, sizeBytes: object.sizeBytes,
          sha256: sha256(object.body), contentEncoding: object.contentEncoding, bodyBase64: object.body.toString("base64") });
      }
    }
  }
  if ((deps.now ?? Date.now)() - started >= RECOVERY_TIMEOUT_MS) throw new Error("recovery-inspection-timeout");
  const ciphertext = deps.seal(Buffer.from(JSON.stringify(payload), "utf8"), input.secret);
  await deps.writeCiphertext(input.outputPath, ciphertext);
  return { requestedMatches: input.requests.length, databaseRows, databaseTablesRead, r2Configured: configured,
    r2ObjectsRead: payload.objects.length, r2BytesRead, decodedBytes, kinds, legacyListings, legacyTruncated, encryptedBytes: ciphertext.length };
}

async function readRows(db: SupabaseClient, request: RecoveryRequest, table: (typeof TABLES)[number], timeoutMs: number): Promise<Record<string, unknown>[]> {
  let query = db.from(table).select("*").eq("match_id", request.matchId);
  if (table !== "match_master_telemetry") query = query.eq("platform", request.platform);
  const { data, error } = await query.limit(RECOVERY_DB_ROW_LIMIT).abortSignal(AbortSignal.timeout(timeoutMs));
  if (error) throw new Error(`recovery-db-read-failed:${table}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

async function writeCiphertext(path: string, body: Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}

function parseArgs(argv: string[]): { matchesJson: string; output: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--matches-json" && flag !== "--output") throw new Error("recovery-cli-argument-invalid");
    const value = argv[++i];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error("recovery-cli-argument-invalid");
    values.set(flag, value);
  }
  const matchesJson = values.get("--matches-json");
  const output = values.get("--output");
  if (!matchesJson || !output || values.size !== 2) throw new Error("recovery-cli-argument-invalid");
  return { matchesJson, output };
}

export async function runRecoveryInspection(env = process.env, argv = process.argv.slice(2)): Promise<RecoverySummary> {
  const args = parseArgs(argv);
  const requests = parseRecoveryMatches(args.matchesJson);
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = env.R2_RECOVERY_ARCHIVE_KEY;
  if (!supabaseUrl || !serviceRoleKey || !secret) throw new Error("recovery-credentials-missing");
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  return inspectExpiredMatchRecovery({ requests, outputPath: args.output, secret }, {
    readRows: (request, table, timeoutMs) => readRows(db, request, table, timeoutMs),
    r2Configured: isR2Configured,
    listLegacy: (prefix) => listR2ObjectsByPrefix(prefix, { maxPages: 1, maxObjects: 100 }),
    readObject: async (key, maxBytes) => {
      const result = await readObjectForVerification(key, { maxBytes });
      return result && { key: result.key, etag: result.etag, sizeBytes: result.sizeBytes, contentEncoding: result.contentEncoding, body: result.body };
    },
    seal: sealRecoveryBytes,
    writeCiphertext,
  });
}

const direct = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  runRecoveryInspection().then((summary) => console.info(formatRecoverySummary(summary))).catch((error: unknown) => {
    void error;
    console.error(JSON.stringify({ error: "recovery-inspection-failed" }));
    process.exitCode = 1;
  });
}
