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
 * 분석 캐시(match_stats_raw, processed_match_telemetry 등)와 참가자 전적
 * (pubg_player_matches)은 용량 때문에 대상에서 제외합니다. PUBG의 14일 보존 범위를 넘긴 원본은 다시 받을 수
 * 없으므로 캐시를 모두 재생성할 수 있다고 가정하지 않습니다. global_benchmarks 는 복구 기준
 * 데이터이므로 별도로 보호합니다.
 *
 * 저장 위치는 R2 의 backups/ 경로이고 gzip 압축됩니다. R2 정리 작업이
 * 이 경로를 지우지 못하도록 r2DeletionGuard 가 보호합니다.
 *
 * 파일 구성:
 *   backups/core-<시각>.json                       manifest. 작은 테이블은 data 에 그대로 담는다.
 *   backups/core-<시각>/<테이블>/part-0001.json    PART_ROWS 를 넘는 테이블의 행 묶음.
 * manifest 는 모든 part 를 올린 뒤 마지막에 올리며, parts 에 각 part 의 키와 행 수를 적는다.
 * 테이블이나 part 하나라도 실패하면 complete=false 로 남기고 작업을 실패로 끝낸다.
 *
 * 사용법:
 *   npx tsx scripts/backup_core_tables.ts            # 백업 실행
 *   npx tsx scripts/backup_core_tables.ts --dry-run  # 대상만 확인
 */

import { appendFileSync } from "node:fs";
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
  "global_benchmarks",
  // 14일 만료 후 원본에서 복구할 수 없는 작은 성과 요약.
  // pubg_player_matches(150만 행 이상)는 읽는 데 17분 넘게 걸려 statement timeout 으로
  // 백업 전체가 부분 실패하고 같은 날 정리 작업이 멈췄다. 유료 플랜의 Supabase 일일 백업(7일)이 보호한다.
  "pubg_match_performance",
  // Past-patch samples can outlive recoverable source telemetry. Preserve them.
  "weapon_meta_match_samples",
  "weapon_meta_patches",
  "board_post_delete_credentials",
  "board_comment_delete_credentials",
] as const;

/** Supabase 는 한 번에 1000행까지 반환하므로 나눠 읽습니다. */
export const PAGE_SIZE = 1_000;

/**
 * 테이블별 기본키. 정렬과 다음 페이지 조건을 기본키 순서와 같게 맞춰야
 * 기본키 인덱스를 따라 읽는다. 다른 순서로 정렬하면 페이지마다 테이블 전체를
 * 정렬해 큰 테이블에서 statement timeout 이 난다.
 */
export const TABLE_KEYS: Record<(typeof BACKUP_TABLES)[number], readonly string[]> = {
  profiles: ["id"],
  map_markers: ["id"],
  pending_markers: ["id"],
  posts: ["id"],
  comments: ["id"],
  post_likes: ["id"],
  map_settings: ["map_id"],
  reports: ["id"],
  global_benchmarks: ["id"],
  pubg_match_performance: ["platform", "account_id", "match_id", "calculation_version", "result_version"],
  weapon_meta_match_samples: ["id"],
  weapon_meta_patches: ["version"],
  board_post_delete_credentials: ["post_id"],
  board_comment_delete_credentials: ["comment_id"],
};

/** 한 테이블에서 읽을 최대 행수. 예상보다 훨씬 큰 테이블을 만나면 완전 백업으로 보고하지 않는다. */
export const MAX_ROWS_PER_TABLE = 5_000_000;

/** 이 행 수를 넘는 테이블은 part 파일로 나눠 올려 메모리와 단일 객체 크기를 제한한다. */
export const PART_ROWS = 50_000;

/** 한 요청의 최대 대기 시간. */
export const REQUEST_TIMEOUT_MS = 30_000;

export type TableBackupResult = {
  table: string;
  rowCount: number;
  skipped: boolean;
  error: string | null;
  parts?: number;
};

export type BackupPart = { key: string; rows: number };

export type BackupResult = {
  key: string | null;
  createdAt: string;
  tables: TableBackupResult[];
  totalRows: number;
  dryRun: boolean;
  complete: boolean;
};

type TableReader = Pick<SupabaseClient, "from">;
type Row = Record<string, unknown>;
type PageResult = { data: Row[]; error: string | null };

function keysFor(table: string): readonly string[] {
  return TABLE_KEYS[table as keyof typeof TABLE_KEYS] ?? ["id"];
}

