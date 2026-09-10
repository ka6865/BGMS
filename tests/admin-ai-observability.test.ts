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

  it("같은 요청의 사용량과 실패 로그는 비용을 보존하고 실패 한 건으로 집계한다", () => {
    const rows = [
      { id: "usage", request_id: "r1", user_id: "u1", analysis_type: "summary", status: "success", cost_usd: 0.01, prompt_tokens: 100, duration_ms: 1000, created_at: "2026-08-13T11:00:00.001Z" },
      { id: "failure", request_id: "r1", user_id: "u1", analysis_type: "summary", status: "error", error_code: "unknown", error_message: "AI card interpretation did not pass validation", duration_ms: 900, created_at: "2026-08-13T11:00:00.000Z" },
    ];
    for (const input of [rows, [...rows].reverse()]) {
      const result = summarizeAiUsageRows(input, 24, NOW);
      expect(result).toMatchObject({ totalRequests: 1, successRequests: 0, failedRequests: 1, totalCostUsd: 0.01, promptTokens: 100, averageDurationMs: 1000, byType: { summary: 1 } });
      expect(result.errorsByReason[0]).toMatchObject({ code: "validation", label: "AI 응답 내용 검증 실패", count: 1 });
    }
  });

  it("요청 ID가 없거나 사용자·분석 종류가 다른 로그는 합치지 않는다", () => {
    const base = { created_at: "2026-08-13T11:00:00.000Z", request_id: "shared", user_id: "u1", analysis_type: "summary" };
    const result = summarizeAiUsageRows([base, { ...base, user_id: "u2" }, { ...base, analysis_type: "squad" }, { ...base, request_id: null }, { ...base, request_id: null }], 24, NOW);
    expect(result.totalRequests).toBe(5);
  });

  it("상위 AI 사용자도 선택 기간으로 집계한다", () => {
    const result = buildAiObservability([
      { user_id: "u1", created_at: "2026-08-13T11:00:00.000Z" },
      { user_id: "u2", created_at: "2026-08-10T11:00:00.000Z" },
      { user_id: "u2", created_at: "2026-08-10T12:00:00.000Z" },
      { user_id: null, created_at: "2026-08-13T10:00:00.000Z" },
    ], [], NOW);
    expect(result.windows.hours24.topUsers).toEqual([{ userId: "u1", count: 1 }]);
    expect(result.windows.days7.topUsers).toEqual([{ userId: "u2", count: 2 }, { userId: "u1", count: 1 }]);
  });

  it("PUBG 호출 제한은 일반 upstream_http와 구분한다", () => {
    const result = buildAiObservability([], [
      { status: 429, error_code: "upstream_http", created_at: "2026-08-13T11:00:00.000Z" },
      { status: 502, error_code: "upstream_http", created_at: "2026-08-13T11:00:00.000Z" },
    ], NOW);
    expect(result.pubgApi.hours24.byReason).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "PUBG_RATE_LIMITED", count: 1 }),
      expect.objectContaining({ reason: "upstream_http", count: 1 }),
    ]));
  });
});
