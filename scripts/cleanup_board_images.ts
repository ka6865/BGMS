import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BOARD_IMAGE_BUCKET, isUuid } from "../lib/board/imageStorageContract";

export const BOARD_IMAGE_CLEANUP_BATCH_LIMIT = 20;
export const BOARD_IMAGE_CLEANUP_MAX_BATCHES = 5;
export const BOARD_IMAGE_CLEANUP_MAX_DURATION_MS = 30_000;
export const BOARD_IMAGE_DELETION_LEASE_SECONDS = 300;

type BoardImageCleanupClient = Pick<SupabaseClient, "rpc" | "storage">;

type CleanupDependencies = {
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  createServiceClient?: (url: string, serviceRoleKey: string) => SupabaseClient;
  now?: () => Date;
  nowMs?: () => number;
  write?: (message: string) => void;
};

type BoardImageClaim = {
  image_id: string;
  bucket_id: string;
  storage_key: string;
  lease_token: string;
};

export type BoardImageCleanupResult = {
  batches: number;
  claimed: number;
  finalized: number;
  deferred: number;
  hasRemaining: boolean;
};

const BOARD_IMAGE_CLEANUP_AUDIT_STATUSES = ["pending", "ready", "delete_pending", "deleting"] as const;

type BoardImageCleanupAuditStatus = typeof BOARD_IMAGE_CLEANUP_AUDIT_STATUSES[number];

export type BoardImageCleanupAuditResult = {
  candidates: number;
  byStatus: Record<BoardImageCleanupAuditStatus, number>;
};

export type BoardImageCleanupMode = "apply" | "dry-run";

type BoardImageCleanupAuditRow = {
  candidate_status: BoardImageCleanupAuditStatus;
  candidate_count: number;
};

function isClaim(value: unknown): value is BoardImageClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return isUuid(claim.image_id)
    && claim.bucket_id === BOARD_IMAGE_BUCKET
    && claim.storage_key === claim.image_id
    && isUuid(claim.lease_token);
}

function isValidClaimBatch(data: unknown[]): data is BoardImageClaim[] {
  const imageIds = new Set<string>();
  return data.every((claim) => {
    if (!isClaim(claim) || imageIds.has(claim.image_id)) return false;
    imageIds.add(claim.image_id);
    return true;
  });
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.statusCode === 404 || value.statusCode === "404" || value.status === 404;
}

export function resolveBoardImageCleanupMode(args: string[]): BoardImageCleanupMode {
  if (args.length === 0) return "apply";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  throw new Error("board-image-cleanup-invalid-arguments");
}

function isAuditRow(value: unknown): value is BoardImageCleanupAuditRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.candidate_status === "string"
    && BOARD_IMAGE_CLEANUP_AUDIT_STATUSES.includes(row.candidate_status as BoardImageCleanupAuditStatus)
    && typeof row.candidate_count === "number"
    && Number.isSafeInteger(row.candidate_count)
    && row.candidate_count >= 0;
}

export async function auditBoardImageCleanup(
  supabaseAdmin: Pick<BoardImageCleanupClient, "rpc">,
  dependencies: Pick<CleanupDependencies, "now" | "write"> = {},
): Promise<BoardImageCleanupAuditResult> {
  const now = dependencies.now ?? (() => new Date());
  const auditNow = now();
  if (!Number.isFinite(auditNow.getTime())) throw new Error("board-image-cleanup-audit-failed");
  const { data, error } = await supabaseAdmin.rpc("inspect_board_image_deletion_candidates", {
    p_now: auditNow.toISOString(),
  });
  if (error || !Array.isArray(data) || data.length > BOARD_IMAGE_CLEANUP_AUDIT_STATUSES.length) {
    throw new Error("board-image-cleanup-audit-failed");
  }

  const byStatus: Record<BoardImageCleanupAuditStatus, number> = {
    pending: 0,
    ready: 0,
    delete_pending: 0,
    deleting: 0,
  };
  const seenStatuses = new Set<BoardImageCleanupAuditStatus>();
  for (const row of data) {
    if (!isAuditRow(row) || seenStatuses.has(row.candidate_status)) {
      throw new Error("board-image-cleanup-audit-failed");
    }
    seenStatuses.add(row.candidate_status);
    byStatus[row.candidate_status] = row.candidate_count;
  }
  const candidates = Object.values(byStatus).reduce((total, count) => total + count, 0);
  if (!Number.isSafeInteger(candidates)) throw new Error("board-image-cleanup-audit-failed");
  dependencies.write?.(
    `board-image-cleanup dry-run candidates=${candidates} pending=${byStatus.pending} ready=${byStatus.ready} delete_pending=${byStatus.delete_pending} deleting=${byStatus.deleting}`,
  );
  return {
    candidates,
    byStatus,
  };
}

