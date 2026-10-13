/**
 * @fileoverview R2 에 올라간 핵심 테이블 백업을 manifest 와 part 목록대로 내려받아 복원 가능성을 확인합니다.
 *
 * R2 를 읽기만 합니다. 행 내용은 출력하지 않고 테이블별 행 수만 출력합니다.
 * part 누락, 행 수 불일치, 미완료 manifest 는 실패로 끝납니다.
 *
 * 사용법:
 *   npx tsx scripts/verify_core_backup.ts --key backups/core-2026-10-14T00-00-00-000Z.json
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { restoreBackupRows, type BackupManifest } from "./backup_core_tables";

export async function verifyCoreBackup(
  manifestKey: string,
  download: (key: string) => Promise<string | null>,
  write: (message: string) => void = message => console.info(message),
): Promise<Record<string, number>> {
  const body = await download(manifestKey);
  if (body === null) throw new Error(`backup-restore-manifest-missing: ${manifestKey}`);
  const manifest = JSON.parse(body) as BackupManifest;
  const restored = await restoreBackupRows(manifestKey, manifest, download);
  const counts = Object.fromEntries(Object.entries(restored).map(([table, rows]) => [table, rows.length]));
  for (const [table, count] of Object.entries(counts)) {
    const parts = manifest.parts?.[table]?.length ?? 0;
    write(`${table}: ${count.toLocaleString()}행${parts > 0 ? ` (part ${parts}개)` : ""}`);
  }
  write(`복원 검증 통과: ${manifestKey}`);
  return counts;
}

async function runFromEnvironment(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  const index = process.argv.indexOf("--key");
  const key = index >= 0 ? process.argv[index + 1] : undefined;
  if (!key || !key.startsWith("backups/core-") || !key.endsWith(".json")) {
    throw new Error("verify-core-backup-key-required: --key backups/core-<시각>.json");
  }
  const { downloadFromR2, isR2Configured } = await import("../lib/pubg-analysis/r2Service");
  if (!isR2Configured()) throw new Error("verify-core-backup-r2-not-configured");
  await verifyCoreBackup(key, downloadFromR2);
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  void runFromEnvironment().catch((error: unknown) => {
    console.error(`핵심 테이블 백업 복원 검증 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
