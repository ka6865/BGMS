import { beforeEach, expect, it, vi } from "vitest";
import type { PublicChampionStats } from "../lib/lol/mayhemChampionDataset";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), stats: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/augments/catalog.server", () => ({ getCachedLolAugmentCatalog: mocks.catalog }));
vi.mock("@/lib/lol/mayhemChampionDatasetStore.server", () => ({ getPublicChampionStats: mocks.stats }));
import { getMayhemObservationHistory } from "../lib/lol/mayhemObservationHistory.server";
const stats = (patch: string): PublicChampionStats => ({ schemaVersion: 1, source: "champion_api_v1", cohort: "source_default", championId: 29,
  clientPatch: patch, upstreamVersion: `${patch}.1`, sourceDataDate: "2026-11-04", fetchedAt: "2026-11-04T00:00:00Z", catalogHash: "a".repeat(64), attribution: "Provider", publishedAt: "2026-11-04T00:00:00Z",
  rows: [{ augmentPlatformId: 1, reportedPickRate: "0.1", reportedSampleCount: null, rateSource: "tencent", rateRegion: "CN", countSource: null, countRegion: null, countMeaning: null, denominatorKind: "unverified_source_definition", denominatorCount: null, selectionEvidence: "reported_rate", offerEligibility: "unknown" }] });
beforeEach(() => {
  vi.resetAllMocks(); mocks.catalog.mockResolvedValue({ view: { augments: [{ id: 1 }, { id: 2 }] } });
  mocks.stats.mockImplementation(async (patch: string) => patch === "16.21" ? stats(patch) : null);
});
it("최근4패치의 공개 게시본만 읽고 없는 자료를 관측 중단으로 만들지 않는다", async () => {
  const result = await getMayhemObservationHistory("16.21", 29);
  expect(mocks.stats.mock.calls).toEqual(["16.21","16.20","16.19","16.18"].map(patch => [patch,29]));
  expect(mocks.catalog).toHaveBeenCalledTimes(1);
  expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ augmentPlatformId: 1, status: "observed" }), expect.objectContaining({ augmentPlatformId: 2, status: "insufficient", missingSince: null })]));
  expect(result.patches.filter(item => item.available).map(item => item.patch)).toEqual(["16.21"]);
});
it("과거 파일 오류와 카탈로그 누락은 그 패치만 자료 부족으로 처리한다", async () => {
  mocks.stats.mockImplementation(async (patch: string) => { if (patch === "16.20") throw new Error("storage-secret"); return stats(patch); });
  mocks.catalog.mockImplementation(async (patch: string) => patch === "16.19" ? null : { view: { augments: [{ id: 1 }, { id: 2 }] } });
  const result = await getMayhemObservationHistory("16.21",29);
  expect(result.patches.filter(item => !item.available).map(item => item.patch)).toEqual(["16.20","16.19"]);
  expect(JSON.stringify(result)).not.toContain("storage-secret");
});
it("현재 공식 목록을 못 읽으면 잘못된 이력을 만들지 않는다", async () => {
  mocks.catalog.mockResolvedValue(null); await expect(getMayhemObservationHistory("16.21",29)).rejects.toThrow(); expect(mocks.stats).not.toHaveBeenCalled();
});
