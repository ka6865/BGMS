import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({ db: vi.fn(), rpc: vi.fn(), download: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: mocks.db }));

import { createChampionDatasetCandidate, getChampionDatasetReadiness, getPublicChampionStats, reviewChampionDataset } from "../lib/lol/mayhemChampionDatasetStore.server";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const token = "11111111-1111-4111-8111-111111111111";
const makeManifest = () => ({
  schemaVersion: 1 as const, source: "champion_api_v1" as const, cohort: "source_default" as const,
  clientPatch: "16.21", upstreamVersion: "16.21.1", sourceDataDate: "2026-11-03", catalogHash: "a".repeat(64),
  expectedChampionIds: [1], files: [{ championId: 1, rawPath: `external/champion-stats/champion_api_v1/objects/${"b".repeat(64)}.json`,
    rawHash: "b".repeat(64), rawBytes: 5, normalizedPath: `external/champion-stats/champion_api_v1/objects/${"c".repeat(64)}.json`,
    normalizedHash: "c".repeat(64), normalizedBytes: 6 }], attribution: "Data source attribution", rightsBasis: "Reuse basis reviewed and documented.", normalizerVersion: 1 as const,
});

beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  mocks.rpc.mockResolvedValue({ data: 7, error: null });
  mocks.download.mockImplementation(async () => ({ data: new Blob([JSON.stringify(makeManifest())]), error: null }));
  mocks.db.mockReturnValue({ rpc: mocks.rpc, from: mocks.from, storage: { from: () => ({ download: mocks.download }) } });
});

describe("증바람 챔피언 통계 저장 경계", () => {
  it("readiness를 공유 계약대로 계산한다", () => {
    vi.stubEnv("LOL_MAYHEM_STATS_API_KEY", " key ");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "  reviewed basis  ");
    vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", " Data provider ");
    vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "true"); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
    expect(getChampionDatasetReadiness()).toEqual({ apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true });
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "TRUE");
    expect(getChampionDatasetReadiness().reuseConfirmed).toBe(false);
  });

  it("미준비 환경에서는 후보 저장 RPC를 호출하지 않는다", async () => {
    await expect(createChampionDatasetCandidate({} as never)).rejects.toThrow("stats_dataset_not_ready");
    expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("승인·공개는 readiness를 요구하고 롤백은 계속 허용한다", async () => {
    await expect(reviewChampionDataset({ id: 1, action: "approve", expectedPublication: null, reviewedBy: token })).rejects.toThrow("stats_dataset_not_ready");
    expect(mocks.db).not.toHaveBeenCalled();
    await reviewChampionDataset({ id: 1, action: "rollback", expectedPublication: 2, reviewedBy: token });
    expect(mocks.rpc).toHaveBeenCalledWith("review_lol_mayhem_champion_dataset", expect.objectContaining({ p_action: "rollback" }));
  });

  it("manifest 해시를 대조하고 leaseToken만 p_token으로 전달한다", async () => {
    vi.stubEnv("LOL_MAYHEM_STATS_API_KEY", "key"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "reviewed basis"); vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", "Data source");
    vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "true"); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "false");
    const metadata = makeManifest();
    const reordered = { ...Object.fromEntries(Object.entries(metadata).reverse()), files: metadata.files.map(file => Object.fromEntries(Object.entries(file).reverse())) };
    const body = JSON.stringify(reordered); const captureHash = sha(body);
    mocks.download.mockResolvedValueOnce({ data: new Blob([body]), error: null });
    const id = await createChampionDatasetCandidate({ clientPatch: metadata.clientPatch, upstreamVersion: metadata.upstreamVersion,
      sourceDataDate: metadata.sourceDataDate, captureHash, manifestPath: `external/champion-stats/champion_api_v1/captures/${captureHash}/manifest.json`,
      catalogHash: metadata.catalogHash, metadata, leaseToken: token });
    expect(id).toBe(7);
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_lol_mayhem_champion_dataset", {
      p_candidate: { clientPatch: metadata.clientPatch, upstreamVersion: metadata.upstreamVersion, sourceDataDate: metadata.sourceDataDate,
        captureHash, manifestPath: `external/champion-stats/champion_api_v1/captures/${captureHash}/manifest.json`, catalogHash: metadata.catalogHash, metadata },
      p_token: token,
    });
  });

  it("Storage 404 또는 hash mismatch는 후보 RPC로 넘어가지 않는다", async () => {
    vi.stubEnv("LOL_MAYHEM_STATS_API_KEY", "key"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "reviewed basis"); vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", "Data source");
    vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "true"); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
    mocks.download.mockResolvedValueOnce({ data: null, error: { status: 404, message: "not found" } });
    const metadata = makeManifest(); const captureHash = sha(JSON.stringify(metadata));
    await expect(createChampionDatasetCandidate({ clientPatch: metadata.clientPatch, upstreamVersion: metadata.upstreamVersion,
      sourceDataDate: metadata.sourceDataDate, captureHash, manifestPath: `external/champion-stats/champion_api_v1/captures/${captureHash}/manifest.json`,
      catalogHash: metadata.catalogHash, metadata, leaseToken: token })).rejects.toThrow("stats_snapshot_invalid");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("공개 재사용 미확인 상태에서는 게시본도 외부에 노출하지 않는다", async () => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "false");
    expect(await getPublicChampionStats("16.21",1)).toBeNull(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it("pending 데이터는 공개되지 않고 DTO는 validator allowlist로 재구성한다", async () => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "reviewed public use"); vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", "Data provider");
    const manifest = makeManifest();
    const normalized = JSON.stringify({ schemaVersion: 1, source: "champion_api_v1", cohort: "source_default", clientPatch: "16.21",
      upstreamVersion: "16.21.1", sourceDataDate: "2026-11-03", fetchedAt: "2026-11-04T00:00:00.000Z", championId: 1,
      catalogHash: manifest.catalogHash, rows: [], winRate: 0.9, rank: 1 });
    manifest.files[0].normalizedHash = sha(normalized); manifest.files[0].normalizedPath = `external/champion-stats/champion_api_v1/objects/${manifest.files[0].normalizedHash}.json`;
    manifest.files[0].normalizedBytes = Buffer.byteLength(normalized);
    const manifestBody = JSON.stringify(manifest); const captureHash = sha(manifestBody);
    const release = { upstream_version: manifest.upstreamVersion, source_data_date: manifest.sourceDataDate, capture_hash: captureHash,
      manifest_path: `external/champion-stats/champion_api_v1/captures/${captureHash}/manifest.json`, catalog_hash: manifest.catalogHash, metadata: manifest };
    mocks.from.mockImplementation((table: string) => {
      const query = { select: () => query, eq: () => query, abortSignal: () => query,
        maybeSingle: async () => ({ data: table === "lol_mayhem_champion_dataset_publications" ? { release_id: 4, published_at: "2026-11-04T01:00:00Z" } : null, error: null }),
        single: async () => ({ data: release, error: null }) };
      return query;
    });
    mocks.download.mockImplementation(async (path: string) => ({ data: new Blob([path === release.manifest_path ? manifestBody : normalized]), error: null }));
    const publicStats = await getPublicChampionStats("16.21", 1);
    expect(publicStats).not.toHaveProperty("winRate"); expect(publicStats).not.toHaveProperty("rank");
    expect(publicStats).toMatchObject({ championId: 1, attribution: manifest.attribution, publishedAt: "2026-11-04T01:00:00Z" });

    mocks.from.mockImplementation(() => {
      const query = { select: () => query, eq: () => query, abortSignal: () => query,
        maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }) };
      return query;
    });
    mocks.download.mockClear();
    expect(await getPublicChampionStats("16.21", 999)).toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

