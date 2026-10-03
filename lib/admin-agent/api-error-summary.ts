export type ApiErrorSummary = {
  /** Total rows observed in the reporting window. Kept for existing consumers. */
  total: number;
  actionableTotal: number;
  expectedCount: number;
  rateLimitedCount: number;
  serverErrorCount: number;
  otherClientErrorCount: number;
  byStatus: Record<string, number>;
};

export function getApiErrorSeverity(summary: ApiErrorSummary, criticalServerErrorThreshold: number): "ok" | "warn" | "critical" {
  if (summary.serverErrorCount >= criticalServerErrorThreshold && summary.serverErrorCount > 0) return "critical";
  if (summary.actionableTotal > 0) return "warn";
  return "ok";
}

export function isKnownExpectedApiError(row: {
  status?: number | null;
  error_code?: string | null;
  route?: string | null;
  source?: string | null;
}): boolean {
  return row.route === "/api/pubg/match"
    && row.source === "user"
    && ((row.status === 404 && row.error_code === "PUBG_MATCH_NOT_FOUND")
      || (row.status === 409 && row.error_code === "PUBG_MATCH_ANALYSIS_IN_PROGRESS"));
}

export function buildApiErrorSummary(input: {
  total: number;
  expectedCount: number;
  rateLimitedCount: number;
  serverErrorCount: number;
  otherClientErrorCount: number;
  rows: Array<{ status?: number | null }>;
}): ApiErrorSummary {
  const byStatus: Record<string, number> = {};
  for (const row of input.rows) {
    const key = String(row.status ?? "unknown");
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const expectedCount = Math.max(0, input.expectedCount);
  const rateLimitedCount = Math.max(0, input.rateLimitedCount);
  const serverErrorCount = Math.max(0, input.serverErrorCount);
  const otherClientErrorCount = Math.max(0, input.otherClientErrorCount);

  return {
    total: Math.max(0, input.total),
    actionableTotal: rateLimitedCount + serverErrorCount + otherClientErrorCount,
    expectedCount,
    rateLimitedCount,
    serverErrorCount,
    otherClientErrorCount,
    byStatus
  };
}
