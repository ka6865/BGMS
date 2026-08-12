import { describe, expect, it } from "vitest";
import { buildDailyStorageReport } from "@/lib/admin-agent/dailyStorageReport";

describe("daily storage report", () => {
  it("formats fixed operational numbers without AI-generated text", () => {
    expect(buildDailyStorageReport({
      databaseBytes: 310 * 1024 * 1024,
      databaseLimitBytes: 8 * 1024 * 1024 * 1024,
      r2Bytes: 2700 * 1024 * 1024,
      r2LimitBytes: 10 * 1024 * 1024 * 1024,
      processedTelemetryRows: 2049,
      masterTelemetryRows: 1772,
      benchmarkRows: 5544,
      scraper: { succeeded: 15, skipped: 3, failed: 1 },
      maintenanceStatus: "success",
      runUrl: "https://github.com/ka6865/BGMS/actions/runs/123",
    })).toContain("DB: 310 MB / 8 GB (3.8%)");
    expect(buildDailyStorageReport({
      databaseBytes: 310 * 1024 * 1024,
      databaseLimitBytes: 8 * 1024 * 1024 * 1024,
      r2Bytes: 2700 * 1024 * 1024,
      r2LimitBytes: 10 * 1024 * 1024 * 1024,
      processedTelemetryRows: 2049,
      masterTelemetryRows: 1772,
      benchmarkRows: 5544,
      scraper: { succeeded: 15, skipped: 3, failed: 1 },
      maintenanceStatus: "success",
      runUrl: "https://github.com/ka6865/BGMS/actions/runs/123",
    })).toContain("수집: 성공 15 · 스킵 3 · 실패 1");
  });
});
