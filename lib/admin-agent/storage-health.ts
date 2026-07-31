import { getR2BucketUsage } from "@/lib/pubg-analysis/r2Service";
import type {
  ReclaimTarget,
  StorageHealthSummary,
  StorageUsageStatus,
} from "@/types/storage-health";

export const SUPABASE_FREE_DATABASE_LIMIT_BYTES = 500 * 1024 * 1024;
export const R2_FREE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

export type { ReclaimTarget, StorageHealthSummary, StorageUsageStatus };

// 정리 대상별 설정. 화면과 API 가 같은 정의를 쓰도록 여기서 단일 관리한다.
export const RECLAIM_TARGETS: Record<ReclaimTarget, {
  label: string;
  table: string;
  rpc: string;
  detail: string;
}> = {
  match_stats_raw: {
    label: "전적 원본 축소",
    table: "match_stats_raw",
    rpc: "compact_match_stats_raw",
    detail: "분석 표본도 1등 승자도 아닌 참가자 행을 지웁니다. 관리자 통계는 표본 집계라 영향이 없습니다.",
  },
  pubg_player_cache: {
    label: "자동완성 후보 정리",
    table: "pubg_player_cache",
    rpc: "compact_pubg_player_cache",
    detail: "사용자가 한 번도 조회하지 않은 후보를 최근 관측 순 상위 15만 건만 남기고 지웁니다. 검색되면 다시 캐시됩니다.",
  },
};

// cleanup_telemetry.ts 와 같은 값을 쓴다. 화면에서 보는 예상치와 실제 정리
// 결과가 어긋나지 않도록 한다.
const PLAYER_CACHE_RETENTION_DAYS = 90;
const PLAYER_CACHE_KEEP_RECENT = 150_000;
// 5,000 은 Supabase 무료 플랜의 statement timeout 을 넘긴다(2026-08-01 실측).
// dry-run 은 count 만 세지만 실제 정리와 같은 값을 써 혼동을 줄인다.
const PLAYER_CACHE_BATCH_LIMIT = 1_000;

const MONITORED_TABLES = [
  "pubg_player_cache",
  "match_stats_raw",
  "processed_match_telemetry",
  "match_master_telemetry",
  "global_benchmarks",
  "analytics_events",
  "match_ai_coaching_cache",
  "player_ai_summary_cache",
  "squad_ai_coaching_cache",
  "ai_usage_logs"
];

