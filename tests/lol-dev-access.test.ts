import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mocks.auth }));

import { requireLolDevAdmin } from "@/lib/lol/access.server";

const adminId = "11111111-1111-4111-8111-111111111111";
const otherAdminId = "22222222-2222-4222-8222-222222222222";

function configureAdmin(id = adminId, profile: unknown = { role: "admin" }) {
  mocks.auth.mockResolvedValue({
    user: { id },
    supabaseAdmin: { from: mocks.from },
  });
  mocks.single.mockResolvedValue({ data: profile, error: null });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LOL_DEV_ENABLED", "true");
  vi.stubEnv("LOL_DEV_OWNER_USER_ID", undefined);
  mocks.from.mockReturnValue({
    select: vi.fn().mockReturnValue({ eq: mocks.eq }),
  });
  mocks.eq.mockReturnValue({ single: mocks.single });
  configureAdmin();
});

afterEach(() => vi.unstubAllEnvs());

describe("requireLolDevAdmin", () => {
  it.each([undefined, "", "false", "TRUE", "1"])(
    "비활성 설정 %s은 인증 전에 404로 거부한다",
    async (enabled) => {
      vi.stubEnv("LOL_DEV_ENABLED", enabled);

      const result = await requireLolDevAdmin();

      expect(result).toMatchObject({ ok: false, error: { status: 404 } });
      expect(
        (result as { ok: false; error: Response }).error.headers.get(
          "cache-control",
        ),
      ).toBe("private, no-store");
      expect(mocks.auth).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "not-a-uuid", adminId])(
    "소유자 설정 %s과 무관하게 두 관리자를 모두 허용한다",
    async (legacyOwner) => {
      vi.stubEnv("LOL_DEV_OWNER_USER_ID", legacyOwner);
      for (const id of [adminId, otherAdminId]) {
        configureAdmin(id);
        expect(await requireLolDevAdmin()).toEqual({ ok: true });
        expect(mocks.eq).toHaveBeenLastCalledWith("id", id);
      }
      expect(mocks.single).toHaveBeenCalledTimes(2);
    },
  );

  it("현재 관리자는 데이터 필드 노출 없이 성공한다", async () => {
    configureAdmin(adminId, {
      role: "admin",
      nickname: "private",
      extra: "private",
    });

    expect(await requireLolDevAdmin()).toEqual({ ok: true });
    expect(mocks.from).toHaveBeenCalledWith("profiles");
    expect(mocks.eq).toHaveBeenCalledWith("id", adminId);
  });

  it.each([null, { role: "user" }])(
    "인증 사용자도 현재 admin 프로필이 없으면 거부한다",
    async (profile) => {
      configureAdmin(adminId, profile);

      expect(await requireLolDevAdmin()).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
    },
  );

  it("프로필 조회 오류도 사용자의 관리자 권한으로 취급하지 않는다", async () => {
    mocks.single.mockResolvedValue({
      data: null,
      error: new Error("private profile detail"),
    });

    expect(await requireLolDevAdmin()).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
  });

  it.each([401, 403, 500])(
    "기존 인증 실패 상태 %i를 보존하고 본문을 노출하지 않는다",
    async (status) => {
      mocks.auth.mockResolvedValue({
        error: new Response("private diagnostic", { status }),
      });

      const result = await requireLolDevAdmin();

      expect(result).toMatchObject({ ok: false, error: { status } });
      expect(
        await (result as { ok: false; error: Response }).error.text(),
      ).not.toContain("private diagnostic");
    },
  );

  it("예상하지 못한 인증 예외는 일반 500으로 차단한다", async () => {
    mocks.auth.mockRejectedValue(new Error("private diagnostic"));

    const result = await requireLolDevAdmin();

    expect(result).toMatchObject({ ok: false, error: { status: 500 } });
    expect(
      await (result as { ok: false; error: Response }).error.text(),
    ).not.toContain("private diagnostic");
  });

  it("각 요청에서 관리자 역할을 다시 확인한다", async () => {
    expect(await requireLolDevAdmin()).toEqual({ ok: true });
    mocks.single.mockResolvedValueOnce({ data: { role: "user" }, error: null });

    expect(await requireLolDevAdmin()).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(mocks.single).toHaveBeenCalledTimes(2);
  });
});
