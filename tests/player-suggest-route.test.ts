import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteDatabaseAvailable } from "@/lib/pubg/databaseCircuitBreaker";

const {
  mockAbortSignal,
  mockCreateClient,
  mockIlike,
  mockLike,
  mockLimit,
  mockOrder,
  mockRetry,
} = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockLike = vi.fn();
  const mockIlike = vi.fn();
  const mockOrder = vi.fn();
  const mockAbortSignal = vi.fn();
  const mockRetry = vi.fn();
  const mockLimit = vi.fn();
  const chain = {
    select: mockSelect,
    like: mockLike,
    ilike: mockIlike,
    order: mockOrder,
    retry: mockRetry,
    abortSignal: mockAbortSignal,
    limit: mockLimit,
  };
  mockSelect.mockReturnValue(chain);
  mockLike.mockReturnValue(chain);
  mockIlike.mockReturnValue(chain);
  mockOrder.mockReturnValue(chain);
  mockRetry.mockReturnValue(chain);
  mockAbortSignal.mockReturnValue(chain);

  return {
    mockAbortSignal,
    mockCreateClient: vi.fn(async () => ({ from: vi.fn(() => chain) })),
    mockIlike,
    mockLike,
    mockLimit,
    mockOrder,
    mockRetry,
  };
});

vi.mock("@/utils/supabase/server", () => ({
  createClient: mockCreateClient,
}));

import * as suggestRoute from "../app/api/pubg/suggest/route";

describe("player suggest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue({
      data: [{ nickname: "KangPlayer", platform: "steam" }],
      error: null,
    });
  });

  afterEach(() => {
    noteDatabaseAvailable();
  });

  it("짧은 자동완성 함수 실행 시간을 5초로 제한한다", () => {
    expect(suggestRoute.maxDuration).toBe(5);
  });

  it("정규화된 lower_nickname prefix를 제한 시간 안에서 조회하고 CDN에 짧게 캐시한다", async () => {
    const response = await suggestRoute.GET(new Request(
      "http://localhost/api/pubg/suggest?q=%20Ka%20",
    ));

    await expect(response.json()).resolves.toEqual({
      suggestions: [{ nickname: "KangPlayer", platform: "steam" }],
    });
    expect(mockLike).toHaveBeenCalledWith("lower_nickname", "ka%");
    expect(mockIlike).not.toHaveBeenCalled();
    expect(mockOrder).not.toHaveBeenCalled();
    expect(mockRetry).toHaveBeenCalledWith(false);
    expect(mockAbortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
  });

  it("LIKE 와일드카드 입력은 literal prefix로 escape한다", async () => {
    const response = await suggestRoute.GET(new Request(
      "http://localhost/api/pubg/suggest?q=%25_",
    ));

    expect(response.status).toBe(200);
    expect(mockLike).toHaveBeenCalledWith("lower_nickname", "\\%\\_%");
  });

  it("schema cache 장애 후 두 번째 요청은 DB에 다시 진입하지 않는다", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockLimit.mockResolvedValue({
      data: null,
      error: { code: "PGRST002", message: "schema cache unavailable" },
    });

    const first = await suggestRoute.GET(new Request("http://localhost/api/pubg/suggest?q=ka"));
    const second = await suggestRoute.GET(new Request("http://localhost/api/pubg/suggest?q=ka"));

    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("30");
    expect(second.status).toBe(503);
    expect(mockLimit).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("[SUGGEST-API] Supabase unavailable; database circuit opened");
    consoleError.mockRestore();
  });
});