export async function buildStorageHealth(supabase: any): Promise<StorageHealthSummary> {
  const [database, r2, tableSizes] = await Promise.all([
    fetchDatabaseUsage(supabase),
    fetchR2Usage(),
    fetchTableSizes(supabase)
  ]);
  const [tables, reclaimable] = await Promise.all([
    fetchTableCounts(supabase, tableSizes),
    fetchReclaimable(supabase, tableSizes)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    database,
    r2,
    tables,
    reclaimable,
    recommendations: buildRecommendations(database, r2, tables, reclaimable)
  };
}

/**
 * 테이블별 실제 디스크 크기를 가져옵니다.
 *
 * get_table_sizes 는 pg_catalog 만 읽는 service_role 전용 함수입니다.
 * 실패하면 크기 없이 행수만 노출하도록 빈 맵을 돌려줍니다. 용량 표시가
 * 없어도 대시보드 나머지는 계속 동작해야 합니다.
 */
async function fetchTableSizes(
  supabase: any,
): Promise<Map<string, { totalBytes: number; tableBytes: number; indexBytes: number }>> {
  const sizes = new Map<string, { totalBytes: number; tableBytes: number; indexBytes: number }>();
  try {
    const { data, error } = await supabase.rpc("get_table_sizes", { p_limit: 60 });
    if (error || !Array.isArray(data)) return sizes;
    for (const row of data) {
      const name = typeof row?.table_name === "string" ? row.table_name : null;
      if (!name) continue;
      sizes.set(name, {
        totalBytes: Number(row.total_bytes ?? 0),
        tableBytes: Number(row.table_bytes ?? 0),
        indexBytes: Number(row.index_bytes ?? 0),
      });
    }
  } catch {
    return sizes;
  }
  return sizes;
}

/**
 * 정리로 회수 가능한 용량을 dry-run 으로 추정합니다.
 *
 * 각 compact RPC 를 p_apply=false 로 호출하므로 아무것도 삭제하지 않습니다.
 * 예상 바이트는 "테이블 총 크기 / 총 행수 * 삭제 대상 행수"로 계산합니다.
 * 인덱스도 행수에 비례해 줄어들기 때문에 총 크기를 기준으로 삼습니다.
 */
async function fetchReclaimable(
  supabase: any,
  sizes: Map<string, { totalBytes: number; tableBytes: number; indexBytes: number }>,
): Promise<StorageHealthSummary["reclaimable"]> {
  return Promise.all(
    (Object.keys(RECLAIM_TARGETS) as ReclaimTarget[]).map(async (target) => {
      const config = RECLAIM_TARGETS[target];
      const base = {
        target,
        label: config.label,
        detail: config.detail,
      };
      try {
        const { data, error } = await supabase.rpc(config.rpc, buildDryRunArgs(target));
        if (error) throw error;

        const candidateRows = Number((data as any)?.candidate_count ?? 0);
        const totalRows = Number((data as any)?.total_count ?? 0);
        const size = sizes.get(config.table);
        // total_count 를 돌려주지 않는 RPC 도 있어 크기 정보가 없으면 0으로 둔다.
        const estimatedBytes = size && totalRows > 0
          ? Math.round((size.totalBytes / totalRows) * candidateRows)
          : 0;

        return { ...base, candidateRows, estimatedBytes, error: null };
      } catch (error: any) {
        return {
          ...base,
          candidateRows: 0,
          estimatedBytes: 0,
          error: error?.message || String(error),
        };
      }
    })
  );
}

/**
 * dry-run 호출 인자를 만듭니다. 실제 정리 실행과 같은 값을 써야 화면에서
 * 본 예상치와 결과가 일치합니다.
 */
export function buildDryRunArgs(target: ReclaimTarget): Record<string, unknown> {
  if (target === "pubg_player_cache") {
    return {
      p_retention_days: PLAYER_CACHE_RETENTION_DAYS,
      p_apply: false,
      p_batch_limit: PLAYER_CACHE_BATCH_LIMIT,
      p_keep_recent: PLAYER_CACHE_KEEP_RECENT,
    };
  }
  return { p_apply: false, p_batch_limit: PLAYER_CACHE_BATCH_LIMIT };
}

async function fetchDatabaseUsage(supabase: any): Promise<StorageHealthSummary["database"]> {
  try {
    const { data, error } = await supabase.rpc("get_db_size");
    if (error) throw error;
    const usedBytes = Number(data || 0);
    return {
      usedBytes,
      limitBytes: SUPABASE_FREE_DATABASE_LIMIT_BYTES,
      usagePercent: percent(usedBytes, SUPABASE_FREE_DATABASE_LIMIT_BYTES),
      status: statusForUsage(usedBytes, SUPABASE_FREE_DATABASE_LIMIT_BYTES),
      error: null
    };
  } catch (error: any) {
    return {
      usedBytes: 0,
      limitBytes: SUPABASE_FREE_DATABASE_LIMIT_BYTES,
      usagePercent: 0,
      status: "unavailable",
      error: error.message || String(error)
    };
  }
}

async function fetchR2Usage(): Promise<StorageHealthSummary["r2"]> {
  try {
    const usage = await getR2BucketUsage();
    return {
      bucketName: usage.bucketName,
      fileCount: usage.fileCount,
      totalSizeBytes: usage.totalSizeBytes,
      limitBytes: R2_FREE_STORAGE_LIMIT_BYTES,
      usagePercent: percent(usage.totalSizeBytes, R2_FREE_STORAGE_LIMIT_BYTES),
      scannedPages: usage.scannedPages,
      truncated: usage.truncated,
      configured: usage.configured,
      status: usage.configured ? statusForUsage(usage.totalSizeBytes, R2_FREE_STORAGE_LIMIT_BYTES) : "unavailable",
      error: null
    };
  } catch (error: any) {
    return {
      bucketName: null,
      fileCount: 0,
      totalSizeBytes: 0,
      limitBytes: R2_FREE_STORAGE_LIMIT_BYTES,
      usagePercent: 0,
      scannedPages: 0,
      truncated: false,
      configured: false,
      status: "unavailable",
      error: error.message || String(error)
    };
  }
}

async function fetchTableCounts(
  supabase: any,
  sizes: Map<string, { totalBytes: number; tableBytes: number; indexBytes: number }>,
): Promise<StorageHealthSummary["tables"]> {
  const rows = await Promise.all(
    MONITORED_TABLES.map(async (table) => {
      const { count, error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });
      const size = sizes.get(table);
      return {
        table,
        count: error ? null : count || 0,
        totalBytes: size?.totalBytes ?? null,
        tableBytes: size?.tableBytes ?? null,
        indexBytes: size?.indexBytes ?? null,
        status: error ? "unavailable" as const : "ok" as const,
        error: error?.message || null
      };
    })
  );

  // 용량이 큰 순으로 정렬해 병목이 위에 오게 한다. 크기를 못 구한 항목은 뒤로 보낸다.
  return rows.sort((left, right) => (right.totalBytes ?? -1) - (left.totalBytes ?? -1));
}

