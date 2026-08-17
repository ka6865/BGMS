import { describe, expect, it } from "vitest";
import { buildAiObservability, summarizeAiUsageRows } from "@/lib/admin-agent/ai-observability";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("admin AI observability", () => {
  it("24시간과 7일 집계를 분리하고 legacy success 로그를 호환한다", () => {
    const rows = [
      { id: "new-success", user_id: "u1", analysis_type: "summary", status: "success", cost_usd: 0.01, created_at: "2026-08-13T10:00:00.000Z" },
      { id: "new-error", user_id: "u1", analysis_type: "analyze", status: "error", error_code: "timeout", error_message: "응답 시간 초과", duration_ms: 22000, created_at: "2026-08-13T09:00:00.000Z" },
      { id: "old-legacy", user_id: "u2", analysis_type: "squad", cost_usd: 0.02, created_at: "2026-08-10T10:00:00.000Z" },
    ];

    const result = buildAiObservability(rows, [], NOW);

    expect(result.windows.hours24).toMatchObject({ totalRequests: 2, successRequests: 1, failedRequests: 1, uniqueUsers: 1, totalCostUsd: 0.01 });
    expect(result.windows.days7).toMatchObject({ totalRequests: 3, successRequests: 2, failedRequests: 1, uniqueUsers: 2, totalCostUsd: 0.03 });
    expect(result.windows.hours24.errorsByReason[0]).toMatchObject({ code: "timeout", label: "응답 시간 초과", count: 1 });
  });

  it("AI와 PUBG 오류의 원인·최근 사례를 기간별로 집계한다", () => {
    const result = buildAiObservability(
      [{ id: "ai-1", user_id: "u1", status: "error", error_code: "parse", error_message: "JSON 처리 실패", analysis_type: "summary", created_at: "2026-08-13T11:00:00.000Z" }],
      [{ id: "api-1", route: "/api/pubg/player", status: 503, error_code: "upstream", failure_stage: "fetch", message: "upstream down", created_at: "2026-08-13T10:00:00.000Z" }],
      NOW,
    );

    expect(result.windows.hours24.failedRequests).toBe(1);
    expect(result.pubgApi.hours24).toMatchObject({ total: 1, byStatus: { "503": 1 } });
    expect(result.pubgApi.hours24.recent[0]).toMatchObject({ route: "/api/pubg/player", reason: "upstream" });
  });

  it("오류가 없는 기간의 성공률은 0으로 표시한다", () => {
    expect(summarizeAiUsageRows([], 24, NOW).successRate).toBe(0);
  });
});
