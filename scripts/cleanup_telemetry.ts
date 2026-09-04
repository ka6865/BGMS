import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { TELEMETRY_VERSION } from "../lib/pubg-analysis/constants";

export type TelemetryCleanupMasterRow = {
  match_id: string;
  storage_path: string | null;
  telemetry_version: number | string | null;
  created_at: string;
};

export type TelemetryCleanupRegistryRow = {
  match_id: string;
  storage_path: string;
  status: "pending" | "ready";
  lease_expires_at: string | null;
  updated_at: string;
};

type RangePage<T> = {
  data: T[] | null;
  error: { message?: string } | null;
};

export type TelemetryCleanupDependencies = {
  listMasterRows(): Promise<TelemetryCleanupMasterRow[]>;
  listRegistryRows(): Promise<TelemetryCleanupRegistryRow[]>;
  archiveObjectInventory(rows: TelemetryCleanupRegistryRow[]): Promise<void>;
  cleanupExpiredMatches(
    matchIds: string[],
    cutoff: Date,
    targetVersion: number,
    now: Date,
  ): Promise<string[]>;
  now(): Date;
};

export type TelemetryCleanupConfig = {
  cutoff: Date;
  targetVersion: number;
};

export type TelemetryCleanupResult = {
  deletedMatchCount: number;
  archivedObjectCount: number;
  inventoryManifestCount: number;
  r2DeletionDeferred: true;
};

const QUERY_PAGE_SIZE = 500;
const DELETE_BATCH_SIZE = 50;

// pubg_player_cache 보존 기간. last_seen_at(사용자 조회 시점)이 이 기간을 넘긴
// 행만 만료로 본다. 조회 이력이 아예 없는 행은 기간과 무관하게 대상이 된다.
//
// updated_at 은 기준으로 쓰지 않는다. 스크래퍼가 며칠 주기로 테이블 전체를
// upsert 하므로 그 값은 "수집이 지나갔다"만 뜻한다. 실측에서 최근 14일 내
// 갱신 행이 전체의 98.7%였다.
const PLAYER_CACHE_RETENTION_DAYS = 90;

// 한 배치에서 삭제할 행수.
//
// 5,000 은 Supabase 무료 플랜의 statement timeout 을 넘겼다. 2026-08-01 일일
// 작업이 `telemetry-cleanup-player-cache-failed` 로 실패했고, 재현해보니
// 삭제 쿼리가 8.7초에서 취소됐다.
//
// 실측 소요 시간이다.
//   batch=  500  0.97초
//   batch=1,000  1.25초
//   batch=2,000  1.80초
//   batch=5,000  타임아웃
//
// 2,000 도 통과하지만 테이블이 커질수록 느려지므로 여유를 두고 1,000 을 쓴다.
const PLAYER_CACHE_BATCH_LIMIT = 500;

// 자동완성 후보 풀 상한. 활동 신호가 없는 행은 최근 관측 순 상위 이 개수까지만
// 남긴다. 활동 신호(검색 이력·전적 캐시)가 있는 행은 상한과 무관하게 보존된다.
//
// 실측으로 정한 값이다. 검색된 유저 닉네임 접두사 20종으로 자동완성을 시뮬레이션한
// 결과다.
//   상한 150,000 -> 제안 93% 유지, 테이블 약 58MB (108MB 회수)
//   상한 100,000 -> 제안 89% 유지, 테이블 약 39MB
//   상한  50,000 -> 제안 82% 유지, 테이블 약 19MB
// 어느 상한에서도 제안이 0건이 되는 접두사는 없었다.
const PLAYER_CACHE_KEEP_RECENT = 150_000;

// 한 번 실행에서 정리할 최대 배치 수. 1,000 * 30 = 30,000행이다.
//
// 초기 적재분이 28만 행(2026-08-01 실측)이라 한 번에 전부 지우면 되돌릴 수
// 없는 대량 삭제가 배포 직후 자동으로 일어난다. 하루 3만 행씩 약 열흘에
// 걸쳐 줄어들도록 제한해, 문제가 보이면 중간에 멈출 수 있게 한다.
//
// 배치당 약 1.3초라 30회는 40초 수준이고 워크플로 시간에 부담이 없다.
// 정상 운영 시 하루 순증은 실측 1만 6천 행 수준이라 이 상한으로 충분히 따라잡는다.
const PLAYER_CACHE_MAX_BATCHES = 30;

