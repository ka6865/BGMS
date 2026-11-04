import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn(), catalog: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ from: mocks.from, storage: { from: () => ({ download: mocks.download }) } }) }));
vi.mock("@/lib/lol/augments/catalog.server", () => ({ getCachedLolAugmentCatalog: mocks.catalog }));
import { getMayhemMappingPreview } from "@/lib/lol/mayhemDatasetStore.server";
const objectPath = (hash: string) => `external/arammayhem/objects/${hash.repeat(64)}.json`;
const manifestPath = `external/arammayhem/batches/${"a".repeat(64)}/captures/${"b".repeat(64)}/manifest.json`;
const metadata = () => ({ rawManifestPath: manifestPath, unknown_count: 2, unknownExternalIds: ["rate", "combo"], sourceClientPatch: "16.21" });
const file = (rows: unknown[]) => ({ schemaVersion: 1, licenseUrl: "https://creativecommons.org/licenses/by/4.0/", meta: { releaseId: "release:1" }, rows });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockImplementation((table: string) => {
    const rows = table === "lol_mayhem_dataset_releases" ? [{ id: 7, verified_client_patch: "16.22", upstream_release_id: "release:1", status: "pending", fetched_at: "2026-11-05T00:00:00Z", metadata: metadata() }] : [];
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "limit", "order", "abortSignal"]) query[name] = () => query;
    query.single = async () => ({ data: { metadata: metadata() }, error: null });
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
    return query;
  });
  mocks.download.mockImplementation(async (path: string) => {
    const payload = path === manifestPath ? { files: { augments: { path: objectPath("c") }, combos: { path: objectPath("d") } } }
      : path === objectPath("c") ? file([{ augmentId: "rate", name: { "ko-KR": "선택률 증강" }, rarity: "gold" }])
      : file([{ augmentIds: ["combo"], augmentNames: [{ "ko-KR": "조합 증강" }] }]);
    return { error: null, data: new Blob([JSON.stringify(payload)]) };
  });
  mocks.catalog.mockImplementation(async (patch: string) => ({ view: { augments: [{ id: patch === "16.21" ? 1 : 2, name: "공식 이름", text: "공식 설명" }] } }));
});
it("reads only saved files and supplies names and official descriptions for the correct patch scope", async () => {
  const preview = await getMayhemMappingPreview(7);
  expect(preview.sources).toHaveLength(2);
  expect(preview.patches.find(row => row.patch === "16.22")).toMatchObject({ purpose: "추천 조합", externalIds: ["combo"], augments: [{ id: 2, text: "공식 설명" }] });
  expect(preview.patches.find(row => row.patch === "16.21")).toMatchObject({ purpose: "전체 선택률", externalIds: ["rate"], augments: [{ id: 1, text: "공식 설명" }] });
  expect(JSON.stringify(preview)).not.toContain("external/arammayhem");
  expect(mocks.download.mock.calls.every(([path]) => path === manifestPath || [objectPath("c"), objectPath("d")].includes(path))).toBe(true);
});
it("rejects an unknown release without downloading files", async () => {
  await expect(getMayhemMappingPreview(8)).rejects.toThrow("mapping_release_unavailable");
  expect(mocks.download).not.toHaveBeenCalled();
});
