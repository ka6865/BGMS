import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const BOARD_WRITE_QUOTA_RETENTION_HOURS = 24;
export const BOARD_WRITE_QUOTA_CLEANUP_MAX_ROWS = 1000;
export const BOARD_WRITE_QUOTA_CLEANUP_MAX_BATCHES = 5;
export const BOARD_WRITE_QUOTA_CLEANUP_MAX_DURATION_MS = 30_000;

type BoardWriteQuotaRpcClient = Pick<SupabaseClient, "rpc">;

type CleanupEnvironment = Record<string, string | undefined>;

type CleanupDependencies = {
  env?: CleanupEnvironment;
  createServiceClient?: (url: string, serviceRoleKey: string) => SupabaseClient;
  now?: () => Date;
};

export type BoardWriteQuotaCleanupResult = {
  cutoff: string;
  deletedRows: number;
  maxRows: number;
  batches: number;
  hasRemaining: boolean;
};

export async function cleanupBoardWriteRateLimits(
  supabaseAdmin: BoardWriteQuotaRpcClient,
  now = new Date(),
): Promise<BoardWriteQuotaCleanupResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("board-write-quota-cleanup-invalid-now");
  }

  const cutoff = new Date(
    now.getTime() - BOARD_WRITE_QUOTA_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const startedAt = Date.now();
  let deletedRows = 0;
  let batches = 0;
  let hasRemaining = false;

  while (
    batches < BOARD_WRITE_QUOTA_CLEANUP_MAX_BATCHES
    && Date.now() - startedAt < BOARD_WRITE_QUOTA_CLEANUP_MAX_DURATION_MS
  ) {
    const { data, error } = await supabaseAdmin.rpc(
      "cleanup_board_write_rate_limits",
      {
        p_cutoff: cutoff,
        p_max_rows: BOARD_WRITE_QUOTA_CLEANUP_MAX_ROWS,
      },
    );

    if (
      error
      || typeof data !== "number"
      || !Number.isInteger(data)
      || data < 0
      || data > BOARD_WRITE_QUOTA_CLEANUP_MAX_ROWS
    ) {
      throw new Error("board-write-quota-cleanup-rpc-failed");
    }

    deletedRows += data;
    batches += 1;
    if (data < BOARD_WRITE_QUOTA_CLEANUP_MAX_ROWS) {
      hasRemaining = false;
      break;
    }
    hasRemaining = true;
  }

  return {
    cutoff,
    deletedRows,
    maxRows: BOARD_WRITE_QUOTA_CLEANUP_MAX_ROWS,
    batches,
    hasRemaining,
  };
}

export async function runBoardWriteQuotaCleanup(
  dependencies: CleanupDependencies = {},
): Promise<BoardWriteQuotaCleanupResult> {
  const env = dependencies.env ?? process.env;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("board-write-quota-cleanup-credentials-missing");
  }

  const createServiceClient = dependencies.createServiceClient ?? ((url, key) => (
    createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  ));
  const supabaseAdmin = createServiceClient(supabaseUrl, serviceRoleKey);

  return cleanupBoardWriteRateLimits(
    supabaseAdmin,
    dependencies.now?.() ?? new Date(),
  );
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  runBoardWriteQuotaCleanup()
    .then((result) => {
      console.info(`Board write quota cleanup deleted ${result.deletedRows} rows in ${result.batches} batches; backlog=${result.hasRemaining}.`);
    })
    .catch((error: unknown) => {
      // 원인 없이 메시지만 남기면 운영에서 실패 이유를 추적할 수 없다.
      const detail = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`Board write quota cleanup failed: ${detail}`);
      process.exitCode = 1;
    });
}
