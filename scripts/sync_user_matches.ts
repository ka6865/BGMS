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
  readPubgRateLimitHeaders,
  type BasicMatchIngestOutcome,
  type PubgFetchImpl,
  type PubgRateLimitHeaderSnapshot,
} from "../lib/pubg/playerMatchesIngest";
import { claimForceRefresh } from "../lib/pubg/responseCache";

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
  candidates: number;
  candidateCount: number;
  claimed: number;
  claimedCount: number;
  syncedIdentities: number;
  successfulUsers: number;
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
};

export type SyncRunnerDependencies = {
  supabase?: SupabaseClient;
  apiKey?: string;
  fetchCandidates?: (supabase: SupabaseClient, limit: number) => Promise<SyncCandidateUser[]>;
  listCandidates?: (supabase: SupabaseClient, limit: number) => Promise<SyncCandidateUser[]>;
  claimSyncLease?: (input: {
    supabaseAdmin?: LinkedPlayerSyncRpcClient;
    platform: string;
    normalizedNickname: string;
    displayNickname: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }) => Promise<boolean>;
  claimLease?: SyncRunnerDependencies["claimSyncLease"];
  claimRefreshLock?: (lockKey: string) => Promise<boolean>;
  claimPlayerLock?: (lockKey: string) => Promise<boolean>;
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
  completeState?: SyncRunnerDependencies["completeSync"];
  readQuota?: (supabase: SupabaseClient) => Promise<SyncQuotaStatus | null>;
  getQuota?: (supabase: SupabaseClient) => Promise<SyncQuotaStatus | null>;
  fetchRecentMatchIds?: (
    candidate: SyncCandidateUser,
    apiKey: string,
    fetchImpl: PubgFetchImpl,
  ) => Promise<FetchRecentMatchIdsResult>;
  fetchPlayerRecentMatchIds?: SyncRunnerDependencies["fetchRecentMatchIds"];
  readExistingMatchIds?: (
    supabase: SupabaseClient,
    candidate: SyncCandidateUser,
    matchIds: string[],
  ) => Promise<string[]>;
  findExistingMatchIds?: SyncRunnerDependencies["readExistingMatchIds"];
  ingestMatch?: (
    supabase: SupabaseClient,
    matchId: string,
    candidate: SyncCandidateUser,
    apiKey: string,
    fetchImpl: PubgFetchImpl,
  ) => Promise<BasicMatchIngestOutcome>;
  ingestBasicMatch?: SyncRunnerDependencies["ingestMatch"];
  fetchImpl?: PubgFetchImpl;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  createLeaseToken?: () => string;
  writeOutput?: (summary: SyncRunSummary) => void;
  trackRateLimit?: (
    headers: PubgRateLimitHeaderSnapshot,
    source: "player" | "match",
  ) => void;
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

/**
 * Run one linked-player sync pass. Every external boundary is injectable so
 * tests can exercise the state machine without a remote database or PUBG API.
 */
export async function runSyncUserMatches(
  options: RunSyncUserMatchesOptions = {},
): Promise<SyncRunSummary> {
  const dependencies: SyncRunnerDependencies = {
    ...options,
    ...(options.dependencies || {}),
  };
  const supabase = dependencies.supabase;
  const apiKey = dependencies.apiKey || "";
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
    candidates: 0,
    candidateCount: 0,
    claimed: 0,
    claimedCount: 0,
    syncedIdentities: 0,
    successfulUsers: 0,
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
  };

  const fetchCandidates = dependencies.fetchCandidates || dependencies.listCandidates || ((client, candidateLimit) => (
    fetchSyncCandidateUsers(client, candidateLimit)
  ));
  const claimLease = dependencies.claimSyncLease || dependencies.claimLease || ((input) => claimLinkedPlayerSync(input));
  const claimLock = dependencies.claimRefreshLock || dependencies.claimPlayerLock || ((lockKey) => claimForceRefresh(lockKey));
  const complete = dependencies.completeSync || dependencies.completeState || ((input) => completeLinkedPlayerSync(input));
  const readQuota = dependencies.readQuota || dependencies.getQuota || (
    supabase ? readLatestQuota : async () => null
  );
  const fetchRecent = dependencies.fetchRecentMatchIds || dependencies.fetchPlayerRecentMatchIds || ((candidate, key, impl) => (
    fetchRecentMatchIds(candidate, key, impl, playerTimeoutMs)
  ));
  const readExisting = dependencies.readExistingMatchIds || dependencies.findExistingMatchIds || (
    supabase ? readExistingMatchIds : async () => []
  );
  const ingest = dependencies.ingestMatch || dependencies.ingestBasicMatch || ((client, matchId, candidate, key, impl) => (
    fetchAndIngestBasicMatchSummaryOutcome(
      client,
      matchId,
      candidate.displayNickname,
      candidate.platform,
      key,
      { fetchImpl: impl },
    )
  ));

  const hasInjectedCandidateBoundary = Boolean(dependencies.fetchCandidates || dependencies.listCandidates);
  const hasInjectedLeaseBoundary = Boolean(dependencies.claimSyncLease || dependencies.claimLease);
  const hasInjectedCompletionBoundary = Boolean(dependencies.completeSync || dependencies.completeState);
  const hasInjectedFetchBoundary = Boolean(dependencies.fetchRecentMatchIds || dependencies.fetchPlayerRecentMatchIds);
  const hasInjectedIngestBoundary = Boolean(dependencies.ingestMatch || dependencies.ingestBasicMatch);
  if (!supabase && (!hasInjectedCandidateBoundary || !hasInjectedLeaseBoundary || !hasInjectedCompletionBoundary)) {
    throw new Error("sync-user-matches-supabase-missing");
  }
  if (!apiKey && !hasInjectedFetchBoundary && !hasInjectedIngestBoundary) {
    throw new Error("PUBG_API_KEY missing");
  }

  try {
    const candidates = await fetchCandidates(supabase as SupabaseClient, limit);
    summary.candidates = candidates.length;
    summary.candidateCount = candidates.length;

    for (const candidate of candidates) {
      if (summary.stoppedReason) break;

      const leaseToken = createLeaseToken();
      const leaseExpiresAt = new Date(startedMs + leaseDurationMs).toISOString();
      let ownsLease = false;
      let leaseSettled = false;
      let lockCollision = false;
      let currentFailures = Math.max(0, candidate.consecutiveFailures || 0);

      const completeState = async (input: {
        status: "idle" | "success" | "failed" | "invalid_nickname" | "rate_limited";
        lastSuccessAt: string | null;
        nextEligibleAt: string | null;
        consecutiveFailures: number;
        lastErrorCode: string | null;
      }): Promise<boolean> => {
        const result = await complete({
          supabaseAdmin: supabase as unknown as LinkedPlayerSyncRpcClient,
          platform: candidate.platform,
          normalizedNickname: candidate.normalizedNickname,
          leaseToken,
          ...input,
        });
        // A resolved completion call has handed the lease back to the state
        // boundary, even when a test double omits its boolean return. Only an
        // exception means we still need the defensive idle-expiry attempt.
        leaseSettled = true;
        return result === true;
      };

      try {
        const claimed = await claimLease({
          supabaseAdmin: supabase as unknown as LinkedPlayerSyncRpcClient,
          platform: candidate.platform,
          normalizedNickname: candidate.normalizedNickname,
          displayNickname: candidate.displayNickname,
          leaseToken,
          leaseExpiresAt,
        });
        if (!claimed) continue;
        ownsLease = true;
        summary.claimed += 1;
        summary.claimedCount = summary.claimed;

        const lockKey = buildPlayerRefreshLockKey(candidate.platform, candidate.normalizedNickname);
        const locked = await claimLock(lockKey);
        if (!locked) {
          lockCollision = true;
          summary.lockCollisions += 1;
          // We own the linked-sync lease, so clear it as idle. This is not a
          // failed refresh and must not advance transient failure backoff.
          await completeState({
            status: "idle",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt: new Date(startedMs).toISOString(),
            consecutiveFailures: currentFailures,
            lastErrorCode: null,
          });
          continue;
        }

        const quota = await readQuota(supabase as SupabaseClient);
        if (quota && quota.remaining <= safeRemaining) {
          summary.stoppedReason = "quota_exhausted";
          await completeState({
            status: "idle",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt: new Date(startedMs).toISOString(),
            consecutiveFailures: currentFailures,
            lastErrorCode: "quota_exhausted",
          });
          continue;
        }

        const playerResult = await fetchRecent(candidate, apiKey, fetchImpl);
        recordRateLimit(summary, playerResult.rateLimitHeaders, "player", dependencies.trackRateLimit);

        if (playerResult.status === 429) {
          summary.rateLimited = true;
          summary.stoppedReason = "rate_limited";
          currentFailures += 1;
          const outcome = {
            status: "rate_limited" as const,
            consecutiveFailures: currentFailures,
            rateLimitResetAt: playerResult.rateLimitHeaders?.resetAt,
            retryAfterMs: playerResult.rateLimitHeaders?.retryAfterMs,
          };
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt(outcome, startedMs);
          summary.nextEligibleAt.push(nextEligibleAt);
          await completeState({
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
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "invalid_nickname" }, startedMs);
          summary.nextEligibleAt.push(nextEligibleAt);
          await completeState({
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
          currentFailures += 1;
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({
            status: "failed",
            consecutiveFailures: currentFailures,
          }, startedMs);
          summary.nextEligibleAt.push(nextEligibleAt);
          await completeState({
            status: "failed",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: status,
          });
          continue;
        }

        const apiMatchIds = Array.from(new Set(playerResult.matchIds));
        if (apiMatchIds.length === 0) {
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "success" }, startedMs);
          summary.syncedIdentities += 1;
          summary.successfulUsers = summary.syncedIdentities;
          summary.nextEligibleAt.push(nextEligibleAt);
          await completeState({
            status: "success",
            lastSuccessAt: new Date(startedMs).toISOString(),
            nextEligibleAt,
            consecutiveFailures: 0,
            lastErrorCode: null,
          });
          continue;
        }

        let existingIds: string[];
        try {
          existingIds = await readExisting(supabase as SupabaseClient, candidate, apiMatchIds);
        } catch {
          summary.upstreamErrors += 1;
          currentFailures += 1;
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "failed", consecutiveFailures: currentFailures }, startedMs);
          summary.nextEligibleAt.push(nextEligibleAt);
          await completeState({
            status: "failed",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: "database_error",
          });
          continue;
        }

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
          recordRateLimit(summary, outcome.rateLimitHeaders, "match", dependencies.trackRateLimit);

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
            }, startedMs);
            summary.nextEligibleAt.push(nextEligibleAt);
            await completeState({
              status: "rate_limited",
              lastSuccessAt: candidate.lastSuccessAt,
              nextEligibleAt,
              consecutiveFailures: currentFailures,
              lastErrorCode: "rate_limited",
            });
            break;
          } else {
            failedOutcome = outcome.status;
            if (outcome.status === "network_error") summary.networkErrors += 1;
            else summary.upstreamErrors += 1;
            break;
          }

          if (index + 1 < missingIds.length) await sleep(matchDelayMs);
        }

        if (summary.stoppedReason === "rate_limited") continue;
        if (failedOutcome) {
          currentFailures += 1;
          const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({
            status: "failed",
            consecutiveFailures: currentFailures,
          }, startedMs);
          summary.nextEligibleAt.push(nextEligibleAt);
          await completeState({
            status: "failed",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: failedOutcome,
          });
          continue;
        }

        const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "success" }, startedMs);
        summary.syncedIdentities += 1;
        summary.successfulUsers = summary.syncedIdentities;
        summary.nextEligibleAt.push(nextEligibleAt);
        await completeState({
          status: "success",
          lastSuccessAt: new Date(startedMs).toISOString(),
          nextEligibleAt,
          consecutiveFailures: 0,
          lastErrorCode: null,
        });
      } catch {
        if (!ownsLease) continue;
        if (lockCollision || summary.stoppedReason === "rate_limited" || summary.stoppedReason === "quota_exhausted") {
          if (!leaseSettled) {
            try {
              await completeState({
                status: "idle",
                lastSuccessAt: candidate.lastSuccessAt,
                nextEligibleAt: new Date(startedMs).toISOString(),
                consecutiveFailures: currentFailures,
                lastErrorCode: null,
              });
            } catch {
              // A lease with an expired timestamp is safe to reclaim later.
            }
          }
          continue;
        }
        summary.networkErrors += 1;
        currentFailures += 1;
        const nextEligibleAt = getLinkedPlayerSyncNextEligibleAt({ status: "failed", consecutiveFailures: currentFailures }, startedMs);
        summary.nextEligibleAt.push(nextEligibleAt);
        try {
          await completeState({
            status: "failed",
            lastSuccessAt: candidate.lastSuccessAt,
            nextEligibleAt,
            consecutiveFailures: currentFailures,
            lastErrorCode: "network_error",
          });
        } catch {
          // The finally block below still attempts an idle lease release.
        }
      } finally {
        if (ownsLease && !leaseSettled) {
          try {
            await completeState({
              status: "idle",
              lastSuccessAt: candidate.lastSuccessAt,
              nextEligibleAt: new Date(startedMs).toISOString(),
              consecutiveFailures: currentFailures,
              lastErrorCode: "lease_expired",
            });
          } catch {
            // A subsequent scheduled run can reclaim the expired lease.
          }
        }
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

// Short alias for callers that use the runner name from the workflow brief.
export const runSync = runSyncUserMatches;

export async function main(options?: RunSyncUserMatchesOptions): Promise<SyncRunSummary> {
  if (options && (options.dependencies || options.supabase || options.fetchCandidates || options.listCandidates)) {
    return runSyncUserMatches(options);
  }
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

async function fetchRecentMatchIds(
  candidate: SyncCandidateUser,
  apiKey: string,
  fetchImpl: PubgFetchImpl,
  timeoutMs: number,
): Promise<FetchRecentMatchIdsResult> {
  try {
    const response = await fetchImpl(
      `https://api.pubg.com/shards/${candidate.platform}/players?filter[playerNames]=${encodeURIComponent(candidate.displayNickname)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
      },
    );
    const rateLimitHeaders = readPubgRateLimitHeaders(response.headers);
    if (!response.ok) {
      return { status: response.status, matchIds: [], rateLimitHeaders };
    }
    let data: any;
    try {
      data = await response.json();
    } catch (error) {
      return {
        status: 500,
        matchIds: [],
        rateLimitHeaders,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const player = data?.data?.[0];
    if (!player) return { status: 404, matchIds: [], rateLimitHeaders };
    const matchIds = (player.relationships?.matches?.data || [])
      .map((match: any) => String(match.id || ""))
      .filter(Boolean);
    return { status: 200, matchIds, rateLimitHeaders };
  } catch (error) {
    return {
      status: 0,
      matchIds: [],
      rateLimitHeaders: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readExistingMatchIds(
  supabase: SupabaseClient,
  candidate: SyncCandidateUser,
  matchIds: string[],
): Promise<string[]> {
  if (matchIds.length === 0) return [];
  const { data, error } = await supabase
    .from("pubg_player_matches")
    .select("match_id")
    .eq("player_id", candidate.normalizedNickname)
    .eq("platform", candidate.platform)
    .in("match_id", matchIds);
  if (error) throw error;
  return (data || [])
    .map((row: { match_id?: unknown }) => String(row.match_id || ""))
    .filter(Boolean);
}

async function readLatestQuota(supabase: SupabaseClient): Promise<SyncQuotaStatus | null> {
  const { data, error } = await supabase
    .from("pubg_api_status")
    .select("remaining, reset_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const remaining = Number(data.remaining);
  if (!Number.isFinite(remaining)) return null;
  return {
    remaining,
    resetAt: typeof data.reset_at === "string" ? data.reset_at : null,
  };
}

function recordRateLimit(
  summary: SyncRunSummary,
  headers: PubgRateLimitHeaderSnapshot | null,
  source: "player" | "match",
  tracker?: SyncRunnerDependencies["trackRateLimit"],
): void {
  if (!headers) return;
  if (source === "player") summary.playerRateLimitHeaders.push(headers);
  else summary.matchRateLimitHeaders.push(headers);
  tracker?.(headers, source);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
