/**
 * @fileoverview 운영 스키마 덤프를 검증용 baseline 으로 변환합니다.
 *
 * `supabase db dump --linked` 결과에는 순수 PostgreSQL 에 없는 Supabase 플랫폼
 * 전용 요소가 섞여 있습니다. 이를 손으로 지우면 갱신할 때마다 실수가 나므로
 * 변환 규칙을 코드로 고정합니다.
 *
 * 사용법:
 *   supabase db dump --linked -f tmp/prod_schema.sql
 *   npm run db:baseline:refresh
 *   npm run verify:baseline
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DUMP_PATH = "tmp/prod_schema.sql";
export const BASELINE_PATH = "tests/fixtures/migration-check/baseline-schema.sql";

/**
 * 제거 대상 패턴.
 *
 * supabase_vault: 플랫폼 전용 확장이며 이 저장소 코드가 사용하지 않는다.
 * supabase_realtime: publication 을 Supabase 가 관리한다.
 */
export const STRIPPED_PATTERNS = [
  /supabase_vault/,
  /supabase_realtime/,
] as const;

const HEADER = `-- 운영 스키마 baseline. \`supabase db dump --linked\` 결과를 검증용으로 조정한 사본입니다.
--
-- 이 파일은 scripts/refresh_baseline_schema.ts 가 생성합니다. 직접 편집하지 마세요.
--
-- 배경: 저장소의 migration 만으로는 빈 DB 를 재현할 수 없습니다. 2026-08-01 실측에서
-- 58개 중 26개가 실패하고 테이블이 32개만 생겼습니다(운영은 60개). posts, comments,
-- profiles, map_markers, pubg_player_cache 등 핵심 테이블이 Supabase 콘솔에서 직접
-- 생성되어 CREATE TABLE 이력이 없기 때문입니다.
--
-- 따라서 재해 복구 경로는 migration 재생이 아니라 이 baseline 입니다.
--
-- 원본 대비 조정한 것:
--   - extensions / vault 스키마를 먼저 생성 (덤프가 이 경로를 참조)
--   - supabase_vault 확장 제거 (플랫폼 전용)
--   - supabase_realtime publication 관련 구문 제거 (플랫폼이 관리)
--
-- 갱신 방법:
--   supabase db dump --linked -f tmp/prod_schema.sql
--   npm run db:baseline:refresh
--   npm run verify:baseline
--
-- 주의: 스키마 전용입니다. 데이터 백업은 scripts/backup_core_tables.ts 가 담당합니다.

-- Supabase 가 확장을 두는 스키마.
CREATE SCHEMA IF NOT EXISTS "extensions";
CREATE SCHEMA IF NOT EXISTS "vault";

`;

export type RefreshResult = {
  inputLines: number;
  outputLines: number;
  strippedLines: number;
  tableCount: number;
};

/** 덤프 본문을 baseline 본문으로 변환합니다. */
export function transformDump(dump: string): { content: string; result: Omit<RefreshResult, "inputLines" | "outputLines"> } {
  const lines = dump.split(/\r?\n/);
  const kept: string[] = [];
  let strippedLines = 0;

  for (const line of lines) {
    if (STRIPPED_PATTERNS.some((pattern) => pattern.test(line))) {
      strippedLines += 1;
      continue;
    }
    kept.push(line);
  }

  const content = HEADER + kept.join("\n");
  const tableCount = (content.match(/^CREATE TABLE/gm) ?? []).length;

  return { content, result: { strippedLines, tableCount } };
}

export function refreshBaseline(
  dumpPath = DUMP_PATH,
  baselinePath = BASELINE_PATH,
): RefreshResult {
  if (!existsSync(dumpPath)) {
    throw new Error(`baseline-refresh-dump-missing: ${dumpPath}`);
  }

  const dump = readFileSync(dumpPath, "utf8");
  const { content, result } = transformDump(dump);

  // 덤프가 비었거나 잘렸으면 기존 baseline 을 망가진 파일로 덮지 않는다.
  if (result.tableCount < 40) {
    throw new Error(
      `baseline-refresh-dump-too-small: 테이블 ${result.tableCount}개만 발견됐습니다. 덤프가 잘렸는지 확인하세요.`,
    );
  }

  writeFileSync(baselinePath, content, "utf8");

  return {
    inputLines: dump.split(/\r?\n/).length,
    outputLines: content.split(/\r?\n/).length,
    ...result,
  };
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  try {
    const result = refreshBaseline();
    console.info(
      `baseline 갱신 완료: 테이블 ${result.tableCount}개, ${result.outputLines}행`
      + ` (플랫폼 전용 ${result.strippedLines}행 제거)`,
    );
    console.info("다음: npm run verify:baseline");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`baseline 갱신 실패: ${detail}`);
    process.exitCode = 1;
  }
}