export async function fetchAllRowsByRange<T>(
  fetchPage: (from: number, to: number) => Promise<RangePage<T>>,
  pageSize = QUERY_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("telemetry-cleanup-invalid-page-size");
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (page.error) {
      throw new Error(page.error.message || "telemetry-cleanup-page-read-failed");
    }
    if (page.data === null) {
      throw new Error("telemetry-cleanup-page-data-missing");
    }

    const data = page.data;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function isExpiredMasterRow(
  row: TelemetryCleanupMasterRow,
  config: TelemetryCleanupConfig,
): boolean {
  const telemetryVersion = Number(row.telemetry_version);
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(telemetryVersion) || !Number.isFinite(createdAt)) {
    throw new Error("telemetry-cleanup-invalid-master-row");
  }

  return telemetryVersion < config.targetVersion
    || createdAt < config.cutoff.getTime();
}

function validateConfig(config: TelemetryCleanupConfig): void {
  if (
    !Number.isFinite(config.cutoff.getTime())
    || !Number.isInteger(config.targetVersion)
    || config.targetVersion < 0
  ) {
    throw new Error("telemetry-cleanup-invalid-config");
  }
}

function isExpiredRegistryRow(
  row: TelemetryCleanupRegistryRow,
  cutoff: Date,
  now: Date,
): boolean {
  const updatedAt = Date.parse(row.updated_at);
  const leaseExpiresAt = row.lease_expires_at === null
    ? null
    : Date.parse(row.lease_expires_at);
  if (
    !Number.isFinite(updatedAt)
    || (leaseExpiresAt !== null && !Number.isFinite(leaseExpiresAt))
  ) {
    throw new Error("telemetry-cleanup-invalid-registry-row");
  }
  if (row.status === "pending") {
    return leaseExpiresAt === null || leaseExpiresAt < now.getTime();
  }
  return updatedAt < cutoff.getTime();
}

function validateCleanedMatchIds(
  requestedMatchIds: string[],
  cleanedMatchIds: string[],
): string[] {
  const requested = new Set(requestedMatchIds);
  const unique = uniqueValues(cleanedMatchIds);
  if (
    unique.length !== cleanedMatchIds.length
    || unique.some((matchId) => !requested.has(matchId))
  ) {
    throw new Error("telemetry-cleanup-invalid-rpc-result");
  }
  return unique;
}

export async function runTelemetryStorageCleanup(
  config: TelemetryCleanupConfig,
  dependencies: TelemetryCleanupDependencies,
): Promise<TelemetryCleanupResult> {
  validateConfig(config);
  // 매치 분석·티어는 장기 보관한다. 과거 경기 상세가 사라지지 않게
  // master/processed/registry DB 삭제와 R2 inventory archive를 수행하지 않는다.
  // R2에서 DB 참조가 끊긴 파일은 별도 orphan cleanup dry-run으로만 점검한다.
  void dependencies;

  return {
    deletedMatchCount: 0,
    archivedObjectCount: 0,
    inventoryManifestCount: 0,
    r2DeletionDeferred: true,
  };
}

export function buildTelemetryObjectInventoryArchive(
  rows: TelemetryCleanupRegistryRow[],
): { storagePath: string; body: string } {
  const inventory = [...rows]
    .sort((left, right) => left.storage_path.localeCompare(right.storage_path))
    .map(({ match_id, storage_path }) => ({ match_id, storage_path }));
  const body = JSON.stringify({ version: 1, objects: inventory });
  const digest = createHash("sha256").update(body).digest("hex");
  return {
    storagePath: `telemetry-inventory/v1/${digest}.json`,
    body,
  };
}

async function archiveTelemetryObjectInventory(
  rows: TelemetryCleanupRegistryRow[],
): Promise<void> {
  const archive = buildTelemetryObjectInventoryArchive(rows);
  const { uploadToR2 } = await import("../lib/pubg-analysis/r2Service");
  await uploadToR2(
    archive.storagePath,
    archive.body,
    "application/json",
  );
}

