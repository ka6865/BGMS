/**
 * match_stats_raw에서 분석 대상 표본도 승자도 아닌 기존 행을 정리합니다.
 * 기본 실행은 dry-run이며 --apply를 지정해야 실제 삭제합니다.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

export const MATCH_STATS_RAW_BATCH_LIMIT = 5_000;
export const MATCH_STATS_RAW_MIN_BATCH_LIMIT = 100;
export const MATCH_STATS_RAW_MAX_BATCHES = 100;

type CompactionRpcResult = {
  candidate_count: number;
  deleted_count: number;
  remaining_count: number;
  dry_run: boolean;
};

export type MatchStatsRawCompactionResult = {
  candidateCount: number;
  deletedCount: number;
  remainingCount: number;
  dryRun: boolean;
  hasRemaining: boolean;
};

type RpcClient = Pick<SupabaseClient, "rpc">;

function parseRpcResult(value: unknown): CompactionRpcResult {
  if (!value || typeof value !== "object") {
    throw new Error("match-stats-raw-cleanup-invalid-rpc-result");
  }

  const result = value as Partial<CompactionRpcResult>;
  for (const field of ["candidate_count", "deleted_count", "remaining_count"] as const) {
    if (!Number.isInteger(result[field]) || Number(result[field]) < 0) {
      throw new Error("match-stats-raw-cleanup-invalid-rpc-result");
    }
  }
  if (typeof result.dry_run !== "boolean") {
    throw new Error("match-stats-raw-cleanup-invalid-rpc-result");
  }

  return result as CompactionRpcResult;
}

async function callCompactionRpc(
  supabase: RpcClient,
  apply: boolean,
  batchLimit: number,
): Promise<CompactionRpcResult> {
  const { data, error } = await supabase.rpc("compact_match_stats_raw", {
    p_apply: apply,
    p_batch_limit: batchLimit,
  });
  if (error) {
    throw new Error(`match_stats_raw 정리 RPC 실패: ${error.message}`);
  }
  return parseRpcResult(data);
}

export async function compactMatchStatsRaw(
  supabase: RpcClient,
  options: {
    apply?: boolean;
    batchLimit?: number;
    maxBatches?: number;
    write?: (message: string) => void;
  } = {},
): Promise<MatchStatsRawCompactionResult> {
  const batchLimit = options.batchLimit ?? MATCH_STATS_RAW_BATCH_LIMIT;
  const maxBatches = options.maxBatches ?? MATCH_STATS_RAW_MAX_BATCHES;
  const write = options.write ?? ((message: string) => console.info(message));

  if (
    !Number.isInteger(batchLimit)
    || batchLimit < MATCH_STATS_RAW_MIN_BATCH_LIMIT
    || batchLimit > MATCH_STATS_RAW_BATCH_LIMIT
  ) {
    throw new Error("match-stats-raw-cleanup-invalid-batch-limit");
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error("match-stats-raw-cleanup-invalid-max-batches");
  }

  const preview = await callCompactionRpc(supabase, false, batchLimit);
  write(`정리 대상: ${preview.candidate_count.toLocaleString()}행`);

  if (options.apply !== true) {
    write("dry-run 이므로 삭제하지 않았습니다. 실제 삭제는 --apply를 사용하세요.");
    return {
      candidateCount: preview.candidate_count,
      deletedCount: 0,
      remainingCount: preview.remaining_count,
      dryRun: true,
      hasRemaining: preview.remaining_count > 0,
    };
  }

  let deletedCount = 0;
  let remainingCount = preview.remaining_count;
  for (let batch = 0; batch < maxBatches && remainingCount > 0; batch += 1) {
    const result = await callCompactionRpc(supabase, true, batchLimit);
    deletedCount += result.deleted_count;
    remainingCount = result.remaining_count;
    if (result.deleted_count === 0) break;
  }

  write(`삭제 완료: ${deletedCount.toLocaleString()}행`);
  if (remainingCount > 0) {
    write(`남은 대상: ${remainingCount.toLocaleString()}행`);
  } else {
    write("물리 용량 회수는 유지보수 시간에 VACUUM (FULL, ANALYZE) public.match_stats_raw; 을 별도로 실행하세요.");
  }

  return {
    candidateCount: preview.candidate_count,
    deletedCount,
    remainingCount,
    dryRun: false,
    hasRemaining: remainingCount > 0,
  };
}

async function runFromEnvironment(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("match-stats-raw-cleanup-credentials-missing");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await compactMatchStatsRaw(supabase, { apply: process.argv.includes("--apply") });
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runFromEnvironment().catch((error: unknown) => {
    const detail = error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
    console.error(`match_stats_raw 정리 실패: ${detail}`);
    process.exitCode = 1;
  });
}
