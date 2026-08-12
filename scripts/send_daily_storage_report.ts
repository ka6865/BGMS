import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { getR2BucketUsage } from "../lib/pubg-analysis/r2Service";
import { getSupabaseDatabaseLimitBytes, R2_FREE_STORAGE_LIMIT_BYTES } from "../lib/admin-agent/storage-limits";
import { buildDailyStorageReport } from "../lib/admin-agent/dailyStorageReport";

function asCount(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!webhookUrl || !supabaseUrl || !serviceRoleKey) {
    throw new Error("daily-storage-report-required-environment-missing");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const [databaseResult, processedResult, masterResult, benchmarkResult, r2Usage] = await Promise.all([
    supabase.rpc("get_db_size"),
    supabase.from("processed_match_telemetry").select("*", { count: "exact", head: true }),
    supabase.from("match_master_telemetry").select("*", { count: "exact", head: true }),
    supabase.from("global_benchmarks").select("*", { count: "exact", head: true }),
    getR2BucketUsage(),
  ]);
  if (databaseResult.error) throw new Error("daily-storage-report-db-size-failed");
  if (processedResult.error || masterResult.error || benchmarkResult.error) {
    throw new Error("daily-storage-report-match-count-failed");
  }
  if (!r2Usage.configured || r2Usage.truncated) {
    throw new Error("daily-storage-report-r2-usage-unavailable");
  }

  const message = buildDailyStorageReport({
    databaseBytes: Number(databaseResult.data),
    databaseLimitBytes: getSupabaseDatabaseLimitBytes(),
    r2Bytes: r2Usage.totalSizeBytes,
    r2LimitBytes: R2_FREE_STORAGE_LIMIT_BYTES,
    processedTelemetryRows: processedResult.count ?? 0,
    masterTelemetryRows: masterResult.count ?? 0,
    benchmarkRows: benchmarkResult.count ?? 0,
    scraper: {
      succeeded: asCount(process.env.SCRAPER_SUCCEEDED),
      skipped: asCount(process.env.SCRAPER_SKIPPED),
      failed: asCount(process.env.SCRAPER_FAILED),
    },
    maintenanceStatus: process.env.MAINTENANCE_STATUS || "unknown",
    runUrl: process.env.RUN_URL || "(실행 URL 없음)",
  });

  await axios.post(webhookUrl, { content: message });
  console.log("일일 DB/R2 점검 보고를 Discord에 전송했습니다.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
