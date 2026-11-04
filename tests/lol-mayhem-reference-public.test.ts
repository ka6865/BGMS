import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), patches: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("../lib/lol/mayhemReferenceStore.server", () => ({ referencePublicEnabled: () => true, getPublicReference: mocks.get, getReferenceRankingPatches: mocks.patches }));
import { getMayhemItemRatings } from "../lib/lol/mayhemItems.server";
import { getMayhemPatchRankings } from "../lib/lol/mayhemPatchRankings.server";

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_fetch_forbidden"); })); });
it("영속 아이템 조회는 승인본을 사용하고 누락·DB 장애 때 외부 통계로 우회하지 않는다", async () => {
  const payload = { championId: 29, patch: "16.22", date: "2026-11-04", version: "16.22.1", items: [] };
  mocks.get.mockResolvedValueOnce(payload).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("database_error"));
  expect(await getMayhemItemRatings(29)).toEqual(payload);
  expect(mocks.get).toHaveBeenCalledWith("item_ratings", undefined, 29);
  expect(await getMayhemItemRatings(29)).toBeNull();
  await expect(getMayhemItemRatings(29)).rejects.toThrow("database_error");
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it("과거 순위는 보존된 공개 패치만 선택하고 내부 패치 번호로 조회한다", async () => {
  mocks.patches.mockResolvedValue(["26.21", "26.20"]);
  const ranking = { patch: "26.20", date: "2026-10-20", estimated: true, rows: [] };
  mocks.get.mockResolvedValue(ranking);
  expect(await getMayhemPatchRankings("26.20")).toEqual({ patches: ["26.21", "26.20"], ranking });
  expect(mocks.get).toHaveBeenCalledWith("augment_rankings", "16.20");
  mocks.get.mockClear();
  await expect(getMayhemPatchRankings("26.19")).rejects.toThrow("ranking_patch_unavailable");
  expect(mocks.get).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