function createTelemetryCleanupDependencies(
  supabase: SupabaseClient,
): TelemetryCleanupDependencies {
  return {
    listMasterRows: () => fetchAllRowsByRange(async (from, to) => {
      const { data, error } = await supabase
        .from("match_master_telemetry")
        .select("match_id, storage_path, telemetry_version, created_at")
        .order("match_id", { ascending: true })
        .range(from, to);
      return {
        data: data as TelemetryCleanupMasterRow[] | null,
        error,
      };
    }),
    listRegistryRows: () => fetchAllRowsByRange(async (from, to) => {
      const { data, error } = await supabase
        .from("telemetry_map_cache_entries")
        .select("match_id, storage_path, status, lease_expires_at, updated_at")
        .order("match_id", { ascending: true })
        .order("storage_path", { ascending: true })
        .range(from, to);
      return {
        data: data as TelemetryCleanupRegistryRow[] | null,
        error,
      };
    }),
    archiveObjectInventory: archiveTelemetryObjectInventory,
    cleanupExpiredMatches: async (matchIds, cutoff, targetVersion, now) => {
      const { data, error } = await supabase.rpc(
        "cleanup_expired_telemetry_matches",
        {
          p_match_ids: matchIds,
          p_cutoff: cutoff.toISOString(),
          p_target_version: targetVersion,
          p_now: now.toISOString(),
        },
      );
      if (error) throw new Error("telemetry-cleanup-expired-rpc-failed");
      if (!Array.isArray(data)) {
        throw new Error("telemetry-cleanup-invalid-rpc-result");
      }

      return data.map((row: unknown) => {
        if (
          typeof row !== "object"
          || row === null
          || typeof (row as { match_id?: unknown }).match_id !== "string"
        ) {
          throw new Error("telemetry-cleanup-invalid-rpc-result");
        }
        return (row as { match_id: string }).match_id;
      });
    },
    now: () => new Date(),
  };
}

async function cleanupOrphanedAnalysisRows(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.rpc("get_orphaned_match_ids");
  if (error) throw new Error("telemetry-cleanup-orphan-query-failed");

  const rows = (data ?? []) as Array<{ match_id: string | null }>;
  const matchIds = uniqueValues(
    rows
      .map((row) => row.match_id)
      .filter((matchId): matchId is string => Boolean(matchId)),
  );
  for (const batch of chunkValues(matchIds, DELETE_BATCH_SIZE)) {
    for (const table of ["match_stats_raw", "processed_match_telemetry"]) {
      const { error: deleteError } = await supabase
        .from(table)
        .delete()
        .in("match_id", batch);
      if (deleteError) throw new Error(`telemetry-cleanup-delete-${table}-failed`);
    }
  }
}

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
): Promise<void> {
  for (let batch = 0; batch < PLAYER_CACHE_MAX_BATCHES; batch += 1) {
    const { data, error } = await supabase.rpc("compact_pubg_player_cache", {
      p_retention_days: PLAYER_CACHE_RETENTION_DAYS,
      p_apply: true,
      p_batch_limit: PLAYER_CACHE_BATCH_LIMIT,
      p_keep_recent: PLAYER_CACHE_KEEP_RECENT,
    });
    if (error) throw new Error("telemetry-cleanup-player-cache-failed");

    const result = data as {
      deleted_count?: unknown;
      remaining_count?: unknown;
    } | null;
    if (
      !result
      || !Number.isInteger(Number(result.deleted_count))
      || !Number.isInteger(Number(result.remaining_count))
    ) {
      throw new Error("telemetry-cleanup-player-cache-invalid-result");
    }

    // 더 지울 것이 없거나 이번 배치가 아무것도 지우지 못하면 종료한다.
    if (Number(result.deleted_count) === 0 || Number(result.remaining_count) === 0) return;
  }
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key}-missing`);
  return value;
}

function parseIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key}-invalid`);
  return value;
}


export function getTelemetryRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLEANUP_RETENTION_DAYS?.trim();
  if (!raw) return 90;
  const val = Number(raw);
  return Number.isInteger(val) && val > 0 ? val : 90;
}

export async function runTelemetryCleanupFromEnvironment(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const currentVersion = Math.floor(TELEMETRY_VERSION);
  const configuredTargetVersion = parseIntegerEnv("CLEANUP_TARGET_VERSION", 56);
  const targetVersion = Math.min(configuredTargetVersion, currentVersion - 1);
  const retentionDays = getTelemetryRetentionDays();
  if (retentionDays < 1) {
    throw new Error("telemetry-cleanup-invalid-environment-config");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const now = new Date();
  const result = await runTelemetryStorageCleanup({
    cutoff: new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000),
    targetVersion,
  }, createTelemetryCleanupDependencies(supabase));

  await cleanupOrphanedAnalysisRows(supabase);
  await cleanupInactivePlayerCache(supabase);
  console.info(JSON.stringify(result));
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runTelemetryCleanupFromEnvironment().catch((error: unknown) => {
    // 원인 없이 메시지만 남기면 운영에서 실패 이유를 추적할 수 없다.
    const detail = error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
    console.error(`텔레메트리 cleanup 작업이 실패했습니다. 원인: ${detail}`);
    process.exitCode = 1;
  });
}
