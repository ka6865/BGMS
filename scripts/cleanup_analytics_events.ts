/**
 * @fileoverview analytics_events 및 analytics_event_rate_limits 보존 기간 정리를 수행합니다.
 *
 * analytics_events 는 사용자 행동 분석용 원본 로그로, 정리 로직이 없어
 * 2026-06-10 부터 두 달간 한 번도 삭제되지 않아 45MB 까지 누적되었습니다.
 * 화면에 직접 표시되지 않으므로 보존 기간이 지난 원본을 삭제해도 기능 영향이 없습니다.
 *
 * 일일 유지보수 작업(.github/workflows/daily-tasks.yml)에서 호출합니다.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type RpcClient = Pick<SupabaseClient, "rpc">;

export type AnalyticsCleanupResult = {
  deletedEventRows: number;
  deletedRateLimitRows: number;
  hasRemaining: boolean;
};

// 행동 로그 보존 기간. 월간 추이 비교가 가능한 최소 길이로 둡니다.
export const ANALYTICS_EVENT_RETENTION_DAYS = 30;
// rate limit 기록 보존 기간. 짧은 창 단위 판정에만 쓰이므로 길게 둘 필요가 없습니다.
export const ANALYTICS_RATE_LIMIT_RETENTION_DAYS = 7;
// 한 번에 삭제할 행 수. 장시간 락을 피하기 위해 배치로 나눕니다.
export const ANALYTICS_EVENT_BATCH_LIMIT = 5000;
// 한 실행에서 반복할 최대 배치 수. 무한 루프를 방지합니다.
export const ANALYTICS_EVENT_MAX_BATCHES = 20;

function toRowCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * 보존 기간이 지난 행동 로그를 배치 단위로 삭제합니다.
 * 배치가 가득 차면 남은 대상이 있다고 보고 다음 배치를 이어서 처리합니다.
 */
export async function cleanupAnalyticsTables(
  supabaseAdmin: RpcClient,
): Promise<AnalyticsCleanupResult> {
  const result: AnalyticsCleanupResult = {
    deletedEventRows: 0,
    deletedRateLimitRows: 0,
    hasRemaining: false,
  };

  for (let batch = 0; batch < ANALYTICS_EVENT_MAX_BATCHES; batch += 1) {
    const { data, error } = await supabaseAdmin.rpc("cleanup_analytics_events", {
      p_retention_days: ANALYTICS_EVENT_RETENTION_DAYS,
      p_batch_limit: ANALYTICS_EVENT_BATCH_LIMIT,
    });
    if (error) {
      throw new Error(`cleanup_analytics_events 실패: ${error.message}`);
    }

    const deleted = toRowCount(data);
    result.deletedEventRows += deleted;

    // 배치 한도보다 적게 삭제되었다면 대상이 소진된 것으로 본다.
    if (deleted < ANALYTICS_EVENT_BATCH_LIMIT) {
      break;
    }

    // 마지막 배치까지 가득 찼다면 다음 실행에서 이어서 처리해야 한다.
    if (batch === ANALYTICS_EVENT_MAX_BATCHES - 1) {
      result.hasRemaining = true;
    }
  }

  const { data: rateLimitDeleted, error: rateLimitError } = await supabaseAdmin.rpc(
    "cleanup_analytics_event_rate_limits",
    { p_retention_days: ANALYTICS_RATE_LIMIT_RETENTION_DAYS },
  );
  if (rateLimitError) {
    throw new Error(`cleanup_analytics_event_rate_limits 실패: ${rateLimitError.message}`);
  }
  result.deletedRateLimitRows = toRowCount(rateLimitDeleted);

  return result;
}

export async function runAnalyticsCleanup(
  env: Record<string, string | undefined> = process.env,
): Promise<AnalyticsCleanupResult> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("analytics-cleanup-credentials-missing");
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return cleanupAnalyticsTables(supabaseAdmin);
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  runAnalyticsCleanup()
    .then((result) => {
      console.info(
        `Analytics cleanup: 행동 로그 ${result.deletedEventRows}행, rate limit ${result.deletedRateLimitRows}행 삭제. backlog=${result.hasRemaining}`,
      );
    })
    .catch((error: unknown) => {
      // 원인 없이 메시지만 남기면 운영에서 실패 이유를 추적할 수 없다.
      const detail = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`Analytics cleanup failed: ${detail}`);
      process.exitCode = 1;
    });
}
