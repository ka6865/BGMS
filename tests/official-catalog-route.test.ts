import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), parse: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/server/adminAudit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/server/adminGuard", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/patch-notes/officialCatalog", () => ({ parseOfficialCatalog: mocks.parse }));
import { GET, POST } from "@/app/api/admin/weapon-patch/official-catalog/route";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("공식 도감 관리 API", () => {
  it("관리자가 확인한 원본만 저장하고 원본이 바뀌면 중단한다", async () => {
    const read = { select: () => read, is: () => read, limit: async () => ({ data: [], error: null }) };
    mocks.requireAdmin.mockResolvedValue({ ok: true, user: { id: "admin" }, supabaseAdmin: { from: (table: string) => table === "official_game_catalog" ? { upsert: mocks.upsert } : read } });
    mocks.parse.mockReturnValue([{ key: "rpd", name: "RPD", official: { name: "RPD" } }]);
    mocks.upsert.mockResolvedValue({ error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "html" }));
    const preview = await (await GET()).json();
    mocks.parse.mockReturnValue([{ key: "rpd", name: "changed" }]);
    const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ fingerprint: preview.fingerprint }) });
    expect((await POST(request())).status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
    mocks.parse.mockReturnValue([{ key: "rpd", name: "RPD", official: { name: "RPD" } }]);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(mocks.upsert.mock.calls[0][0]).toHaveLength(2);
  });
  it("관리자가 아니면 조회와 저장을 거부한다", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, error: new Response(null, { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect((await POST(new Request("http://localhost", { method: "POST" }))).status).toBe(403);
  });
});
