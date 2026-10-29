import { describe, expect, it, vi } from "vitest";
import { formatHotdropError, parseHotdropStartCooldownMs, runHotdropScript } from "../scripts/run_hotdrop";
import { PubgHttpError } from "../lib/hotdrop/runHotdropCollection";

describe("runHotdropScript", () => {
  it.each([
    "PUBG_API_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])("필수 환경변수 %s 누락을 client 생성 전에 거부한다", async (missingKey) => {
    const env = {
      PUBG_API_KEY: "pubg-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      [missingKey]: "   ",
    };
    const createSupabase = vi.fn();
    const runJob = vi.fn();
    const writeInfo = vi.fn();
    const writeError = vi.fn();
    const exitCode = await runHotdropScript(env, {
      createSupabase,
      runJob,
      writeInfo,
      writeError,
    });
    expect(exitCode).toBe(1);
    expect(createSupabase).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError).toHaveBeenCalledWith(`Hotdrop 수집 실패: ${missingKey}-missing`);
    expect(writeInfo).not.toHaveBeenCalled();
  });

  it("잘못된 처리량 설정을 client 생성 전에 거부한다", async () => {
    const createSupabase = vi.fn();
    const writeInfo = vi.fn();
    const writeError = vi.fn();
    const exitCode = await runHotdropScript({
      PUBG_API_KEY: "pubg-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      HOTDROP_MAX_MATCHES_PER_RUN: "999",
    }, {
      createSupabase,
      runJob: vi.fn(),
      writeInfo,
      writeError,
    });
    expect(exitCode).toBe(1);
    expect(createSupabase).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("Hotdrop 수집 실패:"));
    expect(writeInfo).not.toHaveBeenCalled();
  });

  it("runJob 예외의 원인은 보존하되 secret과 URL과 match ID는 제거한다", async () => {
    const writeInfo = vi.fn();
    const writeError = vi.fn();
    const sensitiveError = [
      "service-role-secret",
      "pubg-secret",
      "https://telemetry.example/match-123",
      "match-123",
    ].join(" ");

    const exitCode = await runHotdropScript({
      PUBG_API_KEY: "pubg-secret",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    }, {
      createSupabase: vi.fn().mockReturnValue({}),
      runJob: vi.fn().mockRejectedValue(new Error(sensitiveError)),
      writeInfo,
      writeError,
    });

    expect(exitCode).toBe(1);
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError).toHaveBeenCalledWith("Hotdrop 수집 실패: [redacted] [redacted] [url redacted] match-[redacted]");
    expect(writeError.mock.calls[0]?.[0]).not.toContain("service-role-secret");
    expect(writeError.mock.calls[0]?.[0]).not.toContain("https://telemetry.example");
    expect(writeError.mock.calls[0]?.[0]).not.toContain("match-123");
    expect(writeInfo).not.toHaveBeenCalled();
  });

  it("오류가 없거나 문자열이 아니어도 짧은 운영용 원인을 만든다", () => {
    expect(formatHotdropError(new Error("PUBG API error 429"))).toBe("PUBG API error 429");
    expect(formatHotdropError("  timeout\nwhile fetching  ")).toBe("timeout while fetching");
    expect(formatHotdropError({})).toBe("[object Object]");
  });

  it("성공 결과의 안전한 요약만 출력하고 0을 반환한다", async () => {
    const writeInfo = vi.fn();
    const runJob = vi.fn().mockResolvedValue({
      season: "season-1",
      source: "leaderboard",
      totalLandings: 10,
      processedMatches: 2,
      skippedMatches: 0,
    });
    const exitCode = await runHotdropScript({
      PUBG_API_KEY: "pubg-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
    }, {
      createSupabase: vi.fn().mockReturnValue({}),
      runJob,
      writeInfo,
      writeError: vi.fn(),
    });
    expect(exitCode).toBe(0);
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(writeInfo).toHaveBeenCalledWith(JSON.stringify({
      season: "season-1",
      source: "leaderboard",
      totalLandings: 10,
      processedMatches: 2,
      skippedMatches: 0,
    }));
  });

  const rateLimitEnv = {
    PUBG_API_KEY: "pubg-key",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  };

  it("PUBG 호출 한도(429)는 경고로 남기고 성공 처리해 다음 실행이 이어받는다", async () => {
    const writeInfo = vi.fn();
    const writeError = vi.fn();
    const exitCode = await runHotdropScript(rateLimitEnv, {
      createSupabase: vi.fn().mockReturnValue({}),
      runJob: vi.fn().mockRejectedValue(new PubgHttpError(429)),
      writeInfo,
      writeError,
    });
    expect(exitCode).toBe(0);
    expect(writeError).not.toHaveBeenCalled();
    expect(writeInfo).toHaveBeenCalledWith(expect.stringContaining("::warning title=PUBG API 한도 보호::"));
  });

  it("429로 건너뛴 사실을 Actions 단계 요약에 남긴다", async () => {
    const appendSummary = vi.fn();
    const exitCode = await runHotdropScript(rateLimitEnv, {
      createSupabase: vi.fn().mockReturnValue({}),
      runJob: vi.fn().mockRejectedValue(new PubgHttpError(429)),
      writeInfo: vi.fn(),
      writeError: vi.fn(),
      appendSummary,
    });
    expect(exitCode).toBe(0);
    expect(appendSummary).toHaveBeenCalledTimes(1);
    expect(appendSummary.mock.calls[0]?.[0]).toContain("skipped (PUBG API 429)");
  });

  it("직전 단계의 분당 한도를 피하도록 첫 PUBG 호출 전에 쉬고 같은 sleep을 작업에 넘긴다", async () => {
    const events: string[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      events.push(`sleep:${milliseconds}`);
    });
    const runJob = vi.fn(async (_apiKey: string, _config: unknown, dependencies: { sleep: unknown }) => {
      events.push("runJob");
      expect(dependencies.sleep).toBe(sleep);
      return { season: "s", source: "samples" as const, totalLandings: 0, processedMatches: 0, skippedMatches: 0 };
    });
    const exitCode = await runHotdropScript({ ...rateLimitEnv, HOTDROP_START_COOLDOWN_MS: "60000" }, {
      createSupabase: vi.fn().mockReturnValue({}),
      runJob,
      writeInfo: vi.fn(),
      writeError: vi.fn(),
      sleep,
    });
    expect(exitCode).toBe(0);
    expect(events).toEqual(["sleep:60000", "runJob"]);
  });

  it("쉬는 시간 설정은 비어 있으면 0이고 범위를 벗어나면 거부한다", () => {
    expect(parseHotdropStartCooldownMs({})).toBe(0);
    expect(parseHotdropStartCooldownMs({ HOTDROP_START_COOLDOWN_MS: " 60000 " })).toBe(60_000);
    expect(() => parseHotdropStartCooldownMs({ HOTDROP_START_COOLDOWN_MS: "-1" })).toThrow();
    expect(() => parseHotdropStartCooldownMs({ HOTDROP_START_COOLDOWN_MS: "120001" })).toThrow();
    expect(() => parseHotdropStartCooldownMs({ HOTDROP_START_COOLDOWN_MS: "1.5" })).toThrow();
  });

  it.each([401, 403, 500])("PUBG 키 오류나 서버 오류(%i)는 계속 실패로 센다", async (status) => {
    const writeError = vi.fn();
    const exitCode = await runHotdropScript(rateLimitEnv, {
      createSupabase: vi.fn().mockReturnValue({}),
      runJob: vi.fn().mockRejectedValue(new PubgHttpError(status)),
      writeInfo: vi.fn(),
      writeError,
    });
    expect(exitCode).toBe(1);
    expect(writeError).toHaveBeenCalledWith(`Hotdrop 수집 실패: PUBG API error ${status}`);
  });
});