describe("새 패치 통계 공개 전 대체", () => {
  it("공개 API만 직전 패치 공개본을 쓰고 이후 패치 공개본은 고르지 않는다", async () => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true");
    vi.stubEnv("LOL_MAYHEM_STATS_REUSE_BASIS", "reviewed public use"); vi.stubEnv("LOL_MAYHEM_STATS_ATTRIBUTION", "Data provider");
    const manifest = makeManifest();
    const normalized = JSON.stringify({ schemaVersion: 1, source: "champion_api_v1", cohort: "source_default", clientPatch: "16.21",
      upstreamVersion: "16.21.1", sourceDataDate: "2026-11-03", fetchedAt: "2026-11-04T00:00:00.000Z", championId: 1, catalogHash: manifest.catalogHash, rows: [] });
    manifest.files[0].normalizedHash = sha(normalized); manifest.files[0].normalizedPath = `external/champion-stats/champion_api_v1/objects/${sha(normalized)}.json`;
    manifest.files[0].normalizedBytes = Buffer.byteLength(normalized);
    const manifestBody = JSON.stringify(manifest), captureHash = sha(manifestBody);
    const release = { upstream_version: manifest.upstreamVersion, source_data_date: manifest.sourceDataDate, capture_hash: captureHash,
      manifest_path: `external/champion-stats/champion_api_v1/captures/${captureHash}/manifest.json`, catalog_hash: manifest.catalogHash, metadata: manifest };
    const releaseIds: unknown[] = [];
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, eq: (column: string, value: unknown) => { if (column === "id") releaseIds.push(value); return query; }, limit: () => query, abortSignal: () => query,
        maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: release, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ client_patch: "16.23", release_id: 9, published_at: "x" }, { client_patch: "16.20", release_id: 3, published_at: "x" }, { client_patch: "16.21", release_id: 4, published_at: "2026-11-04T01:00:00Z" }], error: null }).then(resolve) };
      return query;
    });
    mocks.download.mockImplementation(async (path: string) => ({ data: new Blob([path === release.manifest_path ? manifestBody : normalized]), error: null }));
    expect(await getPublicChampionStats("16.22", 1)).toBeNull();
    expect(await getPublicChampionStats("16.22", 1, { fallback: true })).toMatchObject({ clientPatch: "16.21", publishedAt: "2026-11-04T01:00:00Z" });
    expect(releaseIds).toEqual([4]);
  });
});