function buildRecommendations(
  database: StorageHealthSummary["database"],
  r2: StorageHealthSummary["r2"],
  tables: StorageHealthSummary["tables"],
  reclaimable: StorageHealthSummary["reclaimable"]
) {
  const recommendations = [];
  if (database.status === "critical") {
    recommendations.push("Supabase DB가 Free 기준 80%를 넘었습니다. 오래된 analytics/cache 정리 승인과 테이블별 증가량 점검이 필요합니다.");
  } else if (database.status === "warn") {
    recommendations.push("Supabase DB가 Free 기준 60%를 넘었습니다. pubg_player_cache, match_stats_raw 증가 추이를 주간으로 확인하세요.");
  }

  // 가장 큰 테이블을 실제 수치로 짚어준다. 행수만 보면 병목을 오판할 수 있다.
  const largest = tables.find((table) => (table.totalBytes ?? 0) > 0);
  if (largest?.totalBytes) {
    recommendations.push(
      `가장 큰 테이블은 ${largest.table} 이고 ${formatBytes(largest.totalBytes)} 입니다`
      + `${largest.count !== null ? ` (${largest.count.toLocaleString()}행)` : ""}.`
    );
  }

  // 회수 가능한 용량이 의미 있는 규모면 알린다.
  const totalReclaimable = reclaimable.reduce((sum, item) => sum + item.estimatedBytes, 0);
  if (totalReclaimable >= 10 * 1024 * 1024) {
    const targets = reclaimable
      .filter((item) => item.estimatedBytes > 0)
      .map((item) => `${item.label} ${formatBytes(item.estimatedBytes)}`)
      .join(", ");
    recommendations.push(
      `정리하면 약 ${formatBytes(totalReclaimable)} 를 회수할 수 있습니다 (${targets}). `
      + "실행 전 대상 건수를 먼저 확인하세요."
    );
  }

  const failedReclaim = reclaimable.filter((item) => item.error);
  if (failedReclaim.length > 0) {
    recommendations.push(
      `정리 대상 조회가 ${failedReclaim.length}건 실패했습니다. 마이그레이션 적용 여부와 service role 권한을 확인하세요.`
    );
  }

  if (r2.status === "critical") {
    recommendations.push("R2 텔레메트리 캐시가 80%를 넘었습니다. 오래된 원본 telemetry 객체 정리 정책을 검토하세요.");
  } else if (r2.status === "warn") {
    recommendations.push("R2 텔레메트리 캐시가 60%를 넘었습니다. 캐시 hit율과 객체 증가량을 함께 확인하세요.");
  }

  if (r2.truncated) {
    recommendations.push("R2 객체 수가 모니터링 상한을 넘었습니다. maxObjects를 올리거나 prefix별 분리 집계를 추가하세요.");
  }

  const unavailableTables = tables.filter((table) => table.status === "unavailable");
  if (unavailableTables.length > 0) {
    recommendations.push(`용량 점검 중 ${unavailableTables.length}개 테이블 조회가 실패했습니다. service role 권한과 테이블명을 확인하세요.`);
  }

  if (!recommendations.length) {
    recommendations.push("Supabase DB와 R2 캐시 용량은 현재 안정권입니다.");
  }
  return recommendations;
}

function percent(usedBytes: number, limitBytes: number) {
  if (!limitBytes) return 0;
  return Number(((usedBytes / limitBytes) * 100).toFixed(2));
}

function statusForUsage(usedBytes: number, limitBytes: number): StorageUsageStatus {
  const usage = percent(usedBytes, limitBytes);
  if (usage >= 80) return "critical";
  if (usage >= 60) return "warn";
  return "ok";
}

/** 용량을 사람이 읽는 단위로 바꿉니다. 권고 문구와 화면이 같은 표기를 씁니다. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
