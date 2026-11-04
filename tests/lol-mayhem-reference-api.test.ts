import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), sameOrigin: vi.fn(), admin: vi.fn(), file: vi.fn(), enabled: vi.fn(), review: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.access }));
vi.mock("@/lib/lol/http.server", () => ({ isSameOriginLolRequest: mocks.sameOrigin }));
vi.mock("@/lib/lol/mayhemReferenceStore.server", () => ({ getReferenceAdmin: mocks.admin, getReferenceFile: mocks.file,
  referencePersistenceEnabled: mocks.enabled, reviewReference: mocks.review, MAYHEM_REFERENCE_TAG: "reference-tag" }));
import { GET, POST } from "@/app/api/admin/lol/mayhem-references/route";

const userId = "11111111-1111-4111-8111-111111111111";
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://bgms.kr/api/admin/lol/mayhem-references", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const candidate = (extra: Record<string, unknown> = {}) => ({ action: "approve", id: 8, expectedPublication: 5, confirm: true, ...extra });
beforeEach(() => {
  vi.resetAllMocks(); mocks.access.mockResolvedValue({ ok: true, userId }); mocks.sameOrigin.mockReturnValue(true);
  mocks.enabled.mockReturnValue(true); mocks.review.mockResolvedValue(undefined); mocks.admin.mockResolvedValue({ enabled: true, releases: [], publications: [], sync: [] });
  mocks.file.mockResolvedValue("{} ");
});

it("requires admin access before reference reads, downloads, or review writes", async () => {
  mocks.access.mockResolvedValue({ ok: false, error: new Response(null, { status: 403 }) });
  expect((await GET(new Request("https://bgms.kr/api/admin/lol/mayhem-references"))).status).toBe(403);
  expect((await GET(new Request("https://bgms.kr/api/admin/lol/mayhem-references?download=8&kind=raw"))).status).toBe(403);
  expect((await POST(request(candidate()))).status).toBe(403);
  expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
});

it("requires same-origin and rejects declared or actual bodies over 4096 bytes", async () => {
  mocks.sameOrigin.mockReturnValue(false);
  expect((await POST(request(candidate()))).status).toBe(403);
  mocks.sameOrigin.mockReturnValue(true);
  expect((await POST(request(candidate(), { "content-length": "4097" }))).status).toBe(413);
  expect((await POST(request(" ".repeat(4097)))).status).toBe(413);
  expect(mocks.review).not.toHaveBeenCalled();
});

it("requires explicit confirmation, valid CAS values, and a substantive rejection reason", async () => {
  for (const body of [candidate({ confirm: false }), candidate({ expectedPublication: "5" }), candidate({ action: "reject", reason: "짧음" })]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect(mocks.review).not.toHaveBeenCalled();
});

it("passes review identity and expected publication to the store, with no tag invalidation for approval", async () => {
  expect((await POST(request(candidate()))).status).toBe(200);
  expect(mocks.review).toHaveBeenCalledWith({ id: 8, action: "approve", expectedPublication: 5, reviewedBy: userId, reason: null });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

it("invalidates the reference tag only after publish/rollback succeeds and maps CAS conflict to 409", async () => {
  for (const action of ["publish", "rollback"] as const) {
    expect((await POST(request(candidate({ action })))).status).toBe(200);
  }
  expect(mocks.revalidate).toHaveBeenCalledTimes(2); expect(mocks.revalidate).toHaveBeenCalledWith("reference-tag", "max");
  mocks.review.mockRejectedValueOnce(new Error("reference_publication_conflict"));
  expect((await POST(request(candidate({ action: "publish" })))).status).toBe(409);
  expect(mocks.revalidate).toHaveBeenCalledTimes(2);
});

it("returns private admin data and constrains raw file downloads to valid IDs and kinds", async () => {
  expect((await GET(new Request("https://bgms.kr/api/admin/lol/mayhem-references"))).status).toBe(200);
  const response = await GET(new Request("https://bgms.kr/api/admin/lol/mayhem-references?download=8&kind=raw"));
  expect(response.status).toBe(200); expect(mocks.file).toHaveBeenCalledWith(8, "raw");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await GET(new Request("https://bgms.kr/api/admin/lol/mayhem-references?download=../8&kind=raw"))).status).toBe(400);
  expect((await GET(new Request("https://bgms.kr/api/admin/lol/mayhem-references?download=8&kind=unknown"))).status).toBe(400);
});
