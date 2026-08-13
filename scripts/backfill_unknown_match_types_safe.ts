import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const DEFAULT_LIMIT = 1_000;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_MAX_RUNTIME_MINUTES = 720;
const DEFAULT_MAX_REQUESTS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_FILE = "/tmp/bgms-match-type-backfill-safe.lock";
const DEFAULT_LOG_FILE = "/tmp/bgms-match-type-backfill-safe.log";
const MAX_LIMIT = 5_000;
const MAX_DELAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RUNTIME_MINUTES = 24 * 60;
const MAX_REQUESTS = 5_000;

export const SAFE_UNKNOWN_MATCH_TYPE_BACKFILL_ORDER = {
  column: "played_at",
  ascending: false,
} as const;

export type SafeBackfillArgs = {
  apply: boolean;
  limit: number;
  delayMs: number;
  maxRuntimeMinutes: number;
  maxRequests: number;
  timeoutMs: number;
  lockFile: string;
  logFile: string;
};

export type SafeBackfillDisposition =
  | "updated"
  | "unavailable"
  | "skipped_changed"
  | "unresolved"
  | "rate_limited"
  | "server_error"
  | "request_error";

export type SafeBackfillSummary = {
  dryRun: boolean;
  candidates: number;
  requests: number;
  updated: number;
  unavailable: number;
  skippedChanged: number;
  unresolved: number;
  rateLimited: boolean;
  stoppedReason: string | null;
};

type UnknownMatchRow = {
  match_id: string;
  player_id: string;
  platform: string;
  played_at?: string | null;
};

type SafeMatchRecord = {
  player_id: string;
  platform: string;
  match_id: string;
  played_at: string;
  game_mode: string;
  map_name: string;
  kills: number;
  damage: number;
  win_place: number;
  match_type: string;
};

type FetchResult = {
  disposition: SafeBackfillDisposition;
  status: number;
  record?: SafeMatchRecord;
};

type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

type RunDependencies = {
  supabase?: SupabaseClient;
  fetchImpl?: FetchImpl;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  pid?: number;
};

