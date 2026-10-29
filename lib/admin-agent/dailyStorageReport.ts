export type DailyStorageReportInput = {
  databaseBytes: number;
  databaseLimitBytes: number;
  r2Bytes: number;
  r2LimitBytes: number;
  processedTelemetryRows: number;
  masterTelemetryRows: number;
  benchmarkRows: number;
  scraper: { succeeded: number; skipped: number; failed: number } | null;
  maintenanceStatus: string;
  runUrl: string;
  stepWarnings?: string[];
};

/**
 * continue-on-error 단계의 실패는 워크플로 결과에 드러나지 않으므로 일일 보고에 따로 적는다.
 * 값은 GitHub Actions의 steps.<id>.outcome 과 스크립트 출력값을 그대로 받는다.
 */
export function buildDailyReportStepWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  if (env.DATA_QUALITY_AUDIT_OUTCOME === "failure") {
    warnings.push("분석 데이터 품질 감사 실패 · 조회 시간 초과 여부를 로그에서 확인하세요.");
  }
  const mismatchCount = Number(env.DATA_QUALITY_MISMATCH_COUNT);
  if (Number.isInteger(mismatchCount) && mismatchCount > 0) {
    warnings.push(`분석 데이터 식별자 불일치 ${mismatchCount.toLocaleString()}건 · Admin Agent 승인 큐를 확인하세요.`);
  }
  return warnings;
}

export function requireCompleteDailyReportR2Usage(usage: {
  configured: boolean;
  truncated: boolean;
  totalSizeBytes: number;
}): number {
  if (!usage.configured) throw new Error("daily-storage-report-r2-unconfigured");
  if (usage.truncated) throw new Error("daily-storage-report-r2-truncated");
  if (!Number.isFinite(usage.totalSizeBytes) || usage.totalSizeBytes < 0) {
    throw new Error("daily-storage-report-r2-usage-invalid");
  }
  return usage.totalSizeBytes;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatGigabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
}

function percent(used: number, limit: number): string {
  return `${((used / limit) * 100).toFixed(1)}%`;
}

export function buildDailyStorageReport(input: DailyStorageReportInput): string {
  const scraper = input.scraper
    ? `성공 ${input.scraper.succeeded} · 스킵 ${input.scraper.skipped} · 실패 ${input.scraper.failed}`
    : "실행 요약을 찾지 못함";

  return [
    "📦 **[BGMS 일일 데이터 점검]**",
    `현재 단계 상태: ${input.maintenanceStatus} · 전체 유지보수와 매치 수집이 끝나기 전에 생성된 중간 보고입니다.`,
    `DB: ${formatMegabytes(input.databaseBytes)} / ${formatGigabytes(input.databaseLimitBytes)} (${percent(input.databaseBytes, input.databaseLimitBytes)})`,
    `R2: ${formatMegabytes(input.r2Bytes)} / ${formatGigabytes(input.r2LimitBytes)} (${percent(input.r2Bytes, input.r2LimitBytes)})`,
    `보존 매치: 분석 ${input.processedTelemetryRows.toLocaleString()} · 원본 ${input.masterTelemetryRows.toLocaleString()} · 벤치마커 ${input.benchmarkRows.toLocaleString()}`,
    `수집 단계 요약(현재까지): ${scraper}`,
    ...(input.stepWarnings ?? []).map(warning => `주의: ${warning}`),
    "표시된 용량·건수는 보고 생성 시점 기준이며, 뒤이어 실행되는 전적 수집·정리 결과는 아직 포함되지 않았습니다.",
    `로그: ${input.runUrl}`,
    "AI 토큰 사용 없음 · 매치 티어/분석 DB 장기 보관",
  ].join("\n");
}
