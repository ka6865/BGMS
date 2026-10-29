import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { PLAYER_CACHE_KEEP_RECENT, PLAYER_CACHE_RETENTION_DAYS } from "../lib/admin-agent/storage-limits";

// 매치 분석·티어와 텔레메트리 원본은 장기 보관한다. 이 스크립트는 master/processed/registry DB 삭제와
// R2 삭제를 하지 않고, 자동완성 후보로만 쌓인 pubg_player_cache 정리만 수행한다.
// R2에서 DB 참조가 끊긴 파일은 별도 orphan cleanup dry-run으로만 점검한다.

// 정기 정리는 타임아웃과 한 번의 삭제 규모를 제한하도록 1,000개씩 최대 30회 처리한다.
// 2026-10-14 밀린 19만 행을 줄이도록 늘렸다. 한 실행 3만 행(1,000 × 30) 상한은 유지한다.
const PLAYER_CACHE_BATCH_LIMIT = 1000;
const PLAYER_CACHE_MAX_BATCHES = 30;

export type PlayerCacheCleanupResult = {
  batches: number;
  deletedCount: number;
  remainingCount: number;
};

/**
 * 자동완성 후보로만 쌓인 pubg_player_cache 행을 정리합니다.
 *
 * 이전 구현은 `search_count = 0 AND updated_at < cutoff` 를 직접 삭제했는데,
 * persistMatchAnalysis 가 매 분석마다 참가자 전원의 updated_at 을 갱신해
 * 대상 행이 계속 보존 기간 안으로 되살아났습니다. 실측에서 42만 행 중 삭제
 * 대상이 5,300행(1.2%)뿐이었습니다.
 *
 * compact_pubg_player_cache 는 last_seen_at(사용자 조회 시점)을 기준으로 삼아
 * 자동 수집 갱신이 보존 기간을 연장하지 못하게 합니다. 배치 삭제라 한 번에
 * 전부 지우지 않으므로, 남은 대상이 있으면 반복 호출합니다.
 */
export async function cleanupInactivePlayerCache(
  supabase: Pick<SupabaseClient, "rpc">,
): Promise<PlayerCacheCleanupResult> {
  const result: PlayerCacheCleanupResult = { batches: 0, deletedCount: 0, remainingCount: 0 };
  for (let batch = 0; batch < PLAYER_CACHE_MAX_BATCHES; batch += 1) {
    const { data, error } = await supabase.rpc("compact_pubg_player_cache", {
      p_retention_days: PLAYER_CACHE_RETENTION_DAYS,
      p_apply: true,
      p_batch_limit: PLAYER_CACHE_BATCH_LIMIT,
      p_keep_recent: PLAYER_CACHE_KEEP_RECENT,
    });
    if (error) throw new Error("telemetry-cleanup-player-cache-failed");

    const page = data as {
      deleted_count?: unknown;
      remaining_count?: unknown;
    } | null;
    if (
      !page
      || !Number.isInteger(Number(page.deleted_count))
      || !Number.isInteger(Number(page.remaining_count))
    ) {
      throw new Error("telemetry-cleanup-player-cache-invalid-result");
    }

    result.batches += 1;
    result.deletedCount += Number(page.deleted_count);
    result.remainingCount = Number(page.remaining_count);

    // 더 지울 것이 없거나 이번 배치가 아무것도 지우지 못하면 종료한다.
    if (Number(page.deleted_count) === 0 || Number(page.remaining_count) === 0) break;
  }
  return result;
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key}-missing`);
  return value;
}

export async function runPlayerCacheCleanupFromEnvironment(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const result = await cleanupInactivePlayerCache(supabase);
  console.info(JSON.stringify({ playerCache: result }));
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runPlayerCacheCleanupFromEnvironment().catch((error: unknown) => {
    // 원인 없이 메시지만 남기면 운영에서 실패 이유를 추적할 수 없다.
    const detail = error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
    console.error(`플레이어 캐시 정리 작업이 실패했습니다. 원인: ${detail}`);
    process.exitCode = 1;
  });
}
