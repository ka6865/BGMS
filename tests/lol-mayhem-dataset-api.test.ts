import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), origin: vi.fn(), read: vi.fn(), file: vi.fn(), sync: vi.fn(), upsert: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.access }));
vi.mock("@/lib/lol/http.server", () => ({ isSameOriginLolRequest: mocks.origin }));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
vi.mock("@/lib/lol/mayhemDatasetStore.server", () => ({ getMayhemDatasetAdmin: mocks.read, getMayhemSnapshotFile: mocks.file, MAYHEM_DATASET_TAG: "dataset" }));
vi.mock("@/lib/lol/mayhemIngest.server", () => ({ ingestMayhemDataset: mocks.sync }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ from: () => ({ upsert: mocks.upsert }), rpc: mocks.rpc }) }));
import { GET, POST } from "../app/api/admin/lol/mayhem-datasets/route";

const adminId = "11111111-1111-4111-8111-111111111111";
const post = (body: unknown) => POST(new Request("https://bgms.kr/api/admin/lol/mayhem-datasets", { method: "POST", body: JSON.stringify(body) }));
const get = (query = "") => GET(new Request(`https://bgms.kr/api/admin/lol/mayhem-datasets${query}`));
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
  mocks.access.mockResolvedValue({ ok: true, userId: adminId }); mocks.origin.mockReturnValue(true);
  mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: null }) });
  mocks.upsert.mockResolvedValue({ error: null });
});
describe("증바람 데이터셋 관리자 경계", () => {
  it("관리자가 아니면 조회·쓰기·원본 다운로드를 모두 차단한다", async () => {
    mocks.access.mockResolvedValue({ ok: false, error: new Response(null, { status: 403 }) });
    expect((await get()).status).toBe(403); expect((await get("?download=1&kind=combos")).status).toBe(403);
    expect((await post({ action: "sync", confirm: true })).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("다른 출처·저장 비활성·확인 없는 요청은 변경하지 않는다", async () => {
    mocks.origin.mockReturnValueOnce(false); expect((await post({ action: "sync", confirm: true })).status).toBe(403);
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false"); expect((await post({ action: "sync", confirm: true })).status).toBe(503);
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); expect((await post({ action: "sync" })).status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("원본은 고정된 종류만 JSON 첨부 파일로 전달한다", async () => {
    mocks.file.mockResolvedValue('{"rows":[]}');
    const response = await get("?download=7&kind=combos");
    expect(response.status).toBe(200); expect(mocks.file).toHaveBeenCalledWith(7, "combos");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
    expect((await get("?download=../keys&kind=combos")).status).toBe(400);
    expect((await get("?download=7&kind=manifest")).status).toBe(400);
  });
  it("조회 실패의 비밀 오류를 숨긴다", async () => {
    mocks.read.mockRejectedValue(new Error("private-database-secret"));
    const response = await get(); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-database-secret");
  });
  it("명시적으로 대조한 매핑만 실제 검수자 식별자로 기록한다", async () => {
    const body = { action: "map", confirm: true, patch: "16.21", externalId: "marksmage!", platformId: 42, evidence: "공식 설명과 등급을 대조했습니다." };
    expect((await post({ ...body, evidence: "짧음" })).status).toBe(400);
    expect((await post({ ...body, platformId: -1 })).status).toBe(400);
    expect((await post(body)).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("review_lol_mayhem_mapping", { p_external_id: "marksmage!", p_patch: "16.21", p_platform_id: 42, p_reviewed_by: adminId, p_evidence: { note: body.evidence } });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("게시본 CAS와 검수자를 RPC에 전달하며 승인만으로 캐시를 바꾸지 않는다", async () => {
    expect((await post({ action: "publish", id: 8, confirm: true })).status).toBe(400);
    expect((await post({ action: "approve", id: 8, expectedPublication: null, confirm: true })).status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("review_lol_mayhem_dataset", { p_id: 8, p_action: "approve", p_expected_publication: null, p_reviewed_by: adminId, p_reason: null });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect((await post({ action: "publish", id: 8, expectedPublication: 3, confirm: true })).status).toBe(200);
    expect(mocks.revalidate).toHaveBeenCalledWith("dataset", "max");
  });
  it("DB가 검증·동시성 충돌을 거부하면 공개 캐시를 유지한다", async () => {
    mocks.rpc.mockReturnValue({ abortSignal: async () => ({ error: { message: "private detail" } }) });
    const response = await post({ action: "publish", id: 8, expectedPublication: 3, confirm: true });
    expect(response.status).toBe(409); expect(await response.text()).not.toContain("private detail"); expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("재수집은 검수 후보만 만들고 게시 RPC를 호출하지 않는다", async () => {
    mocks.sync.mockResolvedValue({ id: 9, status: "awaiting_review" });
    expect((await post({ action: "sync", confirm: true })).status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith({ apply: true }); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("제외 사유 없이 후보를 거절하지 않으며 입력 사유를 감사 RPC에 남긴다", async () => {
    const body = { action: "reject", id: 8, expectedPublication: null, confirm: true };
    expect((await post(body)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
    expect((await post({ ...body, reason: "원본 설명이 현재 공식 패치와 다릅니다." })).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("review_lol_mayhem_dataset", expect.objectContaining({ p_reason: "원본 설명이 현재 공식 패치와 다릅니다." }));
  });
});
