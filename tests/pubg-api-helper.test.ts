import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mocks.from,
    rpc: mocks.rpc,
  })),
}));

describe("PUBG API 오류 저장", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === "pubg_api_errors") {
        return { insert: mocks.insert.mockResolvedValue({ error: null }) };
      }
      return { insert: mocks.insert.mockResolvedValue({ data: [{ alert_key: "match:500" }], error: null }) };
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("구조화된 원인 컨텍스트를 기존 오류 행에 함께 저장한다", async () => {
    const { reportPubgApiError } = await import("../lib/pubg/apiHelper");

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 502,
      message: "매치 데이터를 처리할 수 없습니다.",
      detail: "PUBG API Match Load Failed: 503",
      context: {
        failureStage: "match_fetch",
        errorCode: "PUBG_MATCH_UPSTREAM_HTTP",
        upstreamStatus: 503,
        durationMs: 1200,
        platform: "steam",
        source: "user",
        clientKind: "browser",
        requestId: "icn1::request",
        matchFingerprint: "hashed-match",
        nicknameFingerprint: "hashed-nickname",
      },
    });

    expect(mocks.from).toHaveBeenCalledWith("pubg_api_errors");
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      route: "/api/pubg/match",
      status: 502,
      failure_stage: "match_fetch",
      error_code: "PUBG_MATCH_UPSTREAM_HTTP",
      upstream_status: 503,
      duration_ms: 1200,
      platform: "steam",
      source: "user",
      client_kind: "browser",
      request_id: "icn1::request",
      match_fingerprint: "hashed-match",
      nickname_fingerprint: "hashed-nickname",
    }));
  });

  it("원인별 alert reservation이 이미 점유됐으면 Discord 전송과 오류 로그를 건너뛴다", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "count_pubg_api_errors_in_window") {
        return Promise.resolve({ data: 12, error: null });
      }
      return Promise.resolve({ data: false, error: null });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const now = new Date("2026-07-27T00:07:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { reportPubgApiError } = await import("../lib/pubg/apiHelper");

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 502,
      message: "매치 데이터를 처리할 수 없습니다.",
      context: {
        errorCode: "PUBG_MATCH_UPSTREAM_HTTP",
      },
    });

    expect(mocks.rpc).toHaveBeenCalledWith("reserve_pubg_api_alert_delivery", {
      p_alert_key: "/api/pubg/match:502:PUBG_MATCH_UPSTREAM_HTTP",
      p_window_started_at: "2026-07-27T00:00:00.000Z",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("임계값을 DB 집계로 판정하므로 인스턴스가 분산돼도 알림을 발송한다", async () => {
    // 서버리스 인스턴스마다 메모리 큐가 따로여서 이 인스턴스는 오류를 1건만 봤다.
    // 전체 오류는 DB 에 12건 적립된 상태이므로 알림이 나가야 한다.
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "count_pubg_api_errors_in_window") {
        return Promise.resolve({ data: 12, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.test/webhook");
    const now = new Date("2026-07-27T00:07:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { reportPubgApiError } = await import("../lib/pubg/apiHelper");

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 500,
      message: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_RESERVE",
      context: { errorCode: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_RESERVE" },
    });

    expect(mocks.rpc).toHaveBeenCalledWith("count_pubg_api_errors_in_window", {
      p_window_started_at: new Date(now - 5 * 60 * 1000).toISOString(),
      p_min_status: 500,
      p_route: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("DB 집계가 임계값 미달이면 알림을 예약하지 않는다", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "count_pubg_api_errors_in_window") {
        return Promise.resolve({ data: 3, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const { reportPubgApiError } = await import("../lib/pubg/apiHelper");

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 500,
      message: "일시적 오류",
      context: { errorCode: "PUBG_MATCH_UPSTREAM_HTTP" },
    });

    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "reserve_pubg_api_alert_delivery",
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("집계 RPC가 실패하면 인스턴스 로컬 카운트로 판정을 이어간다", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "count_pubg_api_errors_in_window") {
        return Promise.resolve({ data: null, error: { message: "rpc down" } });
      }
      return Promise.resolve({ data: true, error: null });
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.test/webhook");
    const { reportPubgApiError } = await import("../lib/pubg/apiHelper");

    for (let count = 0; count < 9; count += 1) {
      await reportPubgApiError({
        route: "/api/pubg/match",
        status: 500,
        message: "일시적 오류",
        context: { errorCode: "PUBG_MATCH_UPSTREAM_HTTP" },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 500,
      message: "일시적 오류",
      context: { errorCode: "PUBG_MATCH_UPSTREAM_HTTP" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
