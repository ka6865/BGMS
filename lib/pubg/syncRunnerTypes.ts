import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BasicMatchIngestOutcome,
  PubgFetchImpl,
  PubgRateLimitHeaderSnapshot,
} from "./playerMatchesIngest";
import type { SyncCandidateUser } from "./userSyncHelper";
import type { LinkedPlayerSyncRpcClient } from "./linkedPlayerSync.server";

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
