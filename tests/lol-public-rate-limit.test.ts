import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ rpc: db.rpc }) }));
const request = (ip = "192.0.2.1") => new Request("https://bgms.test/api/lol/search", {
  method: "POST", headers: { host: "bgms.test", origin: "https://bgms.test", "x-forwarded-for": ip },
});
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv("LOL_PUBLIC_ENABLED", "true"); vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "fixture-secret");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("LoL 공개 공유 요청 제한", () => {
  it("인스턴스가 달라도 같은 HMAC 버킷을 공유하고 원본 IP와 비밀을 저장하지 않는다", async () => {
    const counts = new Map<string, number>();
    db.rpc.mockImplementation((_name, { p_key, p_limit }) => ({ abortSignal: async () => {
      const count = (counts.get(p_key) ?? 0) + 1; counts.set(p_key, count);
      return { data: { allowed: count <= p_limit, retry_after: count <= p_limit ? 0 : 37 }, error: null };
    } }));
    const first = (await import("../lib/lol/publicAccess.server")).guardLolPublicRequest;
    for (let i = 0; i < 10; i++) expect(await first(request(), "search")).toBeNull();
    vi.resetModules();
    const second = (await import("../lib/lol/publicAccess.server")).guardLolPublicRequest;
    const result = await second(request(), "search");
    expect(result?.status).toBe(429); expect(result?.headers.get("retry-after")).toBe("37");
    expect(counts.size).toBe(1);
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_key: expect.stringMatching(/^search:[a-f0-9]{64}$/), p_limit: 10, p_window_seconds: 60 });
    expect(JSON.stringify(db.rpc.mock.calls)).not.toMatch(/192\.0\.2\.1|fixture-secret/);
    expect(await second(request("192.0.2.2"), "search")).toBeNull();
  });
  it("DB 오류는 무제한 허용하지 않고 성공 요청까지 포함해 메모리 제한한다", async () => {
    const { guardLolPublicRequest } = await import("../lib/lol/publicAccess.server");
    db.rpc.mockReturnValue({ abortSignal: async () => ({ data: { allowed: true, retry_after: 0 } }) });
    for (let i = 0; i < 9; i++) expect(await guardLolPublicRequest(request(), "search")).toBeNull();
    db.rpc.mockReturnValue({ abortSignal: async () => ({ error: { code: "private-db-detail" } }) });
    expect(await guardLolPublicRequest(request(), "search")).toBeNull();
    expect((await guardLolPublicRequest(request(), "search"))?.status).toBe(429);
    expect(console.warn).toHaveBeenCalledWith("[lol-public] rate_limit_fallback", { reasonCode: "db_error" });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private-db-detail");
  });
  it("비밀 누락·잘못된 DB 응답도 기존 분당 30회 제한을 유지한다", async () => {
    vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "");
    const { guardLolPublicRequest } = await import("../lib/lol/publicAccess.server");
    for (let i = 0; i < 30; i++) expect(await guardLolPublicRequest(request(), "read")).toBeNull();
    expect((await guardLolPublicRequest(request(), "read"))?.status).toBe(429);
    expect(db.rpc).not.toHaveBeenCalled();
    vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "fixture-secret");
    db.rpc.mockReturnValue({ abortSignal: async () => ({ data: [] }) });
    for (let i = 0; i < 10; i++) expect(await guardLolPublicRequest(request(), "search")).toBeNull();
    expect((await guardLolPublicRequest(request(), "search"))?.status).toBe(429);
  });
});
