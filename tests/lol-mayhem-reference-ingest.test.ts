import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: vi.fn(), rpc: vi.fn(), upsert: vi.fn(), championJson: vi.fn(), config: vi.fn(), fetchChampion: vi.fn(), fetchItems: vi.fn(),
  rankingIndex: vi.fn(), ranking: vi.fn(), save: vi.fn(), from: vi.fn(), previousFailures: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: mocks.db }));
vi.mock("@/lib/lol/augments/ingest", () => ({ createSourceDownloader: () => mocks.championJson }));
vi.mock("@/lib/lol/mayhemChampionSource", () => ({ createChampionSource: () => ({ config: mocks.config }) }));
vi.mock("@/lib/lol/mayhemReferenceSource.server", () => ({ fetchChampionTierSnapshot: mocks.fetchChampion, fetchItemRatingSnapshot: mocks.fetchItems,
  fetchRankingIndex: mocks.rankingIndex, fetchRankingSnapshot: mocks.ranking }));
vi.mock("@/lib/lol/mayhemReferenceStore.server", () => ({ referencePersistenceEnabled: () => process.env.LOL_PERSISTENCE_ENABLED === "true" && process.env.LOL_MAYHEM_REFERENCE_DATASET_ENABLED === "true", saveReferenceSnapshot: mocks.save }));
import { ingestMayhemReferences } from "@/lib/lol/mayhemReferenceIngest.server";

const rankingPayload = (patch: string) => ({ patch, date: "2026-11-03", estimated: false, rows: [{ id: "test", name: "증강", rarity: "gold" as const, pickRate: 1, rank: 1 }] });
const rankingSnapshot = (patch: string) => ({ raw: JSON.stringify({ meta: { releaseId: "20261104_005050:491303a59767", statsDate: "2026-11-03" } }), normalized: rankingPayload(patch) });
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_REFERENCE_DATASET_ENABLED", "true");
  mocks.rpc.mockImplementation((name: string) => ({ abortSignal: async () => ({ data: name === "acquire_lol_collection_lease" ? [{ lease_token: "lease" }] : 0, error: null }) }));
  mocks.upsert.mockReturnValue({ abortSignal: async () => ({ error: null }) });
  mocks.previousFailures = 0;
  mocks.from.mockImplementation(() => {
    const query = { select: () => query, eq: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ data: { consecutive_failures: mocks.previousFailures }, error: null }), upsert: mocks.upsert };
    return query;
  });
  mocks.db.mockReturnValue({ rpc: mocks.rpc, from: mocks.from, storage: { from: () => ({ upload: vi.fn() }) } });
  mocks.championJson.mockResolvedValue(JSON.stringify({ data: { Annie: { key: "1" }, Brand: { key: "63" } } }));
  mocks.config.mockResolvedValue({ gamePatch: "16.22", dataVersion: "16.22.1" });
  mocks.fetchChampion.mockResolvedValue({ raw: "{}", normalized: {} }); mocks.fetchItems.mockResolvedValue(null);
  mocks.rankingIndex.mockResolvedValue(["26.20"]);
  mocks.ranking.mockImplementation(async (patch: string) => rankingSnapshot(patch));
  mocks.save.mockResolvedValue(31);
});

it("dry-run validates upstream ranking data without acquiring a lease or writing DB/Storage", async () => {
  const summary = await ingestMayhemReferences({ apply: false, kinds: ["augment_rankings"] });
  expect(summary).toMatchObject({ dryRun: true, status: "validated", snapshots: 1, failures: 0 });
  expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("rejects empty, duplicate, and unknown source kinds before opening persistence", async () => {
  for (const kinds of [[], ["augment_rankings", "augment_rankings"], ["unknown"]] as unknown as ("augment_rankings")[][]) {
    await expect(ingestMayhemReferences({ apply: false, kinds })).rejects.toThrow("reference_kind_invalid");
  }
  expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.rankingIndex).not.toHaveBeenCalled();
});

it("keeps the last published data untouched when one upstream patch fails", async () => {
  mocks.previousFailures = 2;
  mocks.rankingIndex.mockResolvedValue(["26.20", "26.19"]);
  mocks.ranking.mockImplementation(async (patch: string) => {
    if (patch === "26.19") throw new Error("source_unavailable");
    return rankingSnapshot(patch);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const summary = await ingestMayhemReferences({ apply: true, kinds: ["augment_rankings"] });
  expect(summary).toMatchObject({ status: "partial", snapshots: 1, failures: 1 });
  expect(warn).toHaveBeenCalledWith("[lol-mayhem-reference]", "augment_rankings:26.19", "source_unavailable");
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.rpc.mock.calls.some(([name]) => String(name).startsWith("review_lol_mayhem_reference"))).toBe(false);
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ last_error_code: "source_unavailable", consecutive_failures: 3 }));
});

it("skips the paid tier snapshot when the same upstream game/data version is already stored", async () => {
  vi.stubEnv("LOL_MAYHEM_STATS_API_KEY", "test-key"); vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", "출처");
  vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "검토된 공개 데이터 재사용 근거");
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = { select: () => query, eq: () => query, limit: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ data: { consecutive_failures: 0 }, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "lol_mayhem_reference_releases" ? [{ id: 4 }] : [], error: null }).then(resolve),
      upsert: mocks.upsert };
    return query;
  });
  const summary = await ingestMayhemReferences({ apply: true, kinds: ["champion_tiers"] });
  expect(summary).toMatchObject({ status: "awaiting_review", skipped: 1, snapshots: 0, failures: 0 });
  expect(mocks.fetchChampion).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("records quota defer separately from source failures and creates no candidate for the deferred item", async () => {
  mocks.ranking.mockRejectedValue(new Error("stats_quota_deferred"));
  const summary = await ingestMayhemReferences({ apply: true, kinds: ["augment_rankings"] });
  expect(summary).toMatchObject({ status: "partial", snapshots: 0, failures: 0, quotaDeferred: true });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ last_error_code: "stats_quota_deferred", consecutive_failures: 0 }));
});

it("rejects repeated and malformed champion IDs from the official catalog", async () => {
  mocks.championJson.mockResolvedValue(JSON.stringify({ data: { One: { key: "29" }, Two: { key: "29" } } }));
  const summary = await ingestMayhemReferences({ apply: false, kinds: ["item_ratings"] });
  expect(summary).toMatchObject({ status: "partial", failures: 1 }); expect(mocks.fetchItems).not.toHaveBeenCalled();
  mocks.championJson.mockResolvedValue(JSON.stringify({ data: { One: { key: "../29" } } }));
  const invalid = await ingestMayhemReferences({ apply: false, kinds: ["item_ratings"] });
  expect(invalid).toMatchObject({ status: "partial", failures: 1 }); expect(mocks.fetchItems).not.toHaveBeenCalled();
});
