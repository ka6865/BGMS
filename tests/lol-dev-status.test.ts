import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ requireLolDevAdmin: vi.fn() }));
const sdk = vi.hoisted(() => ({
  adminGetUser: vi.fn(),
  cookieGetUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
}));
const adminId = "11111111-1111-4111-8111-111111111111";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({
  requireLolDevAdmin: access.requireLolDevAdmin,
}));

import { GET } from "@/app/api/admin/lol/status/route";

const privateValue = "private-profile-or-secret";

describe("GET /api/admin/lol/status", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.doUnmock("@/lib/lol/access.server"));

  it("관리자 성공 시 고정된 비공개 응답만 반환한다", async () => {
    access.requireLolDevAdmin.mockResolvedValue({
      ok: true,
      user: { id: adminId },
      key: privateValue,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).toBe('{"ok":true}');
    expect(body).not.toContain(adminId);
    expect(body).not.toContain(privateValue);
    expect(access.requireLolDevAdmin).toHaveBeenCalledTimes(1);
  });

  it.each([404, 401, 403, 500, 503])(
    "가드 실패 %i의 상태와 일반 본문, 비공개 헤더를 보존한다",
    async (status) => {
      access.requireLolDevAdmin.mockResolvedValue({
        ok: false,
        error: Response.json({ error: "일반 오류" }, { status }),
      });

      const response = await GET();

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "일반 오류" });
    },
  );

  it("관리자 성공 뒤 익명과 일반회원를 각각 새로 확인한다", async () => {
    access.requireLolDevAdmin
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: Response.json(
          { error: "로그인이 필요합니다." },
          { status: 401 },
        ),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: Response.json(
          { error: "접근 권한이 없습니다." },
          { status: 403 },
        ),
      });

    const responses = await Promise.all([GET(), GET(), GET()]);

    expect(responses.map(({ status }) => status)).toEqual([200, 401, 403]);
    expect(access.requireLolDevAdmin).toHaveBeenCalledTimes(3);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

describe("GET status actual authentication chain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/lol/access.server");
    vi.doUnmock("@/utils/supabase/guard");
    vi.doUnmock("@/lib/server/adminGuard");
    vi.doUnmock("@supabase/ssr");
    vi.doUnmock("@supabase/supabase-js");
    vi.doUnmock("next/headers");
  });

  async function loadActualRoute(options: {
    authorization: string;
    userId: string | null;
  }) {
    vi.resetModules();
    vi.stubEnv("LOL_DEV_ENABLED", "true");
    vi.stubEnv("LOL_DEV_OWNER_USER_ID", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.invalid");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

    vi.resetAllMocks();
    sdk.adminGetUser.mockResolvedValue(
      options.userId
        ? { data: { user: { id: options.userId } }, error: null }
        : { data: { user: null }, error: { message: "invalid bearer" } },
    );
    sdk.cookieGetUser.mockResolvedValue({
      data: { user: { id: adminId } },
      error: null,
    });
    sdk.from.mockImplementation((table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      return { select: sdk.select };
    });
    sdk.select.mockReturnValue({ eq: sdk.eq });
    sdk.eq.mockReturnValue({ single: sdk.single });
    sdk.single.mockResolvedValue({ data: { role: "admin" }, error: null });

    vi.doMock("next/headers", () => ({
      cookies: vi.fn(async () => ({
        getAll: () => [{ name: "session", value: "admin-cookie" }],
        set: vi.fn(),
      })),
      headers: vi.fn(
        async () => new Headers({ authorization: options.authorization }),
      ),
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: vi.fn(() => ({
        auth: { getUser: sdk.adminGetUser },
        from: sdk.from,
        rpc: vi.fn(() => {
          throw new Error("unexpected rpc");
        }),
      })),
    }));
    vi.doMock("@supabase/ssr", () => ({
      createServerClient: vi.fn(() => ({
        auth: { getUser: sdk.cookieGetUser },
      })),
    }));
    vi.doUnmock("@/lib/lol/access.server");
    vi.doUnmock("@/lib/server/adminGuard");
    vi.doUnmock("@/utils/supabase/guard");
    const route = await import("@/app/api/admin/lol/status/route");
    return { GET: route.GET, sdk };
  }

  it.each(["Bearer invalid-token", "Bearer"])(
    "잘못된 %s는 관리자 쿠키로 대체되지 않는다",
    async (authorization) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      const { GET: actualGET, sdk } = await loadActualRoute({
        authorization,
        userId: null,
      });

      const response = await actualGET();

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      if (authorization === "Bearer")
        expect(sdk.adminGetUser).not.toHaveBeenCalled();
      else expect(sdk.adminGetUser).toHaveBeenCalledWith("invalid-token");
      expect(sdk.cookieGetUser).not.toHaveBeenCalled();
      expect(sdk.from).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([adminId, "22222222-2222-4222-8222-222222222222"])(
    "관리자 %s 성공 경로는 인증과 profiles 역할 확인만 수행한다",
    async (userId) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      const { GET: actualGET, sdk } = await loadActualRoute({
        authorization: "Bearer admin-token",
        userId,
      });

      const response = await actualGET();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(sdk.adminGetUser).toHaveBeenCalledWith("admin-token");
      expect(sdk.from).toHaveBeenCalledExactlyOnceWith("profiles");
      expect(sdk.select).toHaveBeenCalledExactlyOnceWith("role, nickname");
      expect(sdk.eq).toHaveBeenCalledExactlyOnceWith("id", userId);
      expect(sdk.single).toHaveBeenCalledOnce();
      expect(sdk.cookieGetUser).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("일반회원 Bearer는 관리자 쿠키로 권한을 높일 수 없다", async () => {
    const { GET: actualGET, sdk } = await loadActualRoute({
      authorization: "Bearer member-token",
      userId: adminId,
    });
    sdk.single.mockResolvedValue({ data: { role: "user" }, error: null });
    const response = await actualGET();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(sdk.cookieGetUser).not.toHaveBeenCalled();
  });

  it("쿠키 관리자 성공 뒤 역할 회수와 로그아웃을 다음 요청에서 차단한다", async () => {
    const { GET: actualGET, sdk } = await loadActualRoute({
      authorization: "",
      userId: null,
    });
    const responses = [await actualGET()];
    sdk.single.mockResolvedValue({ data: { role: "user" }, error: null });
    responses.push(await actualGET());
    sdk.cookieGetUser.mockResolvedValue({ data: { user: null }, error: null });
    responses.push(await actualGET());
    expect(responses.map(({ status }) => status)).toEqual([200, 403, 401]);
    expect(sdk.cookieGetUser).toHaveBeenCalledTimes(3);
    expect(sdk.single).toHaveBeenCalledTimes(2);
    expect(sdk.adminGetUser).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("flag off는 인증이나 프로필 조회 전에 404로 차단한다", async () => {
    const { GET: actualGET, sdk } = await loadActualRoute({
      authorization: "",
      userId: null,
    });
    vi.stubEnv("LOL_DEV_ENABLED", "false");
    const response = await actualGET();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(sdk.cookieGetUser).not.toHaveBeenCalled();
    expect(sdk.adminGetUser).not.toHaveBeenCalled();
    expect(sdk.from).not.toHaveBeenCalled();
  });
});