/**
 * 기본키 순서로 last 다음 행을 limit 개까지 읽는다.
 *
 * 복합키 (k1, k2, k3) 에서 last 다음 행은 깊은 단계부터 차례로 찾는다.
 *   k1 = v1 and k2 = v2 and k3 > v3  → 같은 묶음의 나머지
 *   k1 = v1 and k2 > v2              → 다음 k2 묶음
 *   k1 > v1                          → 다음 k1 묶음
 * 각 조건이 기본키 인덱스의 앞 열에 걸리므로 OFFSET 처럼 앞부분을 다시 훑지 않는다.
 */
type KeysetPage = PageResult & { done: boolean };

/**
 * 페이지 한 번의 일시적 실패(statement timeout, 요청 중단, 네트워크)를 다시 시도하는 대기 시간.
 * 153만 행 전적은 17분 넘게 읽는데, 페이지 하나가 DB 부하로 8초 제한에 걸렸다고 전체 백업을 버리면
 * 같은 날 모든 정리 작업이 멈춘다. 읽기는 멱등이므로 같은 페이지를 다시 읽어도 행이 겹치거나 빠지지 않는다.
 * 테스트가 대기를 없앨 수 있도록 객체로 노출한다.
 */
export const readRetry = { delaysMs: [1_000, 3_000, 9_000] as number[] };

/** 다시 시도할 만한 일시적 오류인지. 권한 없음, 테이블 없음 같은 영구 오류는 포함하지 않는다. */
function isTransientReadError(message: string): boolean {
  return message === "backup-table-read-failed" || /statement timeout|canceling statement/i.test(message);
}

