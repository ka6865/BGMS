import { describe, expect, it } from "vitest";
import { buildApiErrorSummary, getApiErrorSeverity, isKnownExpectedApiError } from "@/lib/admin-agent/api-error-summary";

describe("admin agent PUBG API error severity", () => {
  it("404/409 expected responses do not become monitor warnings or criticals", () => {
    const summary = buildApiErrorSummary({
      total: 14,
      expectedCount: 14,
      rateLimitedCount: 0,
      serverErrorCount: 0,
      otherClientErrorCount: 0,
      rows: [{ status: 404 }, { status: 409 }]
    });

    expect(summary.total).toBe(14);
    expect(summary.expectedCount).toBe(14);
    expect(summary.actionableTotal).toBe(0);
    expect(getApiErrorSeverity(summary, 10)).toBe("ok");
  });

  it("only exact verified PUBG match codes on the verified route/source are treated as expected", () => {
    expect(isKnownExpectedApiError({
      status: 404,
      error_code: "PUBG_MATCH_NOT_FOUND",
      route: "/api/pubg/match",
      source: "user"
    })).toBe(true);
    expect(isKnownExpectedApiError({
      status: 409,
      error_code: "PUBG_MATCH_ANALYSIS_IN_PROGRESS",
      route: "/api/pubg/match",
      source: "user"
    })).toBe(true);
    expect(isKnownExpectedApiError({ status: 404, error_code: "unknown", route: "/api/pubg/match", source: "user" })).toBe(false);
    expect(isKnownExpectedApiError({ status: 409, error_code: "PUBG_MATCH_ANALYSIS_IN_PROGRESS", route: "/api/pubg/match", source: "cron" })).toBe(false);
  });

  it("429 remains visible as a warning and cannot trigger the server-error critical threshold", () => {
    const summary = buildApiErrorSummary({
      total: 24,
      expectedCount: 0,
      rateLimitedCount: 24,
      serverErrorCount: 0,
      otherClientErrorCount: 0,
      rows: [{ status: 429 }]
    });

    expect(summary.actionableTotal).toBe(24);
    expect(getApiErrorSeverity(summary, 10)).toBe("warn");
  });

  it("unknown 404/409 remain actionable request errors", () => {
    const summary = buildApiErrorSummary({
      total: 2,
      expectedCount: 0,
      rateLimitedCount: 0,
      serverErrorCount: 0,
      otherClientErrorCount: 2,
      rows: [{ status: 404 }, { status: 409 }]
    });

    expect(summary.actionableTotal).toBe(2);
    expect(getApiErrorSeverity(summary, 10)).toBe("warn");
  });

  it("real server errors remain warnings below threshold and become critical at threshold", () => {
    const belowThreshold = buildApiErrorSummary({
      total: 9,
      expectedCount: 0,
      rateLimitedCount: 0,
      serverErrorCount: 9,
      otherClientErrorCount: 0,
      rows: [{ status: 503 }]
    });
    const atThreshold = { ...belowThreshold, serverErrorCount: 10, actionableTotal: 10 };

    expect(getApiErrorSeverity(belowThreshold, 10)).toBe("warn");
    expect(getApiErrorSeverity(atThreshold, 10)).toBe("critical");
  });
});
