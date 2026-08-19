import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import dotenv from "dotenv";
import path from "path";
import {
  claimLinkedPlayerSync,
  completeLinkedPlayerSync,
  type LinkedPlayerSyncRpcClient,
} from "../lib/pubg/linkedPlayerSync.server";
import {
  getLinkedPlayerSyncNextEligibleAt,
  buildPlayerRefreshLockKey,
} from "../lib/pubg/linkedPlayerSync";
import {
  fetchSyncCandidateUsers,
  type SyncCandidateUser,
} from "../lib/pubg/userSyncHelper";
import {
  fetchAndIngestBasicMatchSummaryOutcome,
  type BasicMatchIngestOutcome,
  type PubgFetchImpl,
  type PubgRateLimitHeaderSnapshot,
} from "../lib/pubg/playerMatchesIngest";
import { claimForceRefresh } from "../lib/pubg/responseCache";
import {
  defaultSleep,
  fetchRecentMatchIds,
  persistRateLimitSnapshot,
  readExistingMatchIds,
  readLatestQuota,
  recordRateLimit,
} from "../lib/pubg/syncRunnerBoundaries";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 15;
const DEFAULT_LEASE_MS = 15 * 60 * 1_000;
const DEFAULT_MATCH_LIMIT = 10;
const DEFAULT_MATCH_DELAY_MS = 1_000;
const DEFAULT_PLAYER_TIMEOUT_MS = 8_000;
const DEFAULT_SAFE_REMAINING = 0;

export type SyncStopReason = "rate_limited" | "quota_exhausted" | null;

export type SyncQuotaStatus = {
  remaining: number;
  resetAt: string | null;
};

export type FetchRecentMatchIdsResult = {
  status: number;
  matchIds: string[];
  rateLimitHeaders: PubgRateLimitHeaderSnapshot | null;
  error?: string;
};

export type SyncRunSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  candidateCount: number;
  claimedCount: number;
  syncedIdentities: number;
  newMatches: number;
  lockCollisions: number;
  invalidNicknames: number;
  notFoundMatches: number;
  upstreamErrors: number;
  networkErrors: number;
  rateLimited: boolean;
  stoppedReason: SyncStopReason;
  nextEligibleAt: string[];
  playerRateLimitHeaders: PubgRateLimitHeaderSnapshot[];
  matchRateLimitHeaders: PubgRateLimitHeaderSnapshot[];
  rateLimitTrackingErrors: number;
};

export type SyncRunnerDependencies = {
  supabase?: SupabaseClient;
  apiKey?: string;
  fetchCandidates?: (supabase: SupabaseClient, limit: number) => Promise<SyncCandidateUser[]>;
  claimSyncLease?: (input: {
    supabaseAdmin?: LinkedPlayerSyncRpcClient;
    platform: string;
    normalizedNickname: string;
    displayNickname: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }) => Promise<boolean>;
  claimRefreshLock?: (lockKey: string) => Promise<boolean>;
  completeSync?: (input: {
    supabaseAdmin?: LinkedPlayerSyncRpcClient;
    platform: string;
    normalizedNickname: string;
    leaseToken: string;
    status: "idle" | "success" | "failed" | "invalid_nickname" | "rate_limited";
    lastSuccessAt: string | null;
    nextEligibleAt: string | null;
    consecutiveFailures: number;
    lastErrorCode: string | null;
  }) => Promise<boolean>;
  readQuota?: (supabase: SupabaseClient) => Promise<SyncQuotaStatus | null>;
  fetchRecentMatchIds?: (
    candidate: SyncCandidateUser,
    apiKey: string,
    fetchImpl: PubgFetchImpl,
  ) => Promise<FetchRecentMatchIdsResult>;
  readExistingMatchIds?: (
    supabase: SupabaseClient,
    candidate: SyncCandidateUser,
    matchIds: string[],
  ) => Promise<string[]>;
  ingestMatch?: (
    supabase: SupabaseClient,
    matchId: string,
    candidate: SyncCandidateUser,
    apiKey: string,
    fetchImpl: PubgFetchImpl,
  ) => Promise<BasicMatchIngestOutcome>;
  fetchImpl?: PubgFetchImpl;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  createLeaseToken?: () => string;
  writeOutput?: (summary: SyncRunSummary) => void;
  trackRateLimit?: (
    headers: PubgRateLimitHeaderSnapshot,
    source: "player" | "match",
  ) => void | Promise<void>;
  leaseDurationMs?: number;
  matchLimit?: number;
  matchDelayMs?: number;
  playerTimeoutMs?: number;
  safeRemaining?: number;
};

