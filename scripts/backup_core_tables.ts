/**
 * @fileoverview 복구 불가능한 핵심 테이블을 R2 로 백업합니다.
 *
 * 배경: Supabase 무료 플랜은 자동 백업을 제공하지 않습니다. 사고나 실수로
 * 데이터가 사라지면 되돌릴 방법이 없습니다. 2026-08-01 점검에서 확인한
 * 복구 불가 자산 규모입니다.
 *
 *   map_markers   549건   사이트의 실질 자산(제보 누적)
 *   profiles      160건   회원 정보
 *   posts          17건
 *   comments        4건
 *   pending_markers 2건
 *
 * 분석 캐시(match_stats_raw, processed_match_telemetry 등)는 PUBG API 로
 * 재생성 가능하므로 대상이 아닙니다. 용량이 크고 백업 가치가 낮습니다.
 *
 * 저장 위치는 R2 의 backups/ 경로이고 gzip 압축됩니다. R2 정리 작업이
 * 이 경로를 지우지 못하도록 r2DeletionGuard 가 보호합니다.
 *
 * 사용법:
 *   npx tsx scripts/backup_core_tables.ts            # 백업 실행
 *   npx tsx scripts/backup_core_tables.ts --dry-run  # 대상만 확인
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

/** 백업 대상. 사라지면 복구할 수 없는 사용자 생성 데이터만 넣습니다. */
export const BACKUP_TABLES = [
  "profiles",
  "map_markers",
  "pending_markers",
  "posts",
  "comments",
  "post_likes",
  "map_settings",
  "reports",
] as const;

/** Supabase 는 한 번에 1000행까지 반환하므로 범위로 나눠 읽습니다. */
export const PAGE_SIZE = 1_000;

/** 한 테이블에서 읽을 최대 행수. 예상보다 큰 테이블을 만나면 중단합니다. */
export const MAX_ROWS_PER_TABLE = 200_000;

/** 보관 기간. 이보다 오래된 백업은 정리 대상으로 보고합니다. */
export const BACKUP_RETENTION_DAYS = 30;

export type TableBackupResult = {
  table: string;
  rowCount: number;
  skipped: boolean;
  error: string | null;
};

export type BackupResult = {
  key: string | null;
  createdAt: string;
  tables: TableBackupResult[];
  totalRows: number;
  dryRun: boolean;
};

type TableReader = Pick<SupabaseClient, "from">;

/**
 * 한 테이블 전체를 읽습니다.
 *
 * 테이블이 없거나 권한이 없으면 예외를 던지지 않고 skipped 로 보고합니다.
 * 한 테이블 실패가 전체 백업을 막으면 안 됩니다.
 */
export async function readTableRows(
  supabase: TableReader,
  table: string,
): Promise<{ rows: unknown[]; skipped: boolean; error: string | null }> {
  const rows: unknown[] = [];

  for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      // 첫 페이지부터 실패하면 테이블 자체를 읽을 수 없는 상황이다.
      if (from === 0) return { rows: [], skipped: true, error: error.message };
      return { rows, skipped: false, error: error.message };
    }
    if (!data || data.length === 0) break;

    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  return { rows, skipped: false, error: null };
}

/** 백업 파일 키를 만듭니다. 날짜순으로 정렬되도록 ISO 형식을 씁니다. */
export function buildBackupKey(createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  return `backups/core-${stamp}.json`;
}

export async function backupCoreTables(
  supabase: TableReader,
  upload: (key: string, body: string) => Promise<void>,
  options: { dryRun?: boolean; now?: Date; write?: (message: string) => void } = {},
): Promise<BackupResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const write = options.write ?? ((message: string) => console.info(message));

  const tables: TableBackupResult[] = [];
  const payload: Record<string, unknown[]> = {};
  let totalRows = 0;

  for (const table of BACKUP_TABLES) {
    const { rows, skipped, error } = await readTableRows(supabase, table);
    tables.push({ table, rowCount: rows.length, skipped, error });
    if (!skipped) {
      payload[table] = rows;
      totalRows += rows.length;
    }
    write(`${table}: ${skipped ? "건너뜀" : `${rows.length.toLocaleString()}행`}${error ? ` (${error})` : ""}`);
  }

  if (dryRun) {
    write(`dry-run 이므로 업로드하지 않았습니다. 총 ${totalRows.toLocaleString()}행이 대상입니다.`);
    return { key: null, createdAt: now.toISOString(), tables, totalRows, dryRun: true };
  }

  // 백업할 것이 없으면 빈 파일을 만들지 않는다. 조회가 전부 실패한 상황일 수 있다.
  if (totalRows === 0) {
    throw new Error("backup-core-tables-no-rows");
  }

  const key = buildBackupKey(now);
  await upload(key, JSON.stringify({
    createdAt: now.toISOString(),
    tables: tables.map(({ table, rowCount, skipped }) => ({ table, rowCount, skipped })),
    data: payload,
  }));

  write(`백업 완료: ${key} (${totalRows.toLocaleString()}행)`);
  return { key, createdAt: now.toISOString(), tables, totalRows, dryRun: false };
}

async function runFromEnvironment(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("backup-core-tables-credentials-missing");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const dryRun = process.argv.includes("--dry-run");
  // R2 모듈은 실제 업로드 시점에만 불러온다. dry-run 은 자격 증명이 없어도 돌아간다.
  const upload = dryRun
    ? async () => undefined
    : async (key: string, body: string) => {
      const { uploadToR2, isR2Configured } = await import("../lib/pubg-analysis/r2Service");
      if (!isR2Configured()) throw new Error("backup-core-tables-r2-not-configured");
      await uploadToR2(key, body, "application/json");
    };

  await backupCoreTables(supabase, upload, { dryRun });
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runFromEnvironment().catch((error: unknown) => {
    const detail = error instanceof Error
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
    console.error(`핵심 테이블 백업 실패: ${detail}`);
    process.exitCode = 1;
  });
}
