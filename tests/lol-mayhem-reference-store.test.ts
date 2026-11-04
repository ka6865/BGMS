import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: vi.fn(), from: vi.fn(), rpc: vi.fn(), upload: vi.fn(), download: vi.fn(), cache: vi.fn((fn: unknown) => fn) }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: mocks.cache }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: mocks.db }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: async () => ({ champions: [{ id: 29, name: "트위치" }] }) }));
import { getPublicReference, getReferenceAdmin, getReferenceFile, getReferenceRankingPatches, saveReferenceSnapshot } from "@/lib/lol/mayhemReferenceStore.server";

const source = { meta: { service: "aramgg-data-api", schemaVersion: 1, apiVersion: "v1", locale: "ko", gamePatch: "16.22", apiRelease: 5,
  dataVersion: "16.22.1", generatedAt: "2026-11-04T00:00:00Z", publishedAt: "2026-11-04T00:00:00Z", configRevision: "capture", resource: "champions", total: 1 },
  data: [{ id: 29, stats: { tier: 2, gamePatch: "16.22", date: "2026-11-03" } }] };
const raw = JSON.stringify(source);
const normalized = { patch: "16.22", dataVersion: "16.22.1", date: "2026-11-03", tiers: { "29": 2 } };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const candidateInput = () => ({ kind: "champion_tiers" as const, raw, normalized, upstreamVersion: "16.22.1", attribution: "출처", rightsBasis: "검토된 공개 데이터 재사용 근거", leaseToken: "lease" });
const approvedTierRelease = () => ({ id: 9, kind: "champion_tiers", source: "aramgg", client_patch: "16.22", champion_id: 0,
  upstream_version: "16.22.1", source_data_date: normalized.date, raw_hash: hash(raw), normalized_hash: hash(JSON.stringify(normalized)),
  raw_path: `external/mayhem-reference/objects/${hash(raw)}.json`, normalized_path: `external/mayhem-reference/objects/${hash(JSON.stringify(normalized))}.json`,
  raw_bytes: Buffer.byteLength(raw), normalized_bytes: Buffer.byteLength(JSON.stringify(normalized)), attribution: "출처", rights_basis: "검토된 공개 데이터 재사용 근거",
  status: "approved", fetched_at: "2026-11-04T00:00:00Z", reviewed_at: null });

beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_REFERENCE_DATASET_ENABLED", "true");
  vi.stubEnv("LOL_MAYHEM_REFERENCE_PUBLIC_ENABLED", "true");
  vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "true");
  mocks.cache.mockImplementation((fn: unknown) => fn);
  mocks.upload.mockResolvedValue({ error: null });
  mocks.download.mockImplementation(async (path: string) => ({ data: new Blob([path.endsWith(`${hash(raw)}.json`) ? raw : JSON.stringify(normalized)]), error: null }));
  mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: 41, error: null }) });
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = { select: () => query, eq: () => query, limit: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ data: table === "lol_mayhem_reference_releases" ? null : null, error: null }),
      single: async () => ({ data: null, error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve) };
    return query;
  });
  mocks.db.mockReturnValue({ from: mocks.from, rpc: mocks.rpc, storage: { from: () => ({ upload: mocks.upload, download: mocks.download }) } });
});