export type RunSyncUserMatchesOptions = Partial<SyncRunnerDependencies> & {
  limit?: number;
  dependencies?: SyncRunnerDependencies;
};

export function parseSyncScriptArgs(args: string[]): { limit: number } {
  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const val = Number(args[limitIdx + 1]);
    if (Number.isInteger(val) && val > 0) return { limit: val };
  }
  return { limit: DEFAULT_LIMIT };
}

export function shouldStopSyncAfterStatus(status: number): boolean {
  return status === 429;
}

/** Preserve the existing GitHub Actions output contract. */
export function writeRateLimitOutput(
  rateLimited: boolean,
  outputPath = process.env.GITHUB_OUTPUT,
): void {
  if (!outputPath) return;
  appendFileSync(outputPath, `rate_limited=${rateLimited}\n`);
}

export function writeSyncRunOutput(
  summary: SyncRunSummary,
  outputPath = process.env.GITHUB_OUTPUT,
): void {
  if (!outputPath) return;
  const serialized = JSON.stringify(summary);
  appendFileSync(outputPath, [
    `rate_limited=${summary.rateLimited}`,
    `sync_summary=${serialized}`,
    `candidate_count=${summary.candidateCount}`,
    `synced_identities=${summary.syncedIdentities}`,
    `new_matches=${summary.newMatches}`,
    `lock_collisions=${summary.lockCollisions}`,
    `stopped_reason=${summary.stoppedReason || ""}`,
    "",
  ].join("\n"));
}

type CompletionStatus = "idle" | "success" | "failed" | "invalid_nickname" | "rate_limited";

type CompletionInput = {
  status: CompletionStatus;
  lastSuccessAt: string | null;
  nextEligibleAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
};

class SyncSettlementError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SyncSettlementError";
  }
}

class SyncControlPlaneError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SyncControlPlaneError";
  }
}

function assertSyncDependencies(input: {
  apiKey: string;
  supabase?: SupabaseClient;
  usesDefaultCandidateBoundary: boolean;
  usesDefaultLeaseBoundary: boolean;
  usesDefaultLockBoundary: boolean;
  usesDefaultCompletionBoundary: boolean;
  usesDefaultQuotaBoundary: boolean;
  usesDefaultPlayerBoundary: boolean;
  usesDefaultExistingBoundary: boolean;
  usesDefaultIngestBoundary: boolean;
  usesDefaultTrackerBoundary: boolean;
}): void {
  if ((input.usesDefaultPlayerBoundary || input.usesDefaultIngestBoundary) && !input.apiKey) {
    throw new Error("PUBG_API_KEY missing");
  }
  if (
    (input.usesDefaultCandidateBoundary
      || input.usesDefaultLeaseBoundary
      || input.usesDefaultCompletionBoundary
      || input.usesDefaultQuotaBoundary
      || input.usesDefaultExistingBoundary
      || input.usesDefaultIngestBoundary)
    && !input.supabase
  ) {
    throw new Error("sync-user-matches-supabase-missing");
  }
  if (input.usesDefaultLockBoundary && !hasServiceRoleCredentials()) {
    throw new Error("sync-user-matches-refresh-lock-credentials-missing");
  }
  if (input.usesDefaultTrackerBoundary && !input.supabase) {
    throw new Error("sync-user-matches-rate-limit-tracker-missing");
  }
}

