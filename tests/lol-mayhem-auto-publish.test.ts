import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reference: vi.fn(), reviewReference: vi.fn(), combos: vi.fn(), rpc: vi.fn(), officialPatch: "16.21" }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/mayhemReferenceStore.server", () => ({ getReferenceAdmin: mocks.reference, reviewReference: mocks.reviewReference }));
vi.mock("@/lib/lol/mayhemChampionDatasetStore.server", () => ({ getChampionDatasetAdmin: vi.fn(), reviewChampionDataset: vi.fn() }));
vi.mock("@/lib/lol/mayhemDatasetStore.server", () => ({ getMayhemDatasetAdmin: mocks.combos }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ rpc: mocks.rpc, from: () => {
  const query = { select: () => query, eq: () => query, abortSignal: () => query, maybeSingle: async () => ({ data: { client_patch: mocks.officialPatch }, error: null }) };
  return query;
} }) }));
import { autoPublishPlan, type UpdateGroup, type UpdateRow } from "../lib/lol/mayhemAdminUpdates";
import { autoPublishMayhem } from "../lib/lol/mayhemAutoPublish.server";

const reviewer = "81b0856c-5b20-4d90-a75b-fe80456f2c2f";
const row = (patch: Partial<UpdateRow>): UpdateRow => ({ id: 2, patch: "16.22", subject: "전체", status: "pending", fetchedAt: "2026-11-09T00:00:00Z", sourceDate: "2026-11-08", amount: 100, blocked: "", expectedPublication: 1, previousPatch: "16.22", ...patch });
const group = (rows: UpdateRow[], blocked = ""): UpdateGroup => ({ key: "combos", title: "", effect: "", endpoint: "", unit: "", rows, targets: rows, publications: [], blocked, syncError: false });
const release = (id: number, status: string, combos: number, fetched: string) => ({ id, verified_client_patch: "16.21", upstream_release_id: "r", status, fetched_at: fetched, metadata: { combos, unknown_count: 0 } });

beforeEach(() => { vi.resetAllMocks(); mocks.officialPatch = "16.21"; vi.stubEnv("LOL_MAYHEM_AUTO_REVIEWER_ID", reviewer); mocks.rpc.mockReturnValue({ abortSignal: async () => ({ error: null }) }); });

describe("자동 공개 판정", () => {
  it("관리자 화면의 차단 사유와 수량 급감은 사람에게 넘긴다", () => {
    const plan = autoPublishPlan(group([row({ id: 2 }), row({ id: 3, patch: "16.21", blocked: "증강 6개의 이름을 먼저 연결해야 합니다." }), row({ id: 4, patch: "16.20", amount: 80 }), row({ id: 5, patch: "16.19", amount: 90 })]), () => 100);
    expect(plan.ready.map(r => r.id)).toEqual([2, 5]);
    expect(plan.held.map(h => h.reason)).toEqual(["증강 6개의 이름을 먼저 연결해야 합니다.", "수량이 100에서 80로 줄었습니다."]);
  });
  it("현재 공개본 수량을 모르면 보류하고, 비교 대상이 없거나 첫 공개면 진행한다", () => {
    expect(autoPublishPlan(group([row({})]), () => null).held[0].reason).toBe("현재 공개본 수량을 확인할 수 없습니다.");
    expect(autoPublishPlan(group([row({})]), () => undefined).ready).toHaveLength(1);
    expect(autoPublishPlan(group([row({ expectedPublication: null })]), () => null).ready).toHaveLength(1);
    expect(autoPublishPlan(group([row({})], "설정 확인 필요"), () => 100).held).toHaveLength(1);
  });
});

describe("자동 공개 실행", () => {
  it("검수자 ID가 없으면 아무것도 읽거나 쓰지 않는다", async () => {
    vi.stubEnv("LOL_MAYHEM_AUTO_REVIEWER_ID", "");
    await expect(autoPublishMayhem("combos")).rejects.toThrow("auto_publish_reviewer_missing");
    expect(mocks.combos).not.toHaveBeenCalled();
  });
  it("최신 조합 후보를 승인 후 현재 공개본 기준으로 공개하고 감사 사유를 남긴다", async () => {
    mocks.combos.mockResolvedValue({ releases: [release(12, "pending", 424, "2026-11-09T00:00:00Z"), release(9, "approved", 424, "2026-11-05T00:00:00Z")], publications: [{ client_patch: "16.21", release_id: 9 }], sync: [] });
    expect(await autoPublishMayhem("combos")).toMatchObject({ published: 1, failures: 0, held: [] });
    expect(mocks.rpc.mock.calls.map(([, args]) => [args.p_id, args.p_action, args.p_expected_publication, args.p_reviewed_by])).toEqual([[12, "approve", 9, reviewer], [12, "publish", 9, reviewer]]);
    expect(mocks.rpc.mock.calls[0][1].p_reason).toContain("자동 공개");
    mocks.rpc.mockClear();
    expect(await autoPublishMayhem("combos", { dryRun: true })).toMatchObject({ published: 0, ready: [{ group: "combos", patch: "16.21" }] });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("현재 공식 패치가 아닌 조합 후보는 공개를 시도하지 않고 보류한다", async () => {
    mocks.officialPatch = "16.22";
    mocks.combos.mockResolvedValue({ releases: [release(12, "approved", 424, "2026-11-09T00:00:00Z")], publications: [{ client_patch: "16.21", release_id: 9 }], sync: [] });
    expect(await autoPublishMayhem("combos")).toMatchObject({ published: 0, failures: 0, held: [{ patch: "16.21", reason: "현재 공식 패치가 아닌 후보입니다." }] });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("화면 노출 설정과 무관하게 참조 자료를 판정하고, 실패한 대상만 실패로 센다", async () => {
    const ref = (id: number, champion_id: number) => ({ id, kind: "item_ratings", client_patch: "16.22", champion_id, status: "pending", fetched_at: "2026-11-09T00:00:00Z", source_data_date: "2026-11-08" });
    mocks.reference.mockResolvedValue({ enabled: true, publicEnabled: false, itemsEnabled: false, releases: [ref(20, 1), ref(21, 2)], publications: [], sync: [], champions: [] });
    mocks.reviewReference.mockImplementation(async (input: { id: number }) => { if (input.id === 21) throw new Error("reference_snapshot_invalid"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await autoPublishMayhem("references")).toMatchObject({ published: 1, failures: 1 });
    expect(warn).toHaveBeenCalledWith("[lol-mayhem-auto-publish]", "item_ratings", "16.22", "챔피언 2", "reference_snapshot_invalid");
  });
});
