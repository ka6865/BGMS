import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  auditProcessedTelemetryIdentity,
  deleteProcessedTelemetryIdentityTargets
} from "../lib/admin-agent/data-quality";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

function hasApplyFlag(): boolean {
  return process.argv.includes("--apply");
}

function hasJsonFlag(): boolean {
  return process.argv.includes("--json");
}

function getNumberArg(name: string): number | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function createSupabaseServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

async function main() {
  const apply = hasApplyFlag();
  const json = hasJsonFlag();
  const supabase = createSupabaseServiceClient();
  const audit = await auditProcessedTelemetryIdentity(supabase, {
    recentDays: getNumberArg("--recent-days"),
    maxRows: getNumberArg("--max-rows"),
    pageSize: getNumberArg("--page-size") || 100,
    sampleLimit: getNumberArg("--sample-limit") || 10,
    targetLimit: getNumberArg("--target-limit") || 1000
  });

  if (json) {
    console.info(JSON.stringify(audit, null, 2));
  }
  writeStepOutputs({ status: "success", mismatch_count: String(audit.mismatchCount) });
  if (audit.mismatchCount > 0) {
    console.info(`::warning title=분석 데이터 식별자 불일치::processed_match_telemetry 최근 행에서 식별자 불일치 ${audit.mismatchCount}건을 찾았습니다. Admin Agent 데이터 품질 승인 큐를 확인하세요.`);
  }

  console.info("\n================ PROCESSED TELEMETRY IDENTITY AUDIT ================");
  console.info(`mode: ${apply ? "apply" : "dry-run"}`);
  console.info(`recent days: ${audit.recentDays || "all"}`);
  console.info(`scanned rows: ${audit.scannedRows}${audit.truncated ? " (truncated)" : ""}`);
  console.info(`mismatch rows: ${audit.mismatchCount}`);
  console.info(`deletion candidates: ${audit.deletionCandidateCount}`);
  console.info(`missing platform column rows: ${audit.missingPlatformColumnRows}`);
  console.info("samples:");
  console.info(JSON.stringify(audit.samples, null, 2));

  if (!apply || audit.deletionTargets.length === 0) {
    console.info("삭제는 실행하지 않았습니다. 실제 삭제는 --apply 옵션이 있을 때만 수행합니다.");
    console.info("====================================================================\n");
    return;
  }

  if (audit.missingPlatformColumnRows > 0) {
    throw new Error("--apply 삭제는 platform 컬럼 마이그레이션 적용 후에만 실행할 수 있습니다.");
  }

  const result = await deleteProcessedTelemetryIdentityTargets(supabase, audit.deletionTargets);

  console.info(`delete requested: ${result.requested}`);
  console.info(`deleted rows: ${result.deleted}`);
  console.info(`skipped rows: ${result.skipped}`);
  console.info(`failed rows: ${result.failed}`);
  console.info(JSON.stringify(result.details.slice(0, 20), null, 2));
  console.info("====================================================================\n");
}

/** GitHub Actions에서만 다음 단계(일일 보고)가 읽을 결과를 남긴다. */
function writeStepOutputs(outputs: Record<string, string>) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

main().catch(error => {
  console.error("[processed telemetry identity audit] 실패:", error);
  // 일일 작업은 이 단계를 continue-on-error로 두므로 경고 주석과 출력값으로 실패를 드러낸다.
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  console.info(`::warning title=분석 데이터 품질 감사 실패::processed_match_telemetry 식별자 감사가 실패했습니다${code}. 로그를 확인하세요.`);
  writeStepOutputs({ status: "failure" });
  process.exit(1);
});