it("keeps tier candidates discoverable when item captures fill the recent list and loads only relevant publication patches", async () => {
  const scopes: Array<{ table: string; kind?: string; patches?: unknown }> = [];
  mocks.from.mockImplementation((table: string) => {
    const scope: { table: string; kind?: string; patches?: unknown } = { table }; scopes.push(scope);
    const query = { select: () => query, eq: (key: string, value: string) => { if (key === "kind") scope.kind = value; return query; },
      in: (_key: string, patches: unknown) => { scope.patches = patches; return query; }, order: () => query, limit: () => query, abortSignal: () => query,
      then: (resolve: (value: unknown) => unknown) => {
        let rows: unknown[] = [];
        if (table === "lol_mayhem_reference_releases") {
          if (scope.kind === "champion_tiers") rows = [approvedTierRelease()];
          if (scope.kind === "item_ratings") rows = Array.from({ length: 500 }, (_, index) => ({ ...approvedTierRelease(), id: index + 100,
            kind: "item_ratings", source: "iesdev", champion_id: 29, raw_hash: (index + 1).toString(16).padStart(64, "0"),
            raw_path: `external/mayhem-reference/objects/${(index + 1).toString(16).padStart(64, "0")}.json` }));
        }
        if (table === "lol_mayhem_reference_publications" && scope.kind === "champion_tiers") rows = [{ kind: "champion_tiers", client_patch: "16.22", champion_id: 0, release_id: 9 }];
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      } };
    return query;
  });
  const result = await getReferenceAdmin();
  expect(result.releases.filter(row => row.kind === "champion_tiers")).toHaveLength(1);
  expect(result.truncatedKinds).toEqual(["item_ratings"]);
  expect(result.champions).toEqual([{ id: 29, name: "트위치" }]);
  expect(scopes.filter(scope => scope.table === "lol_mayhem_reference_publications")).toEqual([
    { table: "lol_mayhem_reference_publications", kind: "champion_tiers", patches: ["16.22"] },
    { table: "lol_mayhem_reference_publications", kind: "item_ratings", patches: ["16.22"] },
  ]);
});

it("rejects a raw/normalized mismatch and oversized raw input before any storage write", async () => {
  await expect(saveReferenceSnapshot({ ...candidateInput(), normalized: { ...normalized, tiers: { "29": 1 } } })).rejects.toThrow("reference_snapshot_invalid");
  await expect(saveReferenceSnapshot({ ...candidateInput(), raw: "x".repeat(2 * 1024 * 1024 + 1) })).rejects.toThrow("reference_snapshot_invalid");
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
});

it("keeps an existing identical normalized candidate without writing Storage or ingest RPC", async () => {
  const filters: unknown[][] = [];
  mocks.from.mockImplementation(() => {
    const query: Record<string, unknown> = { select: () => query, eq: (...args: unknown[]) => { filters.push(args); return query; }, abortSignal: () => query,
      maybeSingle: async () => ({ data: { id: 17 }, error: null }) };
    return query;
  });
  await expect(saveReferenceSnapshot(candidateInput())).resolves.toBe(17);
  expect(filters).toContainEqual(["raw_hash", hash(raw)]);
  expect(filters).toContainEqual(["normalized_hash", hash(JSON.stringify(normalized))]);
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
});

it("stores a new raw revision even when its normalized payload is unchanged", async () => {
  const revisedRaw = JSON.stringify({ ...source, meta: { ...source.meta, publishedAt: "2026-11-05T00:00:00Z" } });
  mocks.from.mockImplementation(() => {
    const query: Record<string, unknown> = { select: () => query, eq: () => query, abortSignal: () => query, maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  });
  await expect(saveReferenceSnapshot({ ...candidateInput(), raw: revisedRaw })).resolves.toBe(41);
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  const args = mocks.rpc.mock.calls[0][1] as { p_candidate: Record<string, unknown> };
  expect(args.p_candidate).toMatchObject({ rawHash: hash(revisedRaw), normalizedHash: hash(JSON.stringify(normalized)) });
  expect(args.p_candidate.rawHash).not.toBe(hash(raw));
});

it("uploads validated raw and normalized objects then passes their hashes and sizes to the ingest RPC", async () => {
  mocks.from.mockImplementation(() => {
    const query: Record<string, unknown> = { select: () => query, eq: () => query, abortSignal: () => query, maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  });
  await expect(saveReferenceSnapshot(candidateInput())).resolves.toBe(41);
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  const args = mocks.rpc.mock.calls[0][1] as { p_candidate: Record<string, unknown>; p_token: string };
  expect(mocks.rpc.mock.calls[0][0]).toBe("ingest_lol_mayhem_reference"); expect(args.p_token).toBe("lease");
  const p_candidate = args.p_candidate;
  expect(p_candidate).toMatchObject({ kind: "champion_tiers", clientPatch: "16.22", championId: 0,
    rawHash: hash(raw), normalizedHash: hash(JSON.stringify(normalized)), rawBytes: Buffer.byteLength(raw),
    normalizedBytes: Buffer.byteLength(JSON.stringify(normalized)), sourceDataDate: "2026-11-03", upstreamVersion: "16.22.1" });
});

it("serves only the approved release selected by the publication pointer and never fetches externally", async () => {
  const row = approvedTierRelease();
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = { select: () => query, eq: () => query, limit: () => query, abortSignal: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ kind: "champion_tiers", champion_id: 0, client_patch: "16.22", release_id: 9 }], error: null }).then(resolve),
      single: async () => ({ data: table === "lol_mayhem_reference_releases" ? row : null, error: null }) };
    return query;
  });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(getPublicReference("champion_tiers", "16.22")).resolves.toEqual(normalized);
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.from.mock.calls).toHaveLength(2);
});

