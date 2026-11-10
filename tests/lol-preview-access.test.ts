import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-middleware", () => ({ updateSession: vi.fn(async () => new Response("session")) }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({
  createServiceRoleSupabase: () => ({ rpc: () => ({ abortSignal: async () => ({ data: { allowed: true, retry_after: 0 }, error: null }) }) }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("LOL_PUBLIC_ENABLED", "true");
  vi.stubEnv("LOL_RIOT_DATA_PUBLIC", "");
  vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "test-secret-value");
  vi.stubEnv("LOL_PREVIEW_PASSWORD", "review-pass");
});
afterEach(() => { vi.unstubAllEnvs(); });

const access = () => import("@/lib/lol/previewAccess");
const page = (path: string, cookie?: string) => new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie: `bgms_lol_preview=${cookie}` } } : undefined);
const login = (password: unknown) => new Request("http://localhost:3000/api/lol/preview", {
  method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": "192.0.2.7" }, body: JSON.stringify({ password }),
});

describe("LoL 미리보기 잠금 경로", () => {
  it.each([
    ["/lol/kr", "page"], ["/lol/kr/홍길동-KR1", "page"], ["/lol/kr/champions/Ahri", "page"], ["/lol/kr/status", "page"],
    ["/lol/kr/by-ref/abc", "page"], ["/lol/kr/aram-mayhem", null], ["/lol/kr/preview", null],
    ["/api/lol/search", "api"], ["/api/lol/matches/KR_1/build", "api"], ["/api/lol/live", "api"],
    ["/api/lol/mayhem/patch-rankings", null], ["/api/lol/augment-icons/16.22/a.png", null], ["/api/lol/preview", null],
    ["/api/lol/mayhemx", "api"], ["/maps/erangel", null], ["/api/admin/lol/status", null],
  ])("%s → %s", async (path, expected) => {
    expect((await access()).lolRiotLockedPath(path)).toBe(expected);
  });
});

describe("LoL 미리보기 쿠키", () => {
  it("발급한 쿠키는 7일 동안만 유효하다", async () => {
    const { createLolPreviewToken, verifyLolPreviewToken } = await access();
    const now = Date.UTC(2026, 10, 10);
    const token = createLolPreviewToken(now)!;
    expect(verifyLolPreviewToken(token, now + 6 * 86_400_000)).toBe(true);
    expect(verifyLolPreviewToken(token, now + 7 * 86_400_000)).toBe(false);
  });

  it("변조·다른 비밀번호·비밀값 없음은 거부한다", async () => {
    const { createLolPreviewToken, verifyLolPreviewToken } = await access();
    const token = createLolPreviewToken()!;
    const [expiresAt, signature] = token.split(".");
    expect(verifyLolPreviewToken(`${Number(expiresAt) + 86_400}.${signature}`)).toBe(false);
    expect(verifyLolPreviewToken(undefined)).toBe(false);
    vi.stubEnv("LOL_PREVIEW_PASSWORD", "changed-pass");
    expect(verifyLolPreviewToken(token)).toBe(false);
    vi.stubEnv("LOL_PREVIEW_PASSWORD", "");
    expect(createLolPreviewToken()).toBeNull();
  });

  it("돌아갈 경로는 잠긴 LoL 화면만 허용한다", async () => {
    const { safeLolPreviewNext } = await access();
    expect(safeLolPreviewNext("/lol/kr/ladder?page=2")).toBe("/lol/kr/ladder?page=2");
    for (const value of ["//evil.example", "https://evil.example", "/maps/erangel", "/lol/kr/aram-mayhem", "/lol/\\evil", undefined, ["/lol/kr"]]) {
      expect(safeLolPreviewNext(value)).toBe("/lol/kr");
    }
  });
});

describe("proxy 잠금", () => {
  it("쿠키 없는 잠긴 화면은 개발 중 화면으로, API는 401로 막는다", async () => {
    const { proxy } = await import("@/proxy");
    const screen = await proxy(page("/lol/kr/ladder?page=2"));
    expect(screen.headers.get("x-middleware-rewrite")).toBe("http://localhost:3000/lol/kr/preview?next=%2Flol%2Fkr%2Fladder%3Fpage%3D2");
    expect(screen.headers.get("cache-control")).toBe("private, no-store");
    const api = await proxy(page("/api/lol/search"));
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ reasonCode: "lol_preview_required" });
  });

  it("유효한 쿠키, 공개 경로, 공개 플래그는 통과한다", async () => {
    const { createLolPreviewToken } = await access();
    const { proxy } = await import("@/proxy");
    expect(await (await proxy(page("/lol/kr/ladder", createLolPreviewToken()!))).text()).toBe("session");
    expect(await (await proxy(page("/lol/kr/aram-mayhem"))).text()).toBe("session");
    vi.stubEnv("LOL_RIOT_DATA_PUBLIC", "true");
    expect(await (await proxy(page("/api/lol/search"))).text()).toBe("session");
  });
});

describe("미리보기 비밀번호 API", () => {
  it("맞는 비밀번호에만 7일 httpOnly 쿠키를 발급한다", async () => {
    const { POST } = await import("@/app/api/lol/preview/route");
    expect((await POST(login("wrong"))).status).toBe(401);
    expect((await POST(login(""))).status).toBe(400);
    const response = await POST(login("review-pass"));
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^bgms_lol_preview=\d+\.[\w-]{43};/);
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
  });

  it("비밀번호를 설정하지 않으면 404다", async () => {
    vi.stubEnv("LOL_PREVIEW_PASSWORD", "");
    const { POST } = await import("@/app/api/lol/preview/route");
    expect((await POST(login("review-pass"))).status).toBe(404);
  });
});
