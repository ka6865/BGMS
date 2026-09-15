import dotenv from "dotenv";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getBanWatchAdminClient as createAdminClient, claimDueBanStatusRows as claimDueRows,
  recordBanObservation, recordBanStatusError, type BanWatchDb, type BanStatusLease } from "../lib/pubg/banWatch.server";
export type { BanStatusLease } from "../lib/pubg/banWatch.server";
import {
  BanApiError,
  fetchBanStatusBatch,
  type BanApiBatchResult,
  type BanApiClientOptions,
  type BanApiStatus,
} from "../lib/pubg/banApiClient";
import {
  isBanAccountId,
  isBanPlatform,
  isBanStatus,
  nextBanCheckAt,
  type BanPlatform,
  type BanStatus,
} from "../lib/pubg/banStatus";

export const MAX_API_BATCHES = 6;
export const API_BATCH_SIZE = 10;
export const BATCH_INTERVAL_MS = 65_000;
export const MAX_DURATION_MS = 8 * 60_000;
export const REQUEST_TIMEOUT_MS = 8_000;
export const LEASE_DURATION_MS = 15 * 60_000;
export const RETRY_DELAY_MS = 15 * 60_000;
export const NOT_FOUND_DELAY_MS = 6 * 60 * 60_000;
export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

type WorkerClock = () => number;

export type BanWatchWorkerSummary = {
  claimed: number;
  uniqueClaimed: number;
  batches: number;
  observed: number;
  stale: number;
  missing: number;
  errors: number;
  settlementFailures: number;
  rateLimited: boolean;
  stopped: boolean;
  durationMs: number;
};

