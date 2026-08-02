import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/pubg-analysis/r2Service", () => ({
  getR2BucketUsage: vi.fn(async () => ({
    bucketName: "test-bucket",
    fileCount: 10,
    totalSizeBytes: 1024 * 1024,
    scannedPages: 1,
    truncated: false,
    configured: true,
  })),
}));

import * as storageHealth from "../lib/admin-agent/storage-health";

const { buildStorageHealth, formatBytes } = storageHealth;

function createSupabase(options: {
  tableSizes?: Array<Record<string, unknown>>;
  sizeError?: boolean;
  compaction?: Record<string, { candidate_count: number; total_count: number }>;
  compactionError?: string;
} = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "get_db_size") return { data: 300 * 1024 * 1024, error: null };
    if (name === "get_table_sizes") {
      if (options.sizeError) return { data: null, error: { message: "no function" } };
      return { data: options.tableSizes ?? [], error: null };
    }
    if (options.compactionError) {
      return { data: null, error: { message: options.compactionError } };
    }
    const key = name === "compact_pubg_player_cache" ? "pubg_player_cache" : "match_stats_raw";
    const row = options.compaction?.[key];
    if (!row) return { data: { candidate_count: 0, total_count: 0 }, error: null };
    return { data: row, error: null };
  });

  return {
    rpc,
    from: vi.fn(() => ({
      select: vi.fn(async () => ({ count: 100, error: null })),
    })),
  };
}

describe("저장 용량 현황", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("현재 Pro gp3의 포함 디스크 8GB를 기본 관제 기준으로 사용한다", async () => {
    vi.stubEnv("SUPABASE_DATABASE_LIMIT_BYTES", "");

    const health = await buildStorageHealth(createSupabase());

    expect(health.database.limitBytes).toBe(8 * 1024 * 1024 * 1024);
    expect(health.database.status).toBe("ok");
    expect(health.recommendations.join(" ")).not.toContain("Free 기준");
  });

  it("프로비저닝 디스크가 달라지면 환경변수 기준으로 관제한다", async () => {
    vi.stubEnv("SUPABASE_DATABASE_LIMIT_BYTES", String(12 * 1024 * 1024 * 1024));

    const health = await buildStorageHealth(createSupabase());

    expect(health.database.limitBytes).toBe(12 * 1024 * 1024 * 1024);
  });

  it("테이블별 실제 크기를 함께 보고한다", async () => {
    const supabase = createSupabase({
      tableSizes: [
        { table_name: "pubg_player_cache", total_bytes: 173_400_000, table_bytes: 81_000_000, index_bytes: 92_400_000 },
        { table_name: "match_stats_raw", total_bytes: 5_500_000, table_bytes: 3_000_000, index_bytes: 2_500_000 },
      ],
    });

    const health = await buildStorageHealth(supabase);
    const playerCache = health.tables.find((table) => table.table === "pubg_player_cache");

    expect(playerCache?.totalBytes).toBe(173_400_000);
    expect(playerCache?.indexBytes).toBe(92_400_000);
  });

  it("용량이 큰 순으로 정렬한다", async () => {
    const supabase = createSupabase({
      tableSizes: [
        { table_name: "match_stats_raw", total_bytes: 5_500_000, table_bytes: 3_000_000, index_bytes: 2_500_000 },
        { table_name: "pubg_player_cache", total_bytes: 173_400_000, table_bytes: 81_000_000, index_bytes: 92_400_000 },
      ],
    });

    const health = await buildStorageHealth(supabase);
    const sized = health.tables.filter((table) => table.totalBytes !== null);

    expect(sized[0]?.table).toBe("pubg_player_cache");
  });

  it("크기 조회가 실패해도 행수는 유지한다", async () => {
    const supabase = createSupabase({ sizeError: true });

    const health = await buildStorageHealth(supabase);

    expect(health.tables.length).toBeGreaterThan(0);
    expect(health.tables[0]?.totalBytes).toBeNull();
    expect(health.tables[0]?.count).toBe(100);
  });

  it("정리 가능 용량을 대상 행수 비례로 추정한다", async () => {
    const supabase = createSupabase({
      tableSizes: [
        { table_name: "pubg_player_cache", total_bytes: 400_000_000, table_bytes: 200_000_000, index_bytes: 200_000_000 },
      ],
      compaction: {
        pubg_player_cache: { candidate_count: 100, total_count: 400 },
      },
    });

    const health = await buildStorageHealth(supabase);
    const item = health.reclaimable.find((entry) => entry.target === "pubg_player_cache");

    // 400MB 중 400행에서 100행이 대상이면 25% 인 100MB 다.
    expect(item?.candidateRows).toBe(100);
    expect(item?.estimatedBytes).toBe(100_000_000);
  });

  it("정리 대상 조회 실패를 삼키지 않고 보고한다", async () => {
    const supabase = createSupabase({ compactionError: "function does not exist" });

    const health = await buildStorageHealth(supabase);

    expect(health.reclaimable.every((item) => item.error !== null)).toBe(true);
    expect(health.recommendations.some((text) => text.includes("정리 대상 조회가"))).toBe(true);
  });

  it("total_count 가 없으면 회수 용량을 0으로 둔다", async () => {
    // 응답에 총 행수가 없으면 행당 크기를 계산할 수 없다. 추측값을 만들지 않는다.
    const supabase = createSupabase({
      tableSizes: [
        { table_name: "match_stats_raw", total_bytes: 5_500_000, table_bytes: 3_000_000, index_bytes: 2_500_000 },
      ],
      compaction: {
        match_stats_raw: { candidate_count: 1_000 } as never,
      },
    });

    const health = await buildStorageHealth(supabase);
    const item = health.reclaimable.find((entry) => entry.target === "match_stats_raw");

    expect(item?.candidateRows).toBe(1_000);
    expect(item?.estimatedBytes).toBe(0);
  });

  it("정리 가능 용량이 10MB 를 넘으면 점검 결과로 알린다", async () => {
    const supabase = createSupabase({
      tableSizes: [
        { table_name: "pubg_player_cache", total_bytes: 176_000_000, table_bytes: 81_000_000, index_bytes: 95_000_000 },
      ],
      compaction: {
        pubg_player_cache: { candidate_count: 279_597, total_count: 429_947 },
      },
    });

    const health = await buildStorageHealth(supabase);

    expect(health.recommendations.some((text) => text.includes("회수할 수 있습니다"))).toBe(true);
  });

  it("가장 큰 테이블을 점검 결과에 실제 수치로 남긴다", async () => {
    const supabase = createSupabase({
      tableSizes: [
        { table_name: "pubg_player_cache", total_bytes: 173_400_000, table_bytes: 81_000_000, index_bytes: 92_400_000 },
      ],
    });

    const health = await buildStorageHealth(supabase);

    expect(health.recommendations.some((text) => text.includes("pubg_player_cache"))).toBe(true);
  });

  it("용량 표기는 단위를 맞춘다", () => {
    expect(formatBytes(0)).toBe("0MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00GB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
    expect(formatBytes(2048)).toBe("2KB");
  });
});

