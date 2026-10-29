import { describe, expect, it } from "vitest";
import { buildDailyReportStepWarnings, buildDailyStorageReport } from "@/lib/admin-agent/dailyStorageReport";

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
    })).toContain("수집 단계 요약(현재까지): 성공 15 · 스킵 3 · 실패 1");
    const report = buildDailyStorageReport({
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
    });
    expect(report).toContain("전체 유지보수와 매치 수집이 끝나기 전에 생성된 중간 보고입니다.");
    expect(report).toContain("뒤이어 실행되는 전적 수집·정리 결과는 아직 포함되지 않았습니다.");
  });

  it("continue-on-error 단계의 실패와 식별자 불일치를 보고에 드러낸다", () => {
    expect(buildDailyReportStepWarnings({ DATA_QUALITY_AUDIT_OUTCOME: "success", DATA_QUALITY_MISMATCH_COUNT: "0" })).toEqual([]);
    expect(buildDailyReportStepWarnings({})).toEqual([]);
    const warnings = buildDailyReportStepWarnings({ DATA_QUALITY_AUDIT_OUTCOME: "failure", DATA_QUALITY_MISMATCH_COUNT: "" });
    expect(warnings).toEqual([expect.stringContaining("분석 데이터 품질 감사 실패")]);
    expect(buildDailyReportStepWarnings({ DATA_QUALITY_AUDIT_OUTCOME: "success", DATA_QUALITY_MISMATCH_COUNT: "3" }))
      .toEqual([expect.stringContaining("식별자 불일치 3건")]);

    const report = buildDailyStorageReport({
      databaseBytes: 1,
      databaseLimitBytes: 8 * 1024 * 1024 * 1024,
      r2Bytes: 1,
      r2LimitBytes: 10 * 1024 * 1024 * 1024,
      processedTelemetryRows: 0,
      masterTelemetryRows: 0,
      benchmarkRows: 0,
      scraper: null,
      maintenanceStatus: "success",
      runUrl: "https://example.invalid/run",
      stepWarnings: warnings,
    });
    expect(report).toContain("주의: 분석 데이터 품질 감사 실패");
  });
});
