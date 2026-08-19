import { createClient } from "@supabase/supabase-js";
import {
  canonicalizeLinkedPlayerNickname,
  canonicalizeLinkedPlayerPlatform,
  type LinkedPlayerSyncPlatform,
  type LinkedPlayerSyncStatus,
} from "./linkedPlayerSync";

export type { LinkedPlayerSyncPlatform, LinkedPlayerSyncStatus } from "./linkedPlayerSync";

/**
 * The linked-player sync RPCs are deliberately kept behind a server-only
 * module. Callers may inject the already-created service client (which keeps
 * workers easy to test); production callers without one get a client built
 * only from the service-role environment variables.
 */

export type LinkedPlayerSyncCandidateRow = {
  platform: LinkedPlayerSyncPlatform;
  normalizedNickname: string;
  displayNickname: string;
  lastActiveAt: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
};

export type LinkedPlayerSyncRpcClient = {
  rpc(
    functionName: string,
    params: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

type DateInput = string | Date;

export type FetchLinkedPlayerSyncCandidatesOptions = {
  supabaseAdmin?: LinkedPlayerSyncRpcClient;
  limit?: number;
  activeSince?: DateInput;
};

export type ClaimLinkedPlayerSyncInput = {
  supabaseAdmin?: LinkedPlayerSyncRpcClient;
  platform: LinkedPlayerSyncPlatform | string;
  normalizedNickname: string;
  displayNickname: string;
  leaseToken: string;
  leaseExpiresAt: DateInput;
};

export type CompleteLinkedPlayerSyncInput = {
  supabaseAdmin?: LinkedPlayerSyncRpcClient;
  platform: LinkedPlayerSyncPlatform | string;
  normalizedNickname: string;
  leaseToken: string;
  status: LinkedPlayerSyncStatus | string;
  lastSuccessAt: DateInput | null;
  nextEligibleAt: DateInput | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
};

const MAX_CANDIDATE_LIMIT = 15;
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYNC_STATUSES = new Set<LinkedPlayerSyncStatus>([
  "idle",
  "running",
  "success",
  "failed",
  "invalid_nickname",
  "rate_limited",
]);

export function fetchLinkedPlayerSyncCandidates(
  options?: FetchLinkedPlayerSyncCandidatesOptions,
): Promise<LinkedPlayerSyncCandidateRow[]>;
export function fetchLinkedPlayerSyncCandidates(
  supabaseAdmin: LinkedPlayerSyncRpcClient,
  limit?: number,
  activeSince?: DateInput,
): Promise<LinkedPlayerSyncCandidateRow[]>;
export function fetchLinkedPlayerSyncCandidates(
  supabaseAdmin: LinkedPlayerSyncRpcClient,
  options?: Pick<FetchLinkedPlayerSyncCandidatesOptions, "limit" | "activeSince">,
): Promise<LinkedPlayerSyncCandidateRow[]>;
export async function fetchLinkedPlayerSyncCandidates(
  input?: LinkedPlayerSyncRpcClient | FetchLinkedPlayerSyncCandidatesOptions,
  limitOrOptions?: number | Pick<FetchLinkedPlayerSyncCandidatesOptions, "limit" | "activeSince">,
  activeSinceArgument?: DateInput,
): Promise<LinkedPlayerSyncCandidateRow[]> {
  const resolved = resolveFetchInput(input, limitOrOptions, activeSinceArgument);
  const result = await callRpc(
    resolved.supabaseAdmin,
    "list_pubg_linked_sync_candidates",
    {
      p_limit: resolved.limit,
      p_active_since: resolved.activeSince,
    },
    "linked-player-sync-list-failed",
  );

  if (!Array.isArray(result.data)) {
    throw new Error("linked-player-sync-invalid-candidate-result");
  }

  return result.data.map((row, index) => parseCandidateRow(row, index));
}

export function claimLinkedPlayerSync(
  input: ClaimLinkedPlayerSyncInput,
): Promise<boolean>;
export function claimLinkedPlayerSync(
  supabaseAdmin: LinkedPlayerSyncRpcClient,
  input: Omit<ClaimLinkedPlayerSyncInput, "supabaseAdmin">,
): Promise<boolean>;
export async function claimLinkedPlayerSync(
  inputOrClient: ClaimLinkedPlayerSyncInput | LinkedPlayerSyncRpcClient,
  inputArgument?: Omit<ClaimLinkedPlayerSyncInput, "supabaseAdmin">,
): Promise<boolean> {
  const input = resolveClaimInput(inputOrClient, inputArgument);
  const platform = parsePlatform(input.platform, "claim");
  const normalizedNickname = parseCanonicalNickname(input.normalizedNickname, "claim");
  const displayNickname = parseDisplayNickname(input.displayNickname, "claim");
  const leaseToken = parseUuid(input.leaseToken, "claim");
  const leaseExpiresAt = parseDateInput(input.leaseExpiresAt, "claim");

  const result = await callRpc(
    input.supabaseAdmin,
    "claim_pubg_linked_sync",
    {
      p_platform: platform,
      p_normalized_nickname: normalizedNickname,
      p_display_nickname: displayNickname,
      p_lease_token: leaseToken,
      p_lease_expires_at: leaseExpiresAt,
    },
    "linked-player-sync-claim-failed",
  );

  if (typeof result.data !== "boolean") {
    throw new Error("linked-player-sync-invalid-claim-result");
  }
  return result.data;
}

export function completeLinkedPlayerSync(
  input: CompleteLinkedPlayerSyncInput,
): Promise<boolean>;
export function completeLinkedPlayerSync(
  supabaseAdmin: LinkedPlayerSyncRpcClient,
  input: Omit<CompleteLinkedPlayerSyncInput, "supabaseAdmin">,
): Promise<boolean>;
export async function completeLinkedPlayerSync(
  inputOrClient: CompleteLinkedPlayerSyncInput | LinkedPlayerSyncRpcClient,
  inputArgument?: Omit<CompleteLinkedPlayerSyncInput, "supabaseAdmin">,
): Promise<boolean> {
  const input = resolveCompleteInput(inputOrClient, inputArgument);
  const platform = parsePlatform(input.platform, "complete");
  const normalizedNickname = parseCanonicalNickname(input.normalizedNickname, "complete");
  const leaseToken = parseUuid(input.leaseToken, "complete");
  const status = parseStatus(input.status);
  const lastSuccessAt = parseNullableDateInput(input.lastSuccessAt, "complete");
  const nextEligibleAt = parseNullableDateInput(input.nextEligibleAt, "complete");
  const consecutiveFailures = parseFailureCount(input.consecutiveFailures, "complete");
  const lastErrorCode = parseNullableString(input.lastErrorCode, "complete");

  const result = await callRpc(
    input.supabaseAdmin,
    "complete_pubg_linked_sync",
    {
      p_platform: platform,
      p_normalized_nickname: normalizedNickname,
      p_lease_token: leaseToken,
      p_status: status,
      p_last_success_at: lastSuccessAt,
      p_next_eligible_at: nextEligibleAt,
      p_consecutive_failures: consecutiveFailures,
      p_last_error_code: lastErrorCode,
    },
    "linked-player-sync-complete-failed",
  );

  if (typeof result.data !== "boolean") {
    throw new Error("linked-player-sync-invalid-complete-result");
  }
  return result.data;
}

function resolveFetchInput(
  input: LinkedPlayerSyncRpcClient | FetchLinkedPlayerSyncCandidatesOptions | undefined,
  limitOrOptions: number | Pick<FetchLinkedPlayerSyncCandidatesOptions, "limit" | "activeSince"> | undefined,
  activeSinceArgument: DateInput | undefined,
): { supabaseAdmin: LinkedPlayerSyncRpcClient; limit: number; activeSince: string } {
  const options = isRpcClient(input) ? undefined : input;
  const supabaseAdmin = isRpcClient(input) ? input : options?.supabaseAdmin;

  const positionalOptions = typeof limitOrOptions === "object" ? limitOrOptions : undefined;
  const requestedLimit = typeof limitOrOptions === "number"
    ? limitOrOptions
    : positionalOptions?.limit ?? options?.limit ?? MAX_CANDIDATE_LIMIT;
  const requestedActiveSince = activeSinceArgument
    ?? positionalOptions?.activeSince
    ?? options?.activeSince
    ?? new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();

  return {
    supabaseAdmin: supabaseAdmin ?? getServiceRoleClient(),
    limit: parseLimit(requestedLimit),
    activeSince: parseDateInput(requestedActiveSince, "list"),
  };
}

function resolveClaimInput(
  inputOrClient: ClaimLinkedPlayerSyncInput | LinkedPlayerSyncRpcClient,
  inputArgument: Omit<ClaimLinkedPlayerSyncInput, "supabaseAdmin"> | undefined,
): ClaimLinkedPlayerSyncInput & { supabaseAdmin: LinkedPlayerSyncRpcClient } {
  if (isRpcClient(inputOrClient)) {
    if (!inputArgument) throw new Error("linked-player-sync-claim-input-missing");
    return { ...inputArgument, supabaseAdmin: inputOrClient };
  }
  return {
    ...inputOrClient,
    supabaseAdmin: inputOrClient.supabaseAdmin ?? getServiceRoleClient(),
  };
}

function resolveCompleteInput(
  inputOrClient: CompleteLinkedPlayerSyncInput | LinkedPlayerSyncRpcClient,
  inputArgument: Omit<CompleteLinkedPlayerSyncInput, "supabaseAdmin"> | undefined,
): CompleteLinkedPlayerSyncInput & { supabaseAdmin: LinkedPlayerSyncRpcClient } {
  if (isRpcClient(inputOrClient)) {
    if (!inputArgument) throw new Error("linked-player-sync-complete-input-missing");
    return { ...inputArgument, supabaseAdmin: inputOrClient };
  }
  return {
    ...inputOrClient,
    supabaseAdmin: inputOrClient.supabaseAdmin ?? getServiceRoleClient(),
  };
}

function isRpcClient(value: unknown): value is LinkedPlayerSyncRpcClient {
  return isRecord(value) && typeof value.rpc === "function";
}

function getServiceRoleClient(): LinkedPlayerSyncRpcClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("linked-player-sync-service-role-credentials-missing");
  }

  // Legacy service-role keys are JWTs. If a JWT role is present, reject an
  // anon/authenticated key before it can ever reach a privileged RPC.
  const jwtRole = readJwtRole(key);
  if (jwtRole !== null && jwtRole !== "service_role") {
    throw new Error("linked-player-sync-service-role-required");
  }

  return createClient(url, key) as unknown as LinkedPlayerSyncRpcClient;
}

function readJwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload) || typeof payload.role !== "string") return null;
    return payload.role;
  } catch {
    return null;
  }
}

async function callRpc(
  supabaseAdmin: LinkedPlayerSyncRpcClient,
  functionName: string,
  params: Record<string, unknown>,
  failureCode: string,
): Promise<{ data: unknown; error: unknown }> {
  try {
    const result = await supabaseAdmin.rpc(functionName, params);
    if (result.error) throw result.error;
    return result;
  } catch (error) {
    throw new Error(failureCode, { cause: error });
  }
}

function parseCandidateRow(value: unknown, index: number): LinkedPlayerSyncCandidateRow {
  if (!isRecord(value)) throw new Error(`linked-player-sync-invalid-candidate-row:${index}`);
  try {
    const platform = parsePlatform(value.platform, "candidate");
    const normalizedNickname = parseCanonicalNickname(value.normalized_nickname, "candidate");
    const displayNickname = parseDisplayNickname(value.display_nickname, "candidate");
    const lastActiveAt = parseDateInput(value.last_active_at, "candidate");
    const lastSuccessAt = parseNullableDateInput(value.last_success_at, "candidate");
    const consecutiveFailures = parseFailureCount(value.consecutive_failures, "candidate");

    return {
      platform,
      normalizedNickname,
      displayNickname,
      lastActiveAt,
      lastSuccessAt,
      consecutiveFailures,
    };
  } catch (error) {
    throw new Error(`linked-player-sync-invalid-candidate-row:${index}`, { cause: error });
  }
}