describe("일일 유지보수 DB health gate", () => {
  const api = storageHealth as typeof storageHealth & {
    evaluateDatabaseMaintenanceHealth?: (metrics: Record<string, number>) => {
      healthy: boolean;
      reasons: string[];
    };
    fetchDatabaseMaintenanceHealth?: (supabase: unknown) => Promise<{
      healthy: boolean;
      reasons: string[];
    }>;
  };

  it("연결·active query·lock·장기 쿼리가 임계치 미만이면 유지보수를 허용한다", () => {
    expect(api.evaluateDatabaseMaintenanceHealth).toBeTypeOf("function");

    expect(api.evaluateDatabaseMaintenanceHealth!({
      totalConnections: 20,
      maxConnections: 60,
      activeQueries: 2,
      lockWaiters: 0,
      longestActiveSeconds: 4,
    })).toEqual({ healthy: true, reasons: [] });
  });

  it("연결 80%·lock 대기·30초 장기 쿼리 중 하나라도 있으면 중단 사유를 모두 반환한다", () => {
    expect(api.evaluateDatabaseMaintenanceHealth).toBeTypeOf("function");

    const assessment = api.evaluateDatabaseMaintenanceHealth!({
      totalConnections: 48,
      maxConnections: 60,
      activeQueries: 8,
      lockWaiters: 1,
      longestActiveSeconds: 30,
    });

    expect(assessment.healthy).toBe(false);
    expect(assessment.reasons).toEqual([
      "database connections 48/60 (80.0%)",
      "active queries 8",
      "lock waiters 1",
      "longest active query 30.0s",
    ]);
  });

  it("service-role RPC 결과를 제한 시간 안에 평가한다", async () => {
    expect(api.fetchDatabaseMaintenanceHealth).toBeTypeOf("function");
    const abortSignal = vi.fn().mockResolvedValue({
      data: [{
        total_connections: 12,
        max_connections: 60,
        active_queries: 1,
        lock_waiters: 0,
        longest_active_seconds: 2.5,
      }],
      error: null,
    });
    const retry = vi.fn(() => ({ abortSignal }));
    const rpc = vi.fn(() => ({ retry, abortSignal }));

    await expect(api.fetchDatabaseMaintenanceHealth!({ rpc })).resolves.toEqual({
      healthy: true,
      reasons: [],
    });
    expect(rpc).toHaveBeenCalledWith("get_database_maintenance_health");
    expect(retry).toHaveBeenCalledWith(false);
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
});
