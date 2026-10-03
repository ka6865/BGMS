import axios from "axios";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getR2BucketUsage } from "../lib/pubg-analysis/r2Service";
import { getSupabaseDatabaseLimitBytes, R2_FREE_STORAGE_LIMIT_BYTES } from "../lib/admin-agent/storage-limits";
import { buildDailyStorageReport, requireCompleteDailyReportR2Usage } from "../lib/admin-agent/dailyStorageReport";

export async function deliverDailyStorageReport(webhookUrl: string, message: string) {
  let deliveryUrl: URL;
  try {
    deliveryUrl = new URL(webhookUrl);
  } catch {
    throw new Error("daily-storage-report-discord-url-invalid");
  }
  if (deliveryUrl.protocol !== "https:") throw new Error("daily-storage-report-discord-url-invalid");
  deliveryUrl.searchParams.set("wait", "true");
  let response;
  try {
    response = await axios.post(deliveryUrl.toString(), { content: message, allowed_mentions: { parse: [] } }, {
      timeout: 8_000,
      validateStatus: () => true,
    });
  } catch (error: any) {
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || /timeout|timed out/i.test(String(error?.message || ""))) {
      throw new Error("daily-storage-report-discord-timeout");
    }
    throw new Error("daily-storage-report-discord-request-failed");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`daily-storage-report-discord-http-${response.status}`);
  }
  if (typeof response.data?.id !== "string" || !response.data.id) {
    throw new Error("daily-storage-report-discord-receipt-missing");
  }
  return { status: response.status, messageId: response.data.id };
}

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
  const r2Bytes = requireCompleteDailyReportR2Usage(r2Usage);

  const message = buildDailyStorageReport({
    databaseBytes: Number(databaseResult.data),
    databaseLimitBytes: getSupabaseDatabaseLimitBytes(),
    r2Bytes,
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

  const receipt = await deliverDailyStorageReport(webhookUrl, message);
  console.log("일일 DB/R2 점검 보고를 Discord에 전송했습니다.", { status: receipt.status, messageId: receipt.messageId });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
