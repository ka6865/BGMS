import { describe, expect, it, vi } from "vitest";
import { formatHotdropError, runHotdropScript } from "../scripts/run_hotdrop";

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
});
