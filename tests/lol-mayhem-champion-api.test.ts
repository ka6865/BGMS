import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), origin: vi.fn(), admin: vi.fn(), readiness: vi.fn(), review: vi.fn(), stats: vi.fn(), guard: vi.fn(), champions: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.access }));
vi.mock("@/lib/lol/http.server", () => ({ isSameOriginLolRequest: mocks.origin }));
vi.mock("@/lib/lol/publicAccess.server", () => ({ guardLolPublicRequest: mocks.guard }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: mocks.champions }));
vi.mock("@/lib/lol/mayhemChampionDatasetStore.server", () => ({ getChampionDatasetAdmin: mocks.admin, getChampionDatasetReadiness: mocks.readiness, reviewChampionDataset: mocks.review, getPublicChampionStats: mocks.stats, MAYHEM_CHAMPION_DATASET_TAG: "champion-data" }));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
import { GET as adminGet, POST as adminPost } from "../app/api/admin/lol/mayhem-champion-datasets/route";
import { GET as publicGet } from "../app/api/lol/mayhem/champion-stats/[championId]/route";

const userId = "11111111-1111-4111-8111-111111111111";
const stats = { schemaVersion: 1, source: "champion_api_v1", clientPatch: "16.21", cohort: "source_default", upstreamVersion: "v1", sourceDataDate: "2026-11-03", fetchedAt: "2026-11-04T00:00:00Z", championId: 63, catalogHash: "a".repeat(64), rows: [{ augmentPlatformId: 4, reportedPickRate: "0.0697", reportedSampleCount: null, rateSource: "provider", rateRegion: "CN", countSource: null, countRegion: null, countMeaning: null, denominatorKind: "unverified_source_definition", denominatorCount: null, selectionEvidence: "reported_rate", offerEligibility: "unknown" }], attribution: "Data provider", publishedAt: "2026-11-04T00:00:00Z" };
const request = (path: string, body?: unknown) => new Request(`https://bgms.kr${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", origin: "https://bgms.kr", host: "bgms.kr" }, body: JSON.stringify(body) });
const enabled = () => { vi.stubEnv("LOL_PUBLIC_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "true"); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_STATS_API_KEY", "configured-secret"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "Documented permission basis"); vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", "Data provider"); mocks.readiness.mockResolvedValue({ apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true }); };
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  mocks.access.mockResolvedValue({ ok: true, userId }); mocks.origin.mockReturnValue(true); mocks.guard.mockResolvedValue(null);
  mocks.admin.mockResolvedValue({ releases: [], publications: [], sync: [], readiness: { apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true } });
  mocks.readiness.mockResolvedValue({ apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true });
  mocks.champions.mockResolvedValue({ version: "16.21", champions: [{ id: 63, imageId: "Brand", name: "브랜드", title: "", tags: [] }] });
  mocks.stats.mockResolvedValue(stats); mocks.review.mockResolvedValue(undefined);
});

describe("증바람 챔피언 통계 API", () => {
  it("관리자 목록은 권한이 필요하며 비밀 키 값을 응답하지 않는다", async () => {
    mocks.access.mockResolvedValueOnce({ ok: false, error: new Response(null, { status: 403 }) });
    expect((await adminGet()).status).toBe(403);
    const response = await adminGet();
    expect(response.status).toBe(200); expect(await response.text()).not.toContain("configured-secret");
  });
  it("키·재사용 계약 미설정이면 관리자 readiness를 제공하고 저장소를 조회하지 않는다", async () => {
    mocks.readiness.mockResolvedValue({ apiKeyConfigured: false, reuseConfirmed: false, enabled: false, persistenceEnabled: true });
    const response = await adminGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ readiness: { apiKeyConfigured: false, reuseConfirmed: false }, databaseAvailable: false });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("공개 재사용 미확인 상태에서도 관리자는 비공개 후보를 검토할 수 있다", async () => {
    mocks.readiness.mockResolvedValue({ apiKeyConfigured: true, reuseConfirmed: false, enabled: true, persistenceEnabled: true });
    expect((await adminGet()).status).toBe(200); expect(mocks.admin).toHaveBeenCalledOnce();
  });
  it("review는 origin, 확인, readiness를 통과한 뒤 store 계약의 camelCase와 CAS를 전달한다", async () => {
    enabled(); mocks.origin.mockReturnValueOnce(false);
    expect((await adminPost(request("/api/admin/lol/mayhem-champion-datasets", { action: "approve", id: 8, expectedPublication: null, confirm: true }))).status).toBe(403);
    expect((await adminPost(request("/api/admin/lol/mayhem-champion-datasets", { action: "approve", id: 8, expectedPublication: null }))).status).toBe(400);
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "short");
    mocks.readiness.mockResolvedValueOnce({ apiKeyConfigured: true, reuseConfirmed: false, enabled: true, persistenceEnabled: true });
    expect((await adminPost(request("/api/admin/lol/mayhem-champion-datasets", { action: "approve", id: 8, expectedPublication: null, confirm: true }))).status).toBe(503);
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "Documented permission basis");
    expect((await adminPost(request("/api/admin/lol/mayhem-champion-datasets", { action: "approve", id: 8, expectedPublication: null, confirm: true, reason: "reviewed" }))).status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith({ id: 8, action: "approve", expectedPublication: null, reviewedBy: userId, reason: "reviewed" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("publish/rollback은 readiness를 확인하고 공개 캐시 tag만 재검증한다", async () => {
    enabled();
    for (const action of ["publish", "rollback"] as const) {
      const response = await adminPost(request("/api/admin/lol/mayhem-champion-datasets", { action, id: 8, expectedPublication: 3, confirm: true }));
      expect(response.status).toBe(200);
    }
    expect(mocks.revalidate).toHaveBeenCalledTimes(2); expect(mocks.revalidate).toHaveBeenCalledWith("champion-data", "max");
  });
  it("공개 API는 public guard와 등록 챔피언·양의 정수 ID를 확인한다", async () => {
    enabled();
    expect((await publicGet(request("/api/lol/mayhem/champion-stats/0"), { params: Promise.resolve({ championId: "0" }) })).status).toBe(400);
    expect((await publicGet(request("/api/lol/mayhem/champion-stats/1.5"), { params: Promise.resolve({ championId: "1.5" }) })).status).toBe(400);
    expect((await publicGet(request("/api/lol/mayhem/champion-stats/64"), { params: Promise.resolve({ championId: "64" }) })).status).toBe(400);
    expect(mocks.stats).not.toHaveBeenCalled();
    const response = await publicGet(request("/api/lol/mayhem/champion-stats/63?patch=16.21"), { params: Promise.resolve({ championId: "63" }) });
    expect(response.status).toBe(200); const body = await response.text(); expect(JSON.parse(body)).toEqual({ dataset: stats });
    expect(mocks.stats).toHaveBeenCalledWith("16.21", 63);
    expect(body).not.toMatch(/winrate|rank|tier/i);
  });
  it("패치 오류는 400, 게시 데이터 없음은 dataset:null, 저장 장애는 503", async () => {
    enabled();
    const route = (patch: string) => publicGet(request(`/api/lol/mayhem/champion-stats/63?patch=${patch}`), { params: Promise.resolve({ championId: "63" }) });
    expect((await route("bad")).status).toBe(400);
    mocks.stats.mockResolvedValueOnce(null); expect(await (await route("16.21")).json()).toEqual({ dataset: null });
    mocks.stats.mockRejectedValueOnce(new Error("secret")); expect((await route("16.21")).status).toBe(503);
  });
  it("feature flag가 꺼지면 공개 응답을 숨긴다", async () => {
    vi.stubEnv("LOL_PUBLIC_ENABLED", "false");
    const response = await publicGet(request("/api/lol/mayhem/champion-stats/63?patch=16.21"), { params: Promise.resolve({ championId: "63" }) });
    expect(response.status).toBe(404); expect(mocks.stats).not.toHaveBeenCalled();
  });
});