async function runQuery(query: ReturnType<ReturnType<TableReader["from"]>["select"]>, limit: number): Promise<PageResult> {
  let attempt = 0;
  while (true) {
    let failure: string;
    try {
      const result = await query.limit(limit).abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      if (!result.error) return { data: (result.data ?? []) as Row[], error: null };
      failure = result.error.message;
    } catch {
      failure = "backup-table-read-failed";
    }
    const delay = readRetry.delaysMs[attempt];
    if (delay === undefined || !isTransientReadError(failure)) return { data: [], error: failure };
    attempt += 1;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * 기본키 순서로 last 다음 행을 limit 개까지 읽는다. done 은 테이블 끝까지 읽었는지 나타낸다.
 *
 * 복합키 (k1, k2, k3) 의 다음 행을 깊은 단계부터 차례로 찾는다.
 *   k1 = v1 and k2 = v2 and k3 > v3  → 같은 묶음의 나머지
 *   k1 = v1 and k2 > v2              → 다음 k2 묶음
 *   k1 > v1                          → 다음 k1 묶음
 * 각 조건이 기본키 인덱스의 앞 열에 걸리므로 OFFSET 처럼 앞부분을 다시 훑지 않는다.
 */
export async function readKeysetPage(
  supabase: TableReader,
  table: string,
  last: Row | null,
  limit: number,
): Promise<KeysetPage> {
  const keys = keysFor(table);
  const order = <T extends { order: (column: string) => T }>(query: T): T => keys.reduce((q, key) => q.order(key), query);

  const rows: Row[] = [];
  const depths = last ? keys.map((_, index) => keys.length - 1 - index) : [-1];
  for (const depth of depths) {
    if (rows.length >= limit) break;
    let query = supabase.from(table).select("*");
    if (last && depth >= 0) {
      for (const key of keys.slice(0, depth)) query = query.eq(key, last[key]);
      query = query.gt(keys[depth], last[keys[depth]]);
    }
    const result = await runQuery(order(query), limit - rows.length);
    rows.push(...result.data);
    if (result.error) return { data: rows, error: result.error, done: false };
  }
  return { data: rows, error: null, done: rows.length < limit };
}

/**
 * 한 테이블 전체를 페이지 단위로 읽어 onPage 에 넘긴다.
 *
 * 테이블이 없거나 권한이 없으면 예외를 던지지 않고 skipped 로 보고합니다.
 * 한 테이블 실패가 전체 백업을 막으면 안 됩니다.
 */
export async function streamTableRows(
  supabase: TableReader,
  table: string,
  onPage: (rows: Row[]) => Promise<void> | void,
  options: { maxRows?: number } = {},
): Promise<{ rowCount: number; skipped: boolean; error: string | null }> {
  const maxRows = options.maxRows ?? MAX_ROWS_PER_TABLE;
  let rowCount = 0;
  let last: Row | null = null;

  while (true) {
    const remaining = maxRows - rowCount;
    // 한도에 닿으면 한 행만 더 읽어 한도를 넘는 테이블인지 확인한다.
    const { data, error, done } = await readKeysetPage(
      supabase, table, last, remaining > 0 ? Math.min(PAGE_SIZE, remaining) : 1,
    );
    if (remaining <= 0) {
      if (error) return { rowCount, skipped: false, error };
      return { rowCount, skipped: false, error: data.length > 0 ? "backup-row-limit-exceeded" : null };
    }
    if (data.length > 0) {
      await onPage(data);
      rowCount += data.length;
      last = data[data.length - 1];
    }
    // 첫 페이지부터 실패하면 테이블 자체를 읽을 수 없는 상황이다.
    if (error) return { rowCount, skipped: rowCount === 0, error };
    if (done) break;
  }

  return { rowCount, skipped: false, error: null };
}

/** 한 테이블 전체를 메모리로 읽습니다. 작은 테이블과 검증용입니다. */
export async function readTableRows(
  supabase: TableReader,
  table: string,
  options: { maxRows?: number } = {},
): Promise<{ rows: unknown[]; skipped: boolean; error: string | null }> {
  const rows: unknown[] = [];
  const result = await streamTableRows(supabase, table, (page) => { rows.push(...page); }, options);
  return { rows: result.skipped ? [] : rows, skipped: result.skipped, error: result.error };
}

/** Keep a partial recovery file, but never report it as a complete backup. */
export function assertBackupComplete(result: BackupResult): void {
  if (!result.complete) {
    throw new Error(`backup-core-tables-incomplete: ${result.tables
      .filter(table => table.skipped || table.error).map(table => table.table).join(",")}`);
  }
}

/** 백업 파일 키를 만듭니다. 날짜순으로 정렬되도록 ISO 형식을 씁니다. */
export function buildBackupKey(createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  return `backups/core-${stamp}.json`;
}

/** manifest 키 옆에 테이블별 part 키를 만듭니다. */
export function buildPartKey(manifestKey: string, table: string, index: number): string {
  return `${manifestKey.replace(/\.json$/, "")}/${table}/part-${String(index).padStart(4, "0")}.json`;
}

export type BackupManifest = {
  formatVersion?: number;
  createdAt?: string;
  complete: boolean;
  tables: TableBackupResult[];
  data: Record<string, unknown[]>;
  parts?: Record<string, BackupPart[]>;
};

/**
 * manifest 와 part 목록을 따라 백업 행을 테이블별로 다시 조립한다.
 *
 * 복원 전에 다음을 모두 확인하고 하나라도 어긋나면 예외를 던진다.
 *   - manifest 가 완전 백업이고 모든 백업 대상 테이블을 정확히 한 번씩 담는지
 *   - part 가 manifest 키 아래의 예상 경로·순서이고 실제로 내려받아지는지
 *   - part 행 수, 테이블 총 행 수가 manifest 기록과 같은지
 * 부분 백업이나 누락된 part 로 조용히 복원하지 않기 위함이다.
 */
export async function restoreBackupRows(
  manifestKey: string,
  manifest: BackupManifest,
  download: (key: string) => Promise<string | null>,
  expectedTables: readonly string[] = BACKUP_TABLES,
): Promise<Record<string, unknown[]>> {
  if (manifest.complete !== true) throw new Error("backup-restore-incomplete-manifest");
  const listed = manifest.tables.map(table => table.table);
  if (new Set(listed).size !== listed.length
    || [...listed].sort().join(",") !== [...expectedTables].sort().join(",")) {
    throw new Error("backup-restore-table-list-mismatch");
  }

  const restored: Record<string, unknown[]> = {};
  for (const metadata of manifest.tables) {
    const { table } = metadata;
    if (metadata.skipped || metadata.error) throw new Error(`backup-restore-incomplete-table: ${table}`);
    const parts = manifest.parts?.[table];
    const inline = manifest.data?.[table];

    let rows: unknown[];
    if (parts && parts.length > 0) {
      if (inline !== undefined) throw new Error(`backup-restore-ambiguous-table: ${table}`);
      if (metadata.parts !== parts.length) throw new Error(`backup-restore-part-count-mismatch: ${table}`);
      rows = [];
      for (const [index, part] of parts.entries()) {
        if (part.key !== buildPartKey(manifestKey, table, index + 1)) {
          throw new Error(`backup-restore-part-key-mismatch: ${part.key}`);
        }
        const body = await download(part.key);
        if (body === null) throw new Error(`backup-restore-part-missing: ${part.key}`);
        const partRows: unknown = JSON.parse(body);
        if (!Array.isArray(partRows) || partRows.length !== part.rows) {
          throw new Error(`backup-restore-part-row-mismatch: ${part.key}`);
        }
        rows.push(...partRows);
      }
    } else {
      if (!Array.isArray(inline)) throw new Error(`backup-restore-table-missing: ${table}`);
      rows = inline;
    }
    if (rows.length !== metadata.rowCount) throw new Error(`backup-restore-row-count-mismatch: ${table}`);
    restored[table] = rows;
  }
  return restored;
}

export async function backupCoreTables(
  supabase: TableReader,
  upload: (key: string, body: string) => Promise<void>,
  options: { dryRun?: boolean; now?: Date; write?: (message: string) => void; partRows?: number } = {},
): Promise<BackupResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const write = options.write ?? ((message: string) => console.info(message));
  const partRows = options.partRows ?? PART_ROWS;
  const key = buildBackupKey(now);

  const tables: TableBackupResult[] = [];
  const payload: Record<string, unknown[]> = {};
  const parts: Record<string, BackupPart[]> = {};
  let totalRows = 0;

  for (const table of BACKUP_TABLES) {
    const buffer: Row[] = [];
    const tableParts: BackupPart[] = [];
    let uploadError: string | null = null;

    const flush = async (rows: Row[]) => {
      const partKey = buildPartKey(key, table, tableParts.length + 1);
      await upload(partKey, JSON.stringify(rows));
      tableParts.push({ key: partKey, rows: rows.length });
    };

    const read = await streamTableRows(supabase, table, async (page) => {
      // dry-run 은 행 수만 세고 행을 보관하지 않는다.
      if (dryRun || uploadError) return;
      buffer.push(...page);
      if (buffer.length >= partRows) {
        const rows = buffer.splice(0, partRows);
        try {
          await flush(rows);
        } catch {
          uploadError = "backup-part-upload-failed";
        }
      }
    });

    const { rowCount, skipped, error: readError } = read;
    const limitError = rowCount > MAX_ROWS_PER_TABLE ? "backup-row-limit-exceeded" : null;

    // 이미 part 로 나눈 테이블은 남은 행도 part 로 올린다. 작은 테이블은 manifest 에 그대로 담는다.
    let inline: Row[] = buffer;
    if (!dryRun && !uploadError && tableParts.length > 0) {
      if (buffer.length > 0) {
        try {
          await flush(buffer);
        } catch {
          uploadError = "backup-part-upload-failed";
        }
      }
      inline = [];
    }

    const error = readError ?? limitError ?? uploadError;
    tables.push({
      table,
      rowCount,
      skipped,
      error,
      ...(tableParts.length > 0 ? { parts: tableParts.length } : {}),
    });
    if (!skipped) {
      if (tableParts.length > 0) parts[table] = tableParts;
      else if (!dryRun) payload[table] = inline;
      totalRows += rowCount;
    }
    write(`${table}: ${skipped ? "건너뜀" : `${rowCount.toLocaleString()}행`}`
      + `${tableParts.length > 0 ? ` (part ${tableParts.length}개)` : ""}${error ? ` (${error})` : ""}`);
  }

  const complete = tables.every(table => !table.skipped && !table.error);
  if (dryRun) {
    write(`dry-run 이므로 업로드하지 않았습니다. 총 ${totalRows.toLocaleString()}행이 대상입니다.`);
    return { key: null, createdAt: now.toISOString(), tables, totalRows, dryRun: true, complete };
  }

  // 백업할 것이 없으면 빈 파일을 만들지 않는다. 조회가 전부 실패한 상황일 수 있다.
  if (totalRows === 0) {
    throw new Error("backup-core-tables-no-rows");
  }

  // manifest 는 part 를 모두 올린 뒤 마지막에 올린다. 중간에 끊기면 manifest 가 없어 완전 백업으로 보이지 않는다.
  await upload(key, JSON.stringify({
    formatVersion: 2,
    createdAt: now.toISOString(),
    complete,
    tables,
    data: payload,
    parts,
  }));

  write(`${complete ? "백업 완료" : "부분 백업 저장 · 누락 테이블 확인 필요"}: ${key} (${totalRows.toLocaleString()}행)`);
  return { key, createdAt: now.toISOString(), tables, totalRows, dryRun: false, complete };
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

  const result = await backupCoreTables(supabase, upload, { dryRun });
  // GitHub Actions 다음 단계가 방금 올린 manifest 를 복원 검증할 수 있게 키를 넘긴다.
  if (result.key && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${result.key}\n`);
  assertBackupComplete(result);
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
