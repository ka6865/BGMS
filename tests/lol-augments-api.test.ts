import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), sameOrigin: vi.fn(), read: vi.fn(), publish: vi.fn(), db: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.access }));
vi.mock("@/lib/lol/http.server", () => ({ isSameOriginLolRequest: mocks.sameOrigin }));
vi.mock("@/lib/lol/augments/admin.server", () => ({ getAugmentAdminData: mocks.read }));
vi.mock("@/lib/lol/augments/persistence.server", () => ({ publishLolAugmentPatch: mocks.publish }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: mocks.db }));
import { GET, POST } from "../app/api/admin/lol/augments/route";
import { GET as icon } from "../app/api/lol/augment-icons/[patch]/[...path]/route";

const runId = "11111111-1111-4111-8111-111111111111";
const request = (body: unknown) => new Request("https://bgms.kr/api/admin/lol/augments", { method: "POST", body: JSON.stringify(body) });
const iconRequest = (patch = "16.21", path = "assets/ux/kiwi/augments/icons/test.png") => icon(new Request("https://bgms.kr/api/lol/augment-icons"),
  { params: Promise.resolve({ patch, path: path.split("/") }) });
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); mocks.access.mockResolvedValue({ ok: true });
  mocks.sameOrigin.mockReturnValue(true); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); });
describe("증강 관리자 경계", () => {
  it("GET·POST는 관리자 가드에서 거부하고 DB를 호출하지 않는다", async () => {
    mocks.access.mockResolvedValue({ ok: false, error: new Response(null, { status: 403 }) });
    expect((await GET(new Request("https://bgms.kr/api/admin/lol/augments"))).status).toBe(403);
    expect((await POST(request({}))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it("다른 출처·쓰기 비활성·미확인 게시·잘못된 패치를 거부한다", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request({ patch: "16.21", action: "publish", confirm: true, runId }))).status).toBe(403);
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
    expect((await POST(request({ patch: "16.21", action: "publish", confirm: true, runId }))).status).toBe(503);
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
    expect((await POST(request({ patch: "16.21", action: "publish" }))).status).toBe(400);
    expect((await POST(request({ patch: "latest", action: "publish", confirm: true }))).status).toBe(400);
    expect((await POST(request({ patch: "16.21", action: "publish", confirm: true }))).status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("확인한 패치만 게시 RPC에 전달하고 사설 캐시를 사용한다", async () => {
    mocks.publish.mockResolvedValue(undefined);
    const response = await POST(request({ patch: "16.21", action: "publish", confirm: true, runId }));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.publish).toHaveBeenCalledWith("16.21", runId);
  });
  it("GET의 패치 입력·응답과 DB 실패를 제한한다", async () => {
    expect((await GET(new Request("https://bgms.kr/api/admin/lol/augments?patch=latest"))).status).toBe(400);
    mocks.read.mockResolvedValue({ runs: [], patches: [], detail: null });
    expect((await GET(new Request("https://bgms.kr/api/admin/lol/augments?patch=16.21"))).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("16.21");
    mocks.read.mockRejectedValue(new Error("private error body"));
    const failed = await GET(new Request("https://bgms.kr/api/admin/lol/augments"));
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private error body");
  });
  it.each([true, false])("검토는 현재 실행과 미게시 상태를 확인한다: 게시됨=%s", async published => {
    const update = vi.fn();
    mocks.db.mockReturnValue({ from: (table: string) => {
      const result = table === "lol_game_patches" ? { data: { published_at: published ? "2026-10-23" : null }, error: null }
        : { data: [{ id: "33333333-3333-4333-8333-333333333333", status: "review" }], error: null };
      const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
        abortSignal: () => query, single: async () => result, update,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
      return query;
    } });
    const response = await POST(request({ action: "review", patch: "16.21", confirm: true, runId,
      id: "22222222-2222-4222-8222-222222222222", status: "approved" }));
    expect(response.status).toBe(409); expect(update).not.toHaveBeenCalled();
  });
  it("현재 실행의 pending 항목만 승인한다", async () => {
    const update = vi.fn();
    mocks.db.mockReturnValue({ from: (table: string) => {
      const result = table === "lol_game_patches" ? { data: { published_at: null }, error: null }
        : { data: [{ id: table === "lol_augment_ingestion_runs" ? runId : "change-id", status: "review" }], error: null };
      const query = { select: () => query, eq: vi.fn(() => query), order: () => query, limit: () => query,
        abortSignal: () => query, single: async () => result, update: (value: unknown) => { update(value); return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
      return query;
    } });
    const response = await POST(request({ action: "review", patch: "16.21", confirm: true, runId,
      id: "22222222-2222-4222-8222-222222222222", status: "approved" }));
    expect(response.status).toBe(200); expect(update).toHaveBeenCalledWith({ review_status: "approved" });
  });
  it("큰 요청·배열·잘못된 검토 항목은 DB 전에 거부한다", async () => {
    expect((await POST(request({ padding: "x".repeat(2049) }))).status).toBe(413);
    expect((await POST(request([]))).status).toBe(400);
    expect((await POST(request({ action: "review", patch: "16.21", confirm: true, id: "bad" }))).status).toBe(400);
    expect(mocks.db).not.toHaveBeenCalled();
  });
});
describe("증강 아이콘 프록시", () => {
  it("공개 플래그가 꺼지면 관리자 권한을 검사한다", async () => {
    vi.stubEnv("LOL_PUBLIC_ENABLED", "false"); mocks.access.mockResolvedValue({ ok: false, error: new Response(null, { status: 404 }) });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await iconRequest()).status).toBe(404); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([["latest", "assets/ux/kiwi/augments/icons/test.png"], ["16.21", "assets/ux/kiwi/augments/icons/../test.png"],
    ["16.21", "assets/ux/kiwi/augments/icons/%2e%2e/test.png"],
    ["16.21", String.raw`assets\ux\kiwi\augments\icons\test.png`], ["16.21", "assets/ux/other/augments/icons/test.png"],
    ["16.21", "assets/other.png"], ["16.21", "assets/ux/kiwi/augments/icons/x.svg"], ["16.21", "https://bad.invalid/test.png"]])(
    "허용 목록 밖 경로 %s/%s는 원본을 요청하지 않는다", async (patch, path) => {
      vi.stubEnv("LOL_PUBLIC_ENABLED", "true"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
      expect((await iconRequest(patch, path)).status).toBe(404); expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("고정 버전 PNG를 1년 캐시하며 관리자 전용 응답은 private이다", async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(png, { headers: { "Content-Type": "image/png" } })); vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("LOL_PUBLIC_ENABLED", "true");
    expect((await iconRequest()).headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(fetcher.mock.calls[0][0]).toBe("https://raw.communitydragon.org/16.21/game/assets/ux/kiwi/augments/icons/test.png");
    expect((await iconRequest("16.21", "assets/ux/cherry/augments/icons/test.png")).status).toBe(200);
    vi.stubEnv("LOL_PUBLIC_ENABLED", "false");
    expect((await iconRequest()).headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  });
  it("PNG를 가장한 본문과 크기 상한 초과를 거부한다", async () => {
    vi.stubEnv("LOL_PUBLIC_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<script>bad</script>", { headers: { "Content-Type": "image/png" } })));
    expect((await iconRequest()).status).toBe(502);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a", { headers: { "Content-Type": "image/png", "Content-Length": "9999999" } })));
    expect((await iconRequest()).status).toBe(502);
  });
});