export type BanWatchWorkerDependencies = {
  /** Supabase service-role client used by the default claim/settlement calls. */
  db?: BanWatchDb;
  /** Injected claim function for unit tests or a deployment-specific queue. */
  claim?: (limit: number, now: Date) => Promise<BanStatusLease[]>;
  /** Injected platform request. It must return only the requested platform's IDs. */
  fetchBatch?: (platform: BanPlatform, accountIds: string[]) => Promise<BanApiBatchResult>;
  /** Injected successful-observation writer. */
  observe?: (lease: BanStatusLease, status: BanApiStatus, checkedAt: string, nextCheckAt: string) => Promise<"recorded" | "stale">;
  /** Injected failed-observation writer. */
  recordError?: (lease: BanStatusLease, errorCode: string, nextCheckAt: string) => Promise<boolean>;
  /** Injectable clock and delay make the worker deterministic in tests. */
  now?: WorkerClock;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Initial values are bounded to protect a scheduled job from bad input. */
  maxBatches?: number;
  batchIntervalMs?: number;
  maxDurationMs?: number;
  claimLimit?: number;
  /** Credentials/request options are read only by the default fetcher. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  trackRateLimit?: (headers: Headers) => void;
};

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

function leaseKey(lease: BanStatusLease): string {
  return `${lease.platform}:${lease.accountId}`;
}

function isValidLease(value: unknown): value is BanStatusLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  return isBanPlatform(lease.platform)
    && isBanAccountId(lease.accountId)
    && typeof lease.leaseToken === "string"
    && lease.leaseToken.length > 0
    && typeof lease.leaseExpiresAt === "string"
    && Number.isFinite(Date.parse(lease.leaseExpiresAt));
}

function statusInterval(status: BanStatus, checkedAt: string): string {
  return nextBanCheckAt(status, new Date(checkedAt));
}

function errorCode(error: unknown): string {
  if (error instanceof BanApiError) {
    return error.code === "upstream_http" && error.status
      ? `${error.code}_${error.status}`
      : error.code;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    return code.slice(0, 200) || "worker_error";
  }
  return "worker_error";
}

function errorDelayMs(error: unknown): number {
  if (error instanceof BanApiError) {
    if (error.code === "rate_limited") {
      const retryAfter = Number(error.retryAfterSeconds);
      return Math.max(DEFAULT_RATE_LIMIT_DELAY_MS, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
    }
    if (error.code === "upstream_http" && error.status === 404) return NOT_FOUND_DELAY_MS;
  }
  return RETRY_DELAY_MS;
}

function safeNextCheckAt(now: number, delayMs: number): string {
  return new Date(now + Math.max(1, delayMs)).toISOString();
}

function defaultFetchBatch(deps: BanWatchWorkerDependencies): (platform: BanPlatform, accountIds: string[]) => Promise<BanApiBatchResult> {
  const options: BanApiClientOptions = {
    apiKey: deps.apiKey,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
    baseUrl: deps.baseUrl,
    trackRateLimit: deps.trackRateLimit,
  };
  return (platform, accountIds) => fetchBanStatusBatch(platform, accountIds, options);
}

/**
 * Claim active, due ban rows and settle each lease through the server-side
 * cache RPCs. A worker run performs at most six API calls and stops on 429.
 */
export async function runBanWatchWorker(deps: BanWatchWorkerDependencies = {}): Promise<BanWatchWorkerSummary> {
  const now: WorkerClock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const maxBatches = clampInteger(deps.maxBatches, MAX_API_BATCHES, 1, MAX_API_BATCHES);
  const batchIntervalMs = Math.max(0, Number.isFinite(deps.batchIntervalMs) ? Number(deps.batchIntervalMs) : BATCH_INTERVAL_MS);
  const maxDurationMs = Math.max(1, Number.isFinite(deps.maxDurationMs) ? Number(deps.maxDurationMs) : MAX_DURATION_MS);
  const claimLimit = clampInteger(deps.claimLimit, API_BATCH_SIZE, 1, API_BATCH_SIZE);
  const startedAt = now();
  const db = deps.db;
  const defaultDb = (): BanWatchDb => db ?? createAdminClient();
  const claim = deps.claim ?? ((limit: number, claimNow: Date) => claimDueRows(defaultDb(), limit, claimNow));
  const fetchBatch = deps.fetchBatch ?? defaultFetchBatch(deps);
  const observe = deps.observe ?? ((lease: BanStatusLease, status: BanApiStatus, checkedAt: string, nextCheck: string) => recordBanObservation({platform:lease.platform,accountId:lease.accountId,rawType:status.rawType,checkedAt,nextCheckAt:nextCheck,leaseToken:lease.leaseToken},defaultDb()).then(result=>result.code));
  const recordError = deps.recordError ?? ((lease: BanStatusLease, code: string, nextCheck: string) => recordBanStatusError(lease,code,nextCheck,defaultDb()));
  const summary: BanWatchWorkerSummary = {
    claimed: 0,
    uniqueClaimed: 0,
    batches: 0,
    observed: 0,
    stale: 0,
    missing: 0,
    errors: 0,
    settlementFailures: 0,
    rateLimited: false,
    stopped: false,
    durationMs: 0,
  };
  const seen = new Set<string>();
  let lastRequestAt: number | null = null;

  const settleError = async (leases: BanStatusLease[], error: unknown, at: number): Promise<void> => {
    const delay = errorDelayMs(error);
    const nextCheck = safeNextCheckAt(at, delay);
    const code = errorCode(error);
    for (const lease of leases) {
      try {
        if (await recordError(lease, code, nextCheck)) summary.errors += 1;
        else summary.settlementFailures += 1;
      } catch {
        summary.settlementFailures += 1;
      }
    }
  };

  const processBatch = async (platform: BanPlatform, leases: BanStatusLease[]): Promise<boolean> => {
    if (!leases.length || summary.batches >= maxBatches) return true;
    const currentTime = now();
    if (currentTime - startedAt >= maxDurationMs) {
      summary.stopped = true;
      return false;
    }
    if (lastRequestAt !== null) {
      const waitMs = Math.max(0, batchIntervalMs - (currentTime - lastRequestAt));
      if (waitMs > 0) {
        if (currentTime - startedAt + waitMs >= maxDurationMs) {
          summary.stopped = true;
          return false;
        }
        await sleep(waitMs);
      }
    }
    const requestAt = now();
    lastRequestAt = requestAt;
    summary.batches += 1;
    const accountIds = [...new Set(leases.map((lease) => lease.accountId))];
    let result: BanApiBatchResult;
    try {
      result = await fetchBatch(platform, accountIds);
      if (!result || result.platform !== platform || !Array.isArray(result.statuses) || !Array.isArray(result.missingAccountIds)) {
        throw new BanApiError("invalid_shape", { platform });
      }
    } catch (error) {
      await settleError(leases, error, now());
      if (error instanceof BanApiError && error.code === "rate_limited") {
        summary.rateLimited = true;
        summary.stopped = true;
        return false;
      }
      return true;
    }

    const byId = new Map(leases.map((lease) => [lease.accountId, lease]));
    const checkedAt = new Date(now()).toISOString();
    const returned = new Set<string>();
    for (const status of result.statuses) {
      if (!status || status.platform !== platform || !isBanAccountId(status.accountId) || !isBanStatus(status.status)) {
        await settleError(leases, new BanApiError("invalid_shape", { platform }), now());
        return true;
      }
      const lease = byId.get(status.accountId);
      if (!lease || returned.has(status.accountId)) continue;
      returned.add(status.accountId);
      try {
        const code = await observe(lease, status, checkedAt, statusInterval(status.status, checkedAt));
        if (code === "stale") summary.stale += 1;
        else summary.observed += 1;
      } catch {
        await settleError([lease], new BanApiError("network_error", { platform }), now());
      }
    }
    const missing = new Set(result.missingAccountIds.filter((id) => isBanAccountId(id)));
    for (const lease of leases) {
      if (returned.has(lease.accountId)) continue;
      missing.add(lease.accountId);
      summary.missing += 1;
      try {
        if (await recordError(lease, "missing_account", safeNextCheckAt(now(), NOT_FOUND_DELAY_MS))) summary.errors += 1;
        else summary.settlementFailures += 1;
      } catch {
        summary.settlementFailures += 1;
      }
    }
    return true;
  };

  while (summary.batches < maxBatches && now() - startedAt < maxDurationMs) {
    let leases: BanStatusLease[];
    try {
      leases = await claim(claimLimit, new Date(now()));
    } catch (error) {
      summary.stopped = true;
      summary.durationMs = Math.max(0, now() - startedAt);
      throw error;
    }
    summary.claimed += leases.length;
    const fresh = leases.filter((lease) => {
      if (!isValidLease(lease)) return false;
      const key = leaseKey(lease);
      if (seen.has(key)) return false;
      seen.add(key);
      summary.uniqueClaimed += 1;
      return true;
    });
    if (!fresh.length) {
      // Empty claims finish the run. A duplicate-only claim is also stopped;
      // repeatedly leasing the same key would otherwise spin forever when a
      // queue adapter returns an unchanged page.
      break;
    }
    const groups = new Map<BanPlatform, BanStatusLease[]>();
    for (const lease of fresh) {
      const group = groups.get(lease.platform) ?? [];
      group.push(lease);
      groups.set(lease.platform, group);
    }
    for (const [platform, group] of groups) {
      for (let offset = 0; offset < group.length && summary.batches < maxBatches; offset += API_BATCH_SIZE) {
        const shouldContinue = await processBatch(platform, group.slice(offset, offset + API_BATCH_SIZE));
        if (!shouldContinue) break;
      }
      if (summary.stopped) break;
    }
    if (summary.stopped) break;
  }
  summary.durationMs = Math.max(0, now() - startedAt);
  return summary;
}

export async function main(args = process.argv.slice(2)): Promise<BanWatchWorkerSummary | { mode: "dry-run" }> {
  dotenv.config({ path: ".env.local", quiet: true });
  if (!args.includes("--apply")) return { mode: "dry-run" };
  const result = await runBanWatchWorker({
    db: createAdminClient(),
    apiKey: (process.env.PUBG_API_KEY ?? "").split(" ")[0],
  });
  if (result.settlementFailures > 0) {
    throw new Error(`ban-watch-settlement-failures:${result.settlementFailures}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(`PUBG ban worker failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 1;
    });
}
