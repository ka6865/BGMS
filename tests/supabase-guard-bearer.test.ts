import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const requestHeaders = vi.fn();
  const requestCookies = vi.fn();
  const adminGetUser = vi.fn();
  const cookieGetUser = vi.fn();
  const createAdminClient = vi.fn(() => ({ auth: { getUser: adminGetUser } }));
  const createServerClient = vi.fn(() => ({ auth: { getUser: cookieGetUser } }));

  return {
    requestHeaders,
    requestCookies,
    adminGetUser,
    cookieGetUser,
    createAdminClient,
    createServerClient,
  };
});

vi.mock("next/headers", () => ({
  headers: mocks.requestHeaders,
  cookies: mocks.requestCookies,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createAdminClient,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

import { withAuthGuard, withOptionalAuth } from "../utils/supabase/guard";

describe("Supabase bearer authentication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestHeaders.mockResolvedValue(new Headers({ Authorization: "Bearer expired-token" }));
    mocks.requestCookies.mockResolvedValue({ getAll: () => [], set: vi.fn() });
    mocks.adminGetUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    mocks.cookieGetUser.mockResolvedValue({ data: { user: { id: "cookie-user" } }, error: null });
  });

  it("명시한 만료 Bearer는 유효한 쿠키 세션으로 대체하지 않고 쓰기를 401로 거부한다", async () => {
    const result = await withAuthGuard();

    expect(result.error?.status).toBe(401);
    expect(mocks.adminGetUser).toHaveBeenCalledWith("expired-token");
    expect(mocks.cookieGetUser).not.toHaveBeenCalled();
  });

  it("선택 인증 GET도 명시한 잘못된 Bearer를 익명 응답으로 낮추지 않는다", async () => {
    const result = await withOptionalAuth();

    expect(result.error?.status).toBe(401);
    expect(mocks.adminGetUser).toHaveBeenCalledWith("expired-token");
    expect(mocks.cookieGetUser).not.toHaveBeenCalled();
  });
});
