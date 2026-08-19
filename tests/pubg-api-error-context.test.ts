import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTEXT_MODULE_PATH = "../lib/pubg/apiErrorContext";
const MIGRATION_PATH = resolve("supabase/migrations/20260722080000_add_pubg_error_observability.sql");

async function loadContextModule() {
  return import(CONTEXT_MODULE_PATH).catch(() => null);
}

describe("PUBG API 오류 원인 컨텍스트", () => {
  it("매치 API 404를 만료/미존재 오류로 분류하고 원본 상태를 보존한다", async () => {
    const subject = await loadContextModule();

    expect(subject).not.toBeNull();
    expect(subject?.classifyPubgMatchError({
      stage: "match_fetch",
      upstreamStatus: 404,
      error: new Error("PUBG API Match Load Failed: 404"),
    })).toEqual({
      errorCode: "PUBG_MATCH_NOT_FOUND",
      responseStatus: 404,
    });
  });

  it("타임아웃과 크롤러 요청을 개인정보 없이 구분한다", async () => {
    const subject = await loadContextModule();

    expect(subject).not.toBeNull();
    expect(subject?.classifyPubgMatchError({
      stage: "match_fetch",
      error: new DOMException("The operation timed out", "TimeoutError"),
    })).toEqual({
      errorCode: "PUBG_MATCH_TIMEOUT",
      responseStatus: 504,
    });
    expect(subject?.classifyClientKind("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("crawler");
    expect(subject?.classifyClientKind("Mozilla/5.0")).toBe("browser");
  });

  it("분석 단계 오류를 하위 처리 경계까지 구분한다", async () => {
    const subject = await loadContextModule();

    expect(subject).not.toBeNull();
    expect(subject?.classifyPubgMatchError({
      stage: "analysis",
      analysisStep: "telemetry_download",
      error: new Error("sanitized"),
    })).toEqual({
      errorCode: "PUBG_MATCH_ANALYSIS_TELEMETRY_DOWNLOAD",
      responseStatus: 500,
    });
  });

  it("telemetry cache reservation contention은 재시도 가능한 상태로 분류한다", async () => {
    const subject = await loadContextModule();

    expect(subject).not.toBeNull();
    expect(subject?.classifyPubgMatchError({
      stage: "analysis",
      analysisStep: "telemetry_cache_reserve",
      upstreamStatus: 200,
      error: new Error("telemetry-map-cache-write-in-progress"),
    })).toEqual({
      errorCode: "PUBG_MATCH_ANALYSIS_IN_PROGRESS",
      responseStatus: 409,
    });
  });

  it("캐시 영속화 오류가 외부 catch에 도달하면 전용 503 코드로 분류한다", async () => {
    const subject = await loadContextModule();

    expect(subject).not.toBeNull();
    expect(subject?.classifyPubgMatchError({
      stage: "analysis",
      analysisStep: "telemetry_cache_persistence",
      error: new Error("telemetry-cache-finalize-failed"),
    })).toEqual({
      errorCode: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE",
      responseStatus: 503,
    });
  });

  it("오류 관측 마이그레이션이 구조화 필드와 전역 알림 키를 제공한다", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);

    const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, "utf8") : "";
    for (const requiredFragment of [
      "failure_stage",
      "error_code",
      "upstream_status",
      "duration_ms",
      "match_fingerprint",
      "nickname_fingerprint",
      "pubg_api_alert_deliveries",
      "ENABLE ROW LEVEL SECURITY",
    ]) {
      expect(source).toContain(requiredFragment);
    }
  });

  it("관리자 모니터가 최신 표본 제한과 별도로 정확한 오류 총계를 조회한다", () => {
    const source = readFileSync(resolve("app/api/admin/agent/monitor/route.ts"), "utf8");

    expect(source).toContain('select("id", { count: "exact", head: true })');
    expect(source).toContain("const [countResult, latestResult] = await Promise.all");
  });
});