export function parseSafeBackfillArgs(args: string[]): SafeBackfillArgs {
  const valueFor = (name: string, fallback: number): number => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = Number(args[index + 1]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number`);
    }
    return value;
  };
  const stringFor = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  const limit = Math.min(Math.floor(valueFor("--limit", DEFAULT_LIMIT)), MAX_LIMIT);
  const delayMs = Math.min(Math.floor(valueFor("--delay-ms", DEFAULT_DELAY_MS)), MAX_DELAY_MS);
  const maxRuntimeMinutes = Math.min(
    Math.floor(valueFor("--max-runtime-minutes", DEFAULT_MAX_RUNTIME_MINUTES)),
    MAX_RUNTIME_MINUTES,
  );
  const maxRequests = Math.min(Math.floor(valueFor("--max-requests", DEFAULT_MAX_REQUESTS)), MAX_REQUESTS);
  const timeoutMs = Math.min(Math.floor(valueFor("--timeout-ms", DEFAULT_TIMEOUT_MS)), 60_000);

  return {
    apply: args.includes("--apply"),
    limit,
    delayMs,
    maxRuntimeMinutes,
    maxRequests,
    timeoutMs,
    lockFile: stringFor("--lock-file", DEFAULT_LOCK_FILE),
    logFile: stringFor("--log-file", DEFAULT_LOG_FILE),
  };
}

export function classifySafeBackfillStatus(status: number): SafeBackfillDisposition {
  if (status === 404) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "request_error";
  if (status >= 500) return "server_error";
  if (status > 0 && status < 400) return "unresolved";
  return "request_error";
}

export function shouldStopSafeBackfill(disposition: SafeBackfillDisposition): boolean {
  return disposition === "rate_limited" || disposition === "server_error" || disposition === "request_error";
}

export function buildSafeMatchRecord(
  candidate: Pick<UnknownMatchRow, "match_id" | "player_id" | "platform">,
  matchAttributes: Record<string, unknown>,
  stats: Record<string, unknown>,
): SafeMatchRecord {
  return {
    player_id: normalizeName(candidate.player_id),
    platform: normalizePlatform(candidate.platform),
    match_id: candidate.match_id,
    played_at: String(matchAttributes.createdAt || new Date().toISOString()),
    game_mode: String(matchAttributes.gameMode || "unknown"),
    map_name: String(matchAttributes.mapName || "unknown"),
    kills: Number(stats.kills || 0),
    damage: Math.floor(Number(stats.damageDealt || 0)),
    win_place: Number(stats.winPlace || 99),
    match_type: String(matchAttributes.matchType || "unknown").toLowerCase(),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendLog(logFile: string, message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    process.stderr.write(`[SAFE BACKFILL] unable to append log file: ${logFile}\n`);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile: string, pid = process.pid): () => void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const lockContents = JSON.stringify({ pid, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockFile, "wx");
      fs.writeFileSync(descriptor, lockContents);
      fs.closeSync(descriptor);
      return () => {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // The process may have already cleaned up the lock after a signal.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingPid = 0;
      try {
        existingPid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid);
      } catch {
        // An incomplete lock is safe to reclaim once; the owning process would
        // have written its pid before starting any network work.
      }
      if (isProcessAlive(existingPid)) {
        throw new Error(`Safe match-type backfill is already running (pid ${existingPid})`);
      }
      fs.unlinkSync(lockFile);
    }
  }

  throw new Error(`Unable to acquire safe backfill lock: ${lockFile}`);
}

async function fetchSafeMatchRecord(
  candidate: UnknownMatchRow,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://api.pubg.com/shards/${normalizePlatform(candidate.platform)}/matches/${encodeURIComponent(candidate.match_id)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const disposition = classifySafeBackfillStatus(response.status);
      return { disposition, status: response.status };
    }

    const body = await response.json() as { data?: { attributes?: Record<string, unknown> }; included?: Array<{ type?: string; attributes?: { stats?: Record<string, unknown> } }> };
    const attributes = body.data?.attributes || {};
    const playerId = normalizeName(candidate.player_id);
    const participant = (body.included || []).find((item) =>
      item.type === "participant" && normalizeName(String(item.attributes?.stats?.name || "")) === playerId,
    );
    if (!participant?.attributes?.stats) return { disposition: "unresolved", status: 200 };
    const record = buildSafeMatchRecord(candidate, attributes, participant.attributes.stats);
    if (!record.match_type || record.match_type === "unknown") {
      return { disposition: "unresolved", status: 200 };
    }
    return {
      disposition: "updated",
      status: 200,
      record,
    };
  } catch {
    return { disposition: "request_error", status: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

async function readUnknownCandidates(supabase: SupabaseClient, limit: number): Promise<UnknownMatchRow[]> {
  const { data, error } = await supabase
    .from("pubg_player_matches")
    .select("match_id, player_id, platform, played_at")
    .eq("match_type", "unknown")
    .order(SAFE_UNKNOWN_MATCH_TYPE_BACKFILL_ORDER.column, { ascending: SAFE_UNKNOWN_MATCH_TYPE_BACKFILL_ORDER.ascending })
    .limit(limit);
  if (error) throw new Error(`Failed to load unknown match types: ${error.message}`);
  return (data || []) as UnknownMatchRow[];
}

async function isStillUnknown(supabase: SupabaseClient, candidate: UnknownMatchRow): Promise<boolean> {
  const { data, error } = await supabase
    .from("pubg_player_matches")
    .select("match_type")
    .eq("match_id", candidate.match_id)
    .eq("player_id", candidate.player_id)
    .eq("platform", candidate.platform)
    .eq("match_type", "unknown")
    .maybeSingle();
  if (error) throw new Error(`Failed to recheck ${candidate.match_id}: ${error.message}`);
  return Boolean(data);
}

async function persistOnlyUnknown(supabase: SupabaseClient, candidate: UnknownMatchRow, record: SafeMatchRecord): Promise<"updated" | "skipped_changed"> {
  const { data, error } = await supabase
    .from("pubg_player_matches")
    // This local repair owns only match_type. Never rewrite played_at or
    // compact stats from a delayed/partial PUBG response.
    .update({ match_type: record.match_type })
    .eq("match_id", candidate.match_id)
    .eq("player_id", candidate.player_id)
    .eq("platform", candidate.platform)
    .eq("match_type", "unknown")
    .select("match_id")
    .maybeSingle();
  if (error) throw new Error(`Failed to update ${candidate.match_id}: ${error.message}`);
  return data ? "updated" : "skipped_changed";
}

export async function runSafeUnknownMatchTypeBackfill(
  args: SafeBackfillArgs,
  dependencies: RunDependencies = {},
): Promise<SafeBackfillSummary> {
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("This script is local-only and refuses to run inside GitHub Actions");
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
  if (!supabaseUrl || !serviceKey || !apiKey) throw new Error("Missing Supabase or PUBG API credentials");

  const supabase = dependencies.supabase || createClient(supabaseUrl, serviceKey);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const pause = dependencies.sleep || sleep;
  const now = dependencies.now || Date.now;
  const releaseLock = acquireLock(args.lockFile, dependencies.pid);
  const startedAt = now();
  const summary: SafeBackfillSummary = {
    dryRun: !args.apply,
    candidates: 0,
    requests: 0,
    updated: 0,
    unavailable: 0,
    skippedChanged: 0,
    unresolved: 0,
    rateLimited: false,
    stoppedReason: null,
  };

  try {
    const candidates = await readUnknownCandidates(supabase, Math.min(args.limit, args.maxRequests));
    summary.candidates = candidates.length;
    appendLog(args.logFile, `[SAFE BACKFILL] mode=${args.apply ? "apply" : "dry-run"} candidates=${candidates.length} limit=${args.limit} delayMs=${args.delayMs} maxRuntimeMinutes=${args.maxRuntimeMinutes} maxRequests=${args.maxRequests}`);

    if (!args.apply) {
      for (const candidate of candidates.slice(0, 10)) {
        appendLog(args.logFile, `[SAFE BACKFILL] candidate=${candidate.platform}:${candidate.player_id}:${candidate.match_id} played_at=${candidate.played_at || "unknown"}`);
      }
      summary.stoppedReason = "dry_run";
      return summary;
    }

    for (const candidate of candidates) {
      if (summary.requests >= args.maxRequests) {
        summary.stoppedReason = "max_requests";
        break;
      }
      if (now() - startedAt >= args.maxRuntimeMinutes * 60 * 1_000) {
        summary.stoppedReason = "max_runtime";
        break;
      }
      if (!(await isStillUnknown(supabase, candidate))) {
        summary.skippedChanged += 1;
        continue;
      }

      summary.requests += 1;
      const result = await fetchSafeMatchRecord(candidate, apiKey, args.timeoutMs, fetchImpl);
      if (result.disposition === "unavailable") {
        const { error } = await supabase
          .from("pubg_player_matches")
          .update({ match_type: "unavailable" })
          .eq("match_id", candidate.match_id)
          .eq("player_id", candidate.player_id)
          .eq("platform", candidate.platform)
          .eq("match_type", "unknown");
        if (error) throw new Error(`Failed to mark unavailable ${candidate.match_id}: ${error.message}`);
        summary.unavailable += 1;
      } else if (result.disposition === "updated" && result.record) {
        const persisted = await persistOnlyUnknown(supabase, candidate, result.record);
        if (persisted === "updated") summary.updated += 1;
        else summary.skippedChanged += 1;
      } else if (result.disposition === "unresolved") {
        summary.unresolved += 1;
      } else {
        summary.rateLimited = result.disposition === "rate_limited";
        summary.stoppedReason = result.disposition;
        appendLog(args.logFile, `[SAFE BACKFILL] stopping disposition=${result.disposition} status=${result.status} match=${candidate.match_id}`);
        break;
      }

      if (summary.requests < args.maxRequests && !summary.stoppedReason) await pause(args.delayMs);
      if (summary.requests % 10 === 0 || summary.updated + summary.unavailable + summary.unresolved > 0) {
        appendLog(args.logFile, `[SAFE BACKFILL] progress requests=${summary.requests} updated=${summary.updated} unavailable=${summary.unavailable} skippedChanged=${summary.skippedChanged} unresolved=${summary.unresolved}`);
      }
    }
    if (!summary.stoppedReason && summary.requests >= args.maxRequests) summary.stoppedReason = "max_requests";
    appendLog(args.logFile, `[SAFE BACKFILL] result=${JSON.stringify(summary)}`);
    return summary;
  } finally {
    releaseLock();
  }
}

if (process.argv[1]?.includes("backfill_unknown_match_types_safe")) {
  runSafeUnknownMatchTypeBackfill(parseSafeBackfillArgs(process.argv.slice(2)))
    .then((summary) => {
      process.exitCode = summary.stoppedReason === "request_error" || summary.stoppedReason === "server_error" ? 1 : 0;
    })
    .catch((error) => {
      console.error("[SAFE BACKFILL] failed", error);
      process.exitCode = 1;
    });
}
