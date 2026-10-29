/**
 * 벤치마크 명단에서 은퇴한 지 90일이 지난 벤치마커의 식별 정보를 정리합니다.
 * 기본 실행은 dry-run이며 --apply를 지정해야 실제로 삭제·식별자 제거를 합니다.
 * 실제 정리 범위는 cleanup_retired_benchmark_cohort RPC(20261030020000 migration)가 정합니다.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

/** 명단 제외(은퇴) 후 식별 정보를 보관하는 기간. 개인정보처리방침의 벤치마크 표본 항목과 같다. */
export const BENCHMARK_COHORT_RETENTION_DAYS = 90;
export const BENCHMARK_COHORT_BATCH_LIMIT = 50;
export const BENCHMARK_COHORT_MAX_BATCHES = 20;

const COUNT_FIELDS = [
  "candidate_players",
  "searched_players_kept",
  "processed_match_telemetry",
  "pubg_match_performance",
  "pubg_player_matches",
  "pubg_player_cache",
  "global_benchmarks_pseudonymized",
  "weapon_meta_match_samples_pseudonymized",
  "match_stats_raw_pseudonymized",
  "cohort_rows_deleted",
  "remaining_candidates",
] as const;

type CountField = (typeof COUNT_FIELDS)[number];
export type BenchmarkCohortCleanupSummary = Record<CountField, number> & { dry_run: boolean };

type RpcClient = Pick<SupabaseClient, "rpc">;

export function parseCleanupSummary(value: unknown): BenchmarkCohortCleanupSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark-cohort-cleanup-invalid-rpc-result");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.dry_run !== "boolean") throw new Error("benchmark-cohort-cleanup-invalid-rpc-result");
  const summary = { dry_run: candidate.dry_run } as BenchmarkCohortCleanupSummary;
  for (const field of COUNT_FIELDS) {
    const count = Number(candidate[field]);
    if (!Number.isInteger(count) || count < 0) throw new Error("benchmark-cohort-cleanup-invalid-rpc-result");
    summary[field] = count;
  }
  return summary;
}

export function retiredBeforeCutoff(now: Date, retentionDays = BENCHMARK_COHORT_RETENTION_DAYS): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

async function callCleanupRpc(supabase: RpcClient, cutoff: Date, apply: boolean, limit: number) {
  const { data, error } = await supabase.rpc("cleanup_retired_benchmark_cohort", {
    p_retired_before: cutoff.toISOString(),
    p_apply: apply,
    p_limit: limit,
  });
  if (error) throw new Error(`벤치마크 명단 정리 RPC 실패: ${error.message}`);
  return parseCleanupSummary(data);
}

function addSummaries(total: BenchmarkCohortCleanupSummary, next: BenchmarkCohortCleanupSummary): BenchmarkCohortCleanupSummary {
  const merged = { ...total, dry_run: next.dry_run };
  for (const field of COUNT_FIELDS) merged[field] = field === "remaining_candidates" ? next[field] : total[field] + next[field];
  return merged;
}

export async function cleanupBenchmarkCohort(
  supabase: RpcClient,
  options: {
    apply?: boolean;
    now?: Date;
    batchLimit?: number;
    maxBatches?: number;
    write?: (message: string) => void;
  } = {},
): Promise<BenchmarkCohortCleanupSummary> {
  const batchLimit = options.batchLimit ?? BENCHMARK_COHORT_BATCH_LIMIT;
  const maxBatches = options.maxBatches ?? BENCHMARK_COHORT_MAX_BATCHES;
  const write = options.write ?? ((message: string) => console.info(message));
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 500) {
    throw new Error("benchmark-cohort-cleanup-invalid-batch-limit");
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error("benchmark-cohort-cleanup-invalid-max-batches");
  }
  const cutoff = retiredBeforeCutoff(options.now ?? new Date());

  // dry-run은 첫 묶음의 영향만 보여 준다. 남은 인원은 remaining_candidates로 확인한다.
  const preview = await callCleanupRpc(supabase, cutoff, false, batchLimit);
  write(`정리 대상(첫 묶음): ${JSON.stringify(preview)}`);
  if (options.apply !== true) {
    write("dry-run 이므로 변경하지 않았습니다. 실제 정리는 --apply를 사용하세요.");
    return preview;
  }

  let total: BenchmarkCohortCleanupSummary | null = null;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await callCleanupRpc(supabase, cutoff, true, batchLimit);
    total = total ? addSummaries(total, result) : result;
    if (result.candidate_players === 0 || result.remaining_candidates === 0) break;
  }
  write(`정리 완료: ${JSON.stringify(total)}`);
  return total ?? preview;
}

async function runFromEnvironment(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("benchmark-cohort-cleanup-credentials-missing");
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await cleanupBenchmarkCohort(supabase, { apply: process.argv.includes("--apply") });
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runFromEnvironment().catch((error: unknown) => {
    const detail = error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
    console.error(`벤치마크 명단 정리 실패: ${detail}`);
    process.exitCode = 1;
  });
}