function hasServiceRoleCredentials(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
      && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

function isQuotaExhausted(
  quota: SyncQuotaStatus,
  safeRemaining: number,
  nowMs: number,
): boolean {
  if (quota.remaining > safeRemaining) return false;
  if (!quota.resetAt) return true;
  const resetMs = Date.parse(quota.resetAt);
  return !Number.isFinite(resetMs) || resetMs > nowMs;
}

function futureResetAt(resetAt: string | null, nowMs: number): string | null {
  if (!resetAt) return null;
  const resetMs = Date.parse(resetAt);
  return Number.isFinite(resetMs) && resetMs > nowMs
    ? new Date(resetMs).toISOString()
    : null;
}

async function settleFailed(
  candidate: SyncCandidateUser,
  settle: (input: CompletionInput) => Promise<void>,
  summary: SyncRunSummary,
  now: () => Date,
  previousFailures: number,
  errorCode: "upstream_error" | "network_error" | "database_error",
): Promise<void> {
  const consecutiveFailures = Math.max(0, previousFailures) + 1;
  const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({
    status: "failed",
    consecutiveFailures,
  }, now().getTime());
  summary.nextEligibleAt.push(nextEligibleAt);
  await settle({
    status: "failed",
    lastSuccessAt: candidate.lastSuccessAt,
    nextEligibleAt,
    consecutiveFailures,
    lastErrorCode: errorCode,
  });
}

/**
 * Run one linked-player sync pass. Every external boundary is injectable so
 * tests can exercise the state machine without a remote database or PUBG API.
 */
export async function runSyncUserMatches(
  options: RunSyncUserMatchesOptions = {},
): Promise<SyncRunSummary> {
  const dependencies: SyncRunnerDependencies = {
    ...(options.dependencies || {}),
    ...options,
  };
  const supabase = dependencies.supabase;
  const apiKey = dependencies.apiKey?.trim() || "";
  const limit = Math.min(Math.max(Math.floor(options.limit || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const now = dependencies.now || (() => new Date());
  const started = now();
  const startedAt = started.toISOString();
  const startedMs = started.getTime();
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sleep = dependencies.sleep || defaultSleep;
  const createLeaseToken = dependencies.createLeaseToken || randomUUID;
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const matchLimit = dependencies.matchLimit ?? DEFAULT_MATCH_LIMIT;
  const matchDelayMs = dependencies.matchDelayMs ?? DEFAULT_MATCH_DELAY_MS;
  const playerTimeoutMs = dependencies.playerTimeoutMs ?? DEFAULT_PLAYER_TIMEOUT_MS;
  const safeRemaining = dependencies.safeRemaining ?? DEFAULT_SAFE_REMAINING;
  const summary: SyncRunSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    candidateCount: 0,
    claimedCount: 0,
    syncedIdentities: 0,
    newMatches: 0,
    lockCollisions: 0,
    invalidNicknames: 0,
    notFoundMatches: 0,
    upstreamErrors: 0,
    networkErrors: 0,
    rateLimited: false,
    stoppedReason: null,
    nextEligibleAt: [],
    playerRateLimitHeaders: [],
    matchRateLimitHeaders: [],
    rateLimitTrackingErrors: 0,
  };

  const usesDefaultCandidateBoundary = !dependencies.fetchCandidates;
  const usesDefaultLeaseBoundary = !dependencies.claimSyncLease;
  const usesDefaultLockBoundary = !dependencies.claimRefreshLock;
  const usesDefaultCompletionBoundary = !dependencies.completeSync;
  const usesDefaultQuotaBoundary = !dependencies.readQuota;
  const usesDefaultPlayerBoundary = !dependencies.fetchRecentMatchIds;
  const usesDefaultExistingBoundary = !dependencies.readExistingMatchIds;
  const usesDefaultIngestBoundary = !dependencies.ingestMatch;
  const usesDefaultTrackerBoundary = !dependencies.trackRateLimit;
  assertSyncDependencies({
    apiKey,
    supabase,
    usesDefaultCandidateBoundary,
    usesDefaultLeaseBoundary,
    usesDefaultLockBoundary,
    usesDefaultCompletionBoundary,
    usesDefaultQuotaBoundary,
    usesDefaultPlayerBoundary,
    usesDefaultExistingBoundary,
    usesDefaultIngestBoundary,
    usesDefaultTrackerBoundary,
  });

  const fetchCandidates = dependencies.fetchCandidates || ((client, candidateLimit) => (
    fetchSyncCandidateUsers(client, candidateLimit)
  ));
  const claimLease = dependencies.claimSyncLease || ((input) => claimLinkedPlayerSync(input));
  const claimLock = dependencies.claimRefreshLock || ((lockKey) => claimForceRefresh(lockKey));
  const complete = dependencies.completeSync || ((input) => completeLinkedPlayerSync(input));
  const readQuota = dependencies.readQuota || ((client) => readLatestQuota(client));
  const fetchRecent = dependencies.fetchRecentMatchIds || ((candidate, key, impl) => (
    fetchRecentMatchIds(candidate, key, impl, playerTimeoutMs)
  ));
  const readExisting = dependencies.readExistingMatchIds || ((client, candidate, matchIds) => (
    readExistingMatchIds(client, candidate, matchIds)
  ));
  const ingest = dependencies.ingestMatch || ((client, matchId, candidate, key, impl) => (
    fetchAndIngestBasicMatchSummaryOutcome(
      client,
      matchId,
      candidate.displayNickname,
      candidate.platform,
      key,
      { fetchImpl: impl },
    )
  ));
  const trackRateLimit = dependencies.trackRateLimit || (
    supabase ? (headers: PubgRateLimitHeaderSnapshot) => persistRateLimitSnapshot(supabase, headers) : undefined
  );

  try {
    const candidates = await fetchCandidates(supabase as SupabaseClient, limit);
    summary.candidateCount = candidates.length;

    for (const candidate of candidates) {
      if (summary.stoppedReason) break;

      const leaseToken = createLeaseToken();
      const leaseStarted = now();
      const leaseExpiresAt = new Date(leaseStarted.getTime() + leaseDurationMs).toISOString();
      let ownsLease = false;
      let leaseSettled = false;
      let cleanupAttempted = false;
      let currentFailures = Math.max(0, candidate.consecutiveFailures || 0);

      const settle = async (input: CompletionInput): Promise<void> => {
        try {
          const result = await complete({
            supabaseAdmin: supabase as unknown as LinkedPlayerSyncRpcClient,
            platform: candidate.platform,
            normalizedNickname: candidate.normalizedNickname,
            leaseToken,
            ...input,
          });
          if (result !== true) {
            throw new SyncSettlementError("linked-player-sync-completion-rejected");
          }
          leaseSettled = true;
        } catch (error) {
          if (error instanceof SyncSettlementError) throw error;
          throw new SyncSettlementError("linked-player-sync-completion-failed", error);
        }
      };

      const releaseLeaseBestEffort = async (lastErrorCode: string | null): Promise<void> => {
        if (!ownsLease || leaseSettled || cleanupAttempted) return;
        cleanupAttempted = true;
        try {
          const result = await complete({
            supabaseAdmin: supabase as unknown as LinkedPlayerSyncRpcClient,
            platform: candidate.platform,
            normalizedNickname: candidate.normalizedNickname,
            leaseToken,
            status: "idle",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt: new Date(now().getTime()).toISOString(),
            consecutiveFailures: currentFailures,
            lastErrorCode,
          });
          if (result === true) leaseSettled = true;
        } catch {
          // Expired leases remain reclaimable by the next scheduled run.
        }
      };

      let claimed: boolean;
      try {
        claimed = await claimLease({
          supabaseAdmin: supabase as unknown as LinkedPlayerSyncRpcClient,
          platform: candidate.platform,
          normalizedNickname: candidate.normalizedNickname,
          displayNickname: candidate.displayNickname,
          leaseToken,
          leaseExpiresAt,
        });
      } catch (error) {
        throw new SyncControlPlaneError("linked-player-sync-claim-failed", error);
      }
      if (!claimed) continue;

      ownsLease = true;
      summary.claimedCount += 1;

      try {
        const lockKey = buildPlayerRefreshLockKey(candidate.platform, candidate.normalizedNickname);
        const locked = await claimLock(lockKey);
        if (!locked) {
          summary.lockCollisions += 1;
          await settle({
            status: "idle",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt: new Date(now().getTime()).toISOString(),
            consecutiveFailures: currentFailures,
            lastErrorCode: null,
          });
          continue;
        }

        const quota = await readQuota(supabase as SupabaseClient);
        const quotaNow = now().getTime();
        if (quota && isQuotaExhausted(quota, safeRemaining, quotaNow)) {
          summary.stoppedReason = "quota_exhausted";
          const nextEligibleAt = futureResetAt(quota.resetAt, quotaNow) || new Date(quotaNow).toISOString();
          summary.nextEligibleAt.push(nextEligibleAt);
          await settle({
            status: "idle",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: "quota_exhausted",
          });
          continue;
        }

        const playerResult = await fetchRecent(candidate, apiKey, fetchImpl);
        await recordRateLimit(summary, playerResult.rateLimitHeaders, "player", trackRateLimit);

        if (playerResult.status === 429) {
          summary.rateLimited = true;
          summary.stoppedReason = "rate_limited";
          currentFailures += 1;
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({
            status: "rate_limited",
            rateLimitResetAt: playerResult.rateLimitHeaders?.resetAt,
            retryAfterMs: playerResult.rateLimitHeaders?.retryAfterMs,
          }, now().getTime());
          summary.nextEligibleAt.push(nextEligibleAt);
          await settle({
            status: "rate_limited",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: "rate_limited",
          });
          continue;
        }

        if (playerResult.status === 404) {
          summary.invalidNicknames += 1;
          currentFailures += 1;
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "invalid_nickname" }, now().getTime());
          summary.nextEligibleAt.push(nextEligibleAt);
          await settle({
            status: "invalid_nickname",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: "player_not_found",
          });
          continue;
        }

        if (playerResult.status !== 200) {
          const status = playerResult.status > 0 ? "upstream_error" : "network_error";
          if (status === "network_error") summary.networkErrors += 1;
          else summary.upstreamErrors += 1;
          await settleFailed(candidate, settle, summary, now, currentFailures, status);
          continue;
        }

        const apiMatchIds = Array.from(new Set(playerResult.matchIds));
        const existingIds = await readExisting(supabase as SupabaseClient, candidate, apiMatchIds);
        const existing = new Set(existingIds);
        const missingIds = apiMatchIds.filter((matchId) => !existing.has(matchId)).slice(0, matchLimit);
        let failedOutcome: "upstream_error" | "network_error" | null = null;

        for (let index = 0; index < missingIds.length; index += 1) {
          const matchId = missingIds[index];
          let outcome: BasicMatchIngestOutcome;
          try {
            outcome = await ingest(supabase as SupabaseClient, matchId, candidate, apiKey, fetchImpl);
          } catch (error) {
            outcome = {
              status: "network_error",
              record: null,
              httpStatus: null,
              rateLimitHeaders: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          await recordRateLimit(summary, outcome.rateLimitHeaders, "match", trackRateLimit);

          if (outcome.status === "saved") summary.newMatches += 1;
          else if (outcome.status === "not_found") summary.notFoundMatches += 1;
          else if (outcome.status === "rate_limited") {
            summary.rateLimited = true;
            summary.stoppedReason = "rate_limited";
            currentFailures += 1;
            const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({
              status: "rate_limited",
              rateLimitResetAt: outcome.rateLimitHeaders?.resetAt,
              retryAfterMs: outcome.rateLimitHeaders?.retryAfterMs,
            }, now().getTime());
            summary.nextEligibleAt.push(nextEligibleAt);
            await settle({
              status: "rate_limited",
              lastSuccessAt: candidate.lastSuccessAt,
              nextEligibleAt,
              consecutiveFailures: currentFailures,
              lastErrorCode: "rate_limited",
            });
            break;
          } else {
            failedOutcome = outcome.status === "network_error" ? "network_error" : "upstream_error";
            if (failedOutcome === "network_error") summary.networkErrors += 1;
            else summary.upstreamErrors += 1;
            break;
          }

          if (index + 1 < missingIds.length) await sleep(matchDelayMs);
        }

        if (summary.stoppedReason === "rate_limited") continue;
        if (failedOutcome) {
          await settleFailed(candidate, settle, summary, now, currentFailures, failedOutcome);
          continue;
        }

        const successNow = now().getTime();
        const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "success" }, successNow);
        await settle({
          status: "success",
          lastSuccessAt: new Date(successNow).toISOString(),
          nextEligibleAt,
          consecutiveFailures: 0,
          lastErrorCode: null,
        });
        summary.syncedIdentities += 1;
        summary.nextEligibleAt.push(nextEligibleAt);
      } catch (error) {
        if (error instanceof SyncSettlementError || error instanceof SyncControlPlaneError) {
          await releaseLeaseBestEffort("completion_failed");
          throw error;
        }

        if (summary.stoppedReason === "rate_limited" || summary.stoppedReason === "quota_exhausted") {
          await releaseLeaseBestEffort(null);
          continue;
        }

        summary.networkErrors += 1;
        currentFailures += 1;
        try {
          await settleFailed(candidate, settle, summary, now, currentFailures - 1, "network_error");
        } catch (settlementError) {
          await releaseLeaseBestEffort("completion_failed");
          throw settlementError;
        }
      } finally {
        await releaseLeaseBestEffort("lease_expired");
      }
    }
  } finally {
    const finished = now();
    summary.finishedAt = finished.toISOString();
    summary.durationMs = Math.max(0, finished.getTime() - startedMs);
    (dependencies.writeOutput || writeSyncRunOutput)(summary);
  }

  return summary;
}

export async function main(options?: RunSyncUserMatchesOptions): Promise<SyncRunSummary> {
  if (options !== undefined) return runSyncUserMatches(options);
  const { limit } = parseSyncScriptArgs(process.argv.slice(2));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];

  if (!supabaseUrl || !serviceKey) throw new Error("Supabase credentials missing");
  if (!apiKey) throw new Error("PUBG_API_KEY missing");

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return runSyncUserMatches({
    limit,
    dependencies: { supabase, apiKey },
  });
}

const isDirectRun = process.argv[1]?.includes("sync_user_matches") === true;
if (isDirectRun) {
  main()
    .then((summary) => {
      console.log(JSON.stringify(summary));
    })
    .catch((error: unknown) => {
      console.error("❌ Error running sync_user_matches:", error);
      process.exit(1);
    });
}