it("withholds champion tiers until reuse rights are confirmed, without reading the database", async () => {
  vi.stubEnv("LOL_MAYHEM_STATS_REUSE_CONFIRMED", "false");
  await expect(getPublicReference("champion_tiers", "16.22")).resolves.toBeNull();
  expect(mocks.db).not.toHaveBeenCalled();
});

it("keeps public references and ranking patches hidden until the public rollout flag is enabled", async () => {
  vi.stubEnv("LOL_MAYHEM_REFERENCE_PUBLIC_ENABLED", "false");
  await expect(getPublicReference("champion_tiers", "16.22")).resolves.toBeNull();
  await expect(getReferenceRankingPatches()).resolves.toEqual([]);
  expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
});

it("rejects stored objects with a declared-size or content-hash mismatch", async () => {
  mocks.from.mockImplementation(() => {
    const query: Record<string, unknown> = { select: () => query, eq: () => query, abortSignal: () => query,
      single: async () => ({ data: approvedTierRelease(), error: null }) };
    return query;
  });
  mocks.download.mockImplementation(async (path: string) => {
    if (path.endsWith(`${hash(raw)}.json`)) return { data: { size: Buffer.byteLength(raw) + 1, text: async () => raw }, error: null };
    return { data: new Blob([JSON.stringify(normalized)]), error: null };
  });
  await expect(getReferenceFile(9, "raw")).rejects.toThrow("reference_snapshot_invalid");
  mocks.download.mockImplementation(async (path: string) => {
    const body = path.endsWith(`${hash(raw)}.json`) ? `${raw.slice(0, -1)} ` : JSON.stringify(normalized);
    return { data: new Blob([body]), error: null };
  });
  await expect(getReferenceFile(9, "raw")).rejects.toThrow("reference_snapshot_invalid");
});

it("rejects a publication whose release patch or champion key differs", async () => {
  for (const mismatch of [{ client_patch: "16.21", champion_id: 29 }, { client_patch: "16.22", champion_id: 30 }]) {
    mocks.download.mockClear();
    mocks.from.mockImplementation((table: string) => {
      const row = { id: 3, kind: "item_ratings", source: "iesdev", client_patch: mismatch.client_patch, champion_id: mismatch.champion_id,
        upstream_version: "16.22:2026-11-03", source_data_date: "2026-11-03", raw_hash: "a".repeat(64), normalized_hash: "b".repeat(64),
        raw_path: `external/mayhem-reference/objects/${"a".repeat(64)}.json`, normalized_path: `external/mayhem-reference/objects/${"b".repeat(64)}.json`,
        raw_bytes: 10, normalized_bytes: 20, attribution: "출처", rights_basis: "검토된 공개 데이터 재사용 근거", status: "approved", fetched_at: "2026-11-04T00:00:00Z", reviewed_at: null };
      const q: Record<string, unknown> = { select: () => q, eq: () => q, limit: () => q, abortSignal: () => q,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ kind: "item_ratings", champion_id: 29, client_patch: "16.22", release_id: 3 }], error: null }).then(resolve),
        single: async () => ({ data: table === "lol_mayhem_reference_releases" ? row : null, error: null }) };
      return q;
    });
    await expect(getPublicReference("item_ratings", "16.22", 29)).rejects.toThrow("reference_snapshot_invalid");
    expect(mocks.download).not.toHaveBeenCalled();
  }
});