export async function cleanupBoardImages(
  supabaseAdmin: BoardImageCleanupClient,
  dependencies: Pick<CleanupDependencies, "now" | "nowMs" | "write"> = {},
): Promise<BoardImageCleanupResult> {
  const now = dependencies.now ?? (() => new Date());
  const nowMs = dependencies.nowMs ?? Date.now;
  const startedAt = nowMs();
  let batches = 0;
  let claimed = 0;
  let finalized = 0;
  let deferred = 0;
  let hasRemaining = false;

  while (
    batches < BOARD_IMAGE_CLEANUP_MAX_BATCHES
    && nowMs() - startedAt < BOARD_IMAGE_CLEANUP_MAX_DURATION_MS
  ) {
    const claimNow = now();
    if (!Number.isFinite(claimNow.getTime())) throw new Error("board-image-cleanup-invalid-now");
    const { data, error } = await supabaseAdmin.rpc("claim_board_image_deletions", {
      p_limit: BOARD_IMAGE_CLEANUP_BATCH_LIMIT,
      p_now: claimNow.toISOString(),
      p_lease_seconds: BOARD_IMAGE_DELETION_LEASE_SECONDS,
    });
    if (error || !Array.isArray(data) || data.length > BOARD_IMAGE_CLEANUP_BATCH_LIMIT || !isValidClaimBatch(data)) {
      throw new Error("board-image-cleanup-claim-failed");
    }
    if (data.length === 0) break;

    batches += 1;
    claimed += data.length;
    for (const claim of data) {
      let deleted = false;
      try {
        const { error: removeError } = await supabaseAdmin.storage.from(claim.bucket_id).remove([claim.storage_key]);
        deleted = !removeError || isNotFound(removeError);
      } catch {
        deleted = false;
      }
      const { data: finalizedData, error: finalizeError } = await supabaseAdmin.rpc("finalize_board_image_deletion", {
        p_image_id: claim.image_id,
        p_lease_token: claim.lease_token,
        p_deleted: deleted,
      });
      if (finalizeError || finalizedData !== true) throw new Error("board-image-cleanup-finalize-failed");
      finalized += 1;
      if (!deleted) deferred += 1;
    }
    hasRemaining = data.length === BOARD_IMAGE_CLEANUP_BATCH_LIMIT;
    if (!hasRemaining) break;
  }

  dependencies.write?.(`board-image-cleanup batches=${batches} claimed=${claimed} finalized=${finalized} deferred=${deferred} backlog=${hasRemaining}`);
  return { batches, claimed, finalized, deferred, hasRemaining };
}

export async function runBoardImageCleanup(
  dependencies: CleanupDependencies = {},
): Promise<BoardImageCleanupResult | BoardImageCleanupAuditResult> {
  const env = dependencies.env ?? process.env;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) throw new Error("board-image-cleanup-credentials-missing");
  const createServiceClient = dependencies.createServiceClient ?? ((url, key) => createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  }));
  const supabaseAdmin = createServiceClient(supabaseUrl, serviceRoleKey);
  if (dependencies.dryRun) return auditBoardImageCleanup(supabaseAdmin, dependencies);
  return cleanupBoardImages(supabaseAdmin, dependencies);
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const runFromCli = async () => {
    const mode = resolveBoardImageCleanupMode(process.argv.slice(2));
    return runBoardImageCleanup({
      dryRun: mode === "dry-run",
      write: (message) => process.stdout.write(`${message}\n`),
    });
  };

  runFromCli()
    .catch((error: unknown) => {
      // 원인 없이 메시지만 남기면 운영에서 실패 이유를 추적할 수 없다.
      const detail = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      process.stderr.write(`Board image cleanup failed: ${detail}\n`);
      process.exitCode = 1;
    });
}
