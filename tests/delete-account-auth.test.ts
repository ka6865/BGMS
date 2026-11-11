import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headerValues: new Map<string, string>(),
  cookieGetUser: vi.fn(),
  cookieSignOut: vi.fn(),
  bearerGetUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => mocks.headerValues.get(name.toLowerCase()) ?? null }),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.cookieGetUser, signOut: mocks.cookieSignOut } }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mocks.bearerGetUser, admin: { deleteUser: mocks.deleteUser } },
  }),
}));

import { POST } from "@/app/api/auth/delete-account/route";

describe("POST /api/auth/delete-account 인증 경계", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    mocks.headerValues.clear();
    vi.clearAllMocks();
    mocks.cookieGetUser.mockResolvedValue({ data: { user: { id: "cookie-user" } }, error: null });
    mocks.bearerGetUser.mockResolvedValue({ data: { user: { id: "bearer-user" } }, error: null });
    mocks.deleteUser.mockResolvedValue({ error: null });
  });

  it.each(["Bearer ", "Bearer    ", "Basic abc", ""])("Authorization이 %j이면 쿠키 계정으로 대신 탈퇴하지 않는다", async (value) => {
    mocks.headerValues.set("authorization", value);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(mocks.cookieGetUser).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("Authorization이 없으면 쿠키 세션 계정을 탈퇴한다", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(mocks.deleteUser).toHaveBeenCalledWith("cookie-user");
    expect(mocks.cookieSignOut).toHaveBeenCalled();
  });

  it("유효한 Bearer 토큰은 그 토큰의 계정만 탈퇴한다", async () => {
    mocks.headerValues.set("authorization", "Bearer token-1");

    const response = await POST();

    expect(response.status).toBe(200);
    expect(mocks.bearerGetUser).toHaveBeenCalledWith("token-1");
    expect(mocks.cookieGetUser).not.toHaveBeenCalled();
    expect(mocks.deleteUser).toHaveBeenCalledWith("bearer-user");
  });
});