function parsePlatform(value: unknown, context: string): LinkedPlayerSyncPlatform {
  if (typeof value !== "string") throw new Error(`linked-player-sync-invalid-${context}-platform`);
  try {
    return canonicalizeLinkedPlayerPlatform(value);
  } catch {
    throw new Error(`linked-player-sync-invalid-${context}-platform`);
  }
}

function parseCanonicalNickname(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`linked-player-sync-invalid-${context}-nickname`);
  try {
    return canonicalizeLinkedPlayerNickname(value);
  } catch {
    throw new Error(`linked-player-sync-invalid-${context}-nickname`);
  }
}

function parseDisplayNickname(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`linked-player-sync-invalid-${context}-display-nickname`);
  }
  return value.trim();
}

function parseUuid(value: unknown, context: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`linked-player-sync-invalid-${context}-lease-token`);
  }
  return value;
}

function parseStatus(value: unknown): LinkedPlayerSyncStatus {
  if (typeof value !== "string" || !SYNC_STATUSES.has(value as LinkedPlayerSyncStatus)) {
    throw new Error("linked-player-sync-invalid-complete-status");
  }
  return value as LinkedPlayerSyncStatus;
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CANDIDATE_LIMIT) {
    throw new Error("linked-player-sync-invalid-list-limit");
  }
  return value;
}

function parseFailureCount(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`linked-player-sync-invalid-${context}-failure-count`);
  }
  return value;
}

function parseDateInput(value: unknown, context: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`linked-player-sync-invalid-${context}-date`);
    return value.toISOString();
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`linked-player-sync-invalid-${context}-date`);
  }
  return value;
}

function parseNullableDateInput(value: unknown, context: string): string | null {
  if (value === null) return null;
  return parseDateInput(value, context);
}

function parseNullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`linked-player-sync-invalid-${context}-error-code`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
