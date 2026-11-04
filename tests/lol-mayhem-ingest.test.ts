import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ download: vi.fn(), db: vi.fn(), rpc: vi.fn(), upload: vi.fn(), championJson: vi.fn(), updates: [] as Record<string, unknown>[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: mocks.db }));
vi.mock("../lib/lol/mayhemDataset", () => ({ downloadMayhemDataset: mocks.download }));
vi.mock("../lib/lol/augments/ingest", async () => {
  const { createHash } = await import("node:crypto");
  return { createSourceDownloader: () => mocks.championJson, validClientPatch: (patch: string) => /^16\.\d+$/.test(patch),
    sha256: (value: string) => createHash("sha256").update(value).digest("hex") };
});
import { ingestMayhemDataset } from "../lib/lol/mayhemIngest.server";
const token = "11111111-1111-4111-8111-111111111111";
const raw = { url: "https://arammayhem.com/data/v1/latest/augments.json", body: "{}", hash: "a".repeat(64), etag: null, lastModified: null };
const dataset = () => ({ batchHash: "b".repeat(64), releaseId: "source:1", raw: { index: raw, augments: raw, combos: raw },
  rates: [{ externalId: "augment!", pickRate: 12, pickRateRank: 1, sourcePatch: "26.21" }],
  combos: [{ comboId: 1, championId: "Brand", augmentIds: ["augment!"], types: [], sourceUrl: "https://arammayhem.com/combos/1" }],
  metadata: { sourceStatsDate: "2026-11-02", sourcePatch: "26.21", statsDateSource: "release", license: "CC BY 4.0", attribution: "Data: arammayhem.com" } });

beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs(); mocks.updates.length = 0;
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true"); vi.stubEnv("LOL_MAYHEM_DATASET_ENABLED", "true");
  mocks.download.mockResolvedValue(dataset()); mocks.championJson.mockResolvedValue(JSON.stringify({ data: { Brand: { id: "Brand", key: "63" } } }));
  mocks.upload.mockResolvedValue({ error: null });
  mocks.rpc.mockImplementation((name: string) => ({ abortSignal: async () => ({ data: name === "acquire_lol_collection_lease" ? [{ lease_token: token }] : name === "ingest_lol_mayhem_dataset" ? 42 : true, error: null }) }));
  mocks.db.mockReturnValue({ rpc: mocks.rpc, storage: { from: () => ({ upload: mocks.upload }) }, from: (table: string) => {
    const data = table === "lol_game_patches" ? [{ client_patch: "16.21", display_patch: "26.21", ddragon_version: "16.21.1" }] : [];
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query, limit: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ data: table === "lol_augment_publication" ? { client_patch: "16.21" } : null, error: null }),
      single: async () => ({ data: data[0], error: null }),
      upsert: (value: Record<string, unknown>) => { mocks.updates.push(value); return query; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
    };
    return query;
  } });
});

describe("증바람 원본 수집 저장 경계", () => {
  it("dry-run은 원본 검증만 하고 DB·Storage를 쓰지 않는다", async () => {
    expect(await ingestMayhemDataset({ apply: false })).toMatchObject({ dryRun: true, augments: 1, combos: 1 });
    expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("쓰기 플래그를 확인하기 전에는 외부 요청을 시작하지 않는다", async () => {
    vi.stubEnv("LOL_MAYHEM_DATASET_ENABLED", "false");
    await expect(ingestMayhemDataset({ apply: true })).rejects.toThrow("dataset_sync_disabled");
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it("403도 실패 상태를 기록하고 lease를 해제한다", async () => {
    mocks.download.mockRejectedValue(new Error("source_forbidden"));
    await expect(ingestMayhemDataset({ apply: true })).rejects.toThrow("source_forbidden");
    expect(mocks.updates).toContainEqual(expect.objectContaining({ last_error_code: "source_forbidden", consecutive_failures: 1 }));
    expect(mocks.rpc).toHaveBeenLastCalledWith("release_lol_collection_lease", { p_key: "ops:lol-mayhem-external:arammayhem", p_token: token });
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("해시가 같은 원본의 409는 재사용하고 정규화 후보만 원자적으로 저장한다", async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: "409" } });
    expect(await ingestMayhemDataset({ apply: true })).toMatchObject({ id: 42, status: "awaiting_review" });
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_lol_mayhem_dataset", expect.objectContaining({ p_patch: "16.21", p_metadata: expect.objectContaining({ leaseToken: token, counts: { augments: 1, combos: 1 } }),
      p_combos: [expect.objectContaining({ championId: 63 })], p_rates: [expect.objectContaining({ sourceClientPatch: "16.21" })] }));
    expect(mocks.upload).toHaveBeenCalledTimes(6);
    expect(mocks.rpc.mock.calls.some(([name]) => name === "review_lol_mayhem_dataset")).toBe(false);
    const normalized = JSON.parse(mocks.upload.mock.calls[5][1]);
    expect(normalized).not.toHaveProperty("leaseToken");
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "renew_lol_mayhem_dataset_lease")).toHaveLength(7);
  });
  it("같은 데이터 배치라도 index 원문이 바뀌면 보관 경로를 구분한다", async () => {
    await ingestMayhemDataset({ apply: true });
    const next = dataset(); next.raw.index = { ...raw, body: '{"generatedAt":"2026-11-04"}', hash: "c".repeat(64) };
    mocks.download.mockResolvedValue(next);
    await ingestMayhemDataset({ apply: true });
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "ingest_lol_mayhem_dataset");
    expect(calls[0][1].p_batch_hash).toBe(calls[1][1].p_batch_hash);
    expect(calls[0][1].p_metadata.captureHash).not.toBe(calls[1][1].p_metadata.captureHash);
    expect(calls[0][1].p_manifest_path).not.toBe(calls[1][1].p_manifest_path);
  });
  it("상태 조회 예외도 lease를 해제한다", async () => {
    const client = mocks.db(); const from = client.from;
    client.from = (table: string) => {
      const query = from(table);
      if (table === "lol_data_sync_status") query.maybeSingle = async () => { throw new Error("status_read_failed"); };
      return query;
    };
    await expect(ingestMayhemDataset({ apply: true })).rejects.toThrow("status_read_failed");
    expect(mocks.rpc).toHaveBeenLastCalledWith("release_lol_collection_lease", expect.objectContaining({ p_token: token }));
  });
  it("Storage 실패는 DB 후보 저장과 공개를 막는다", async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: "500" } });
    await expect(ingestMayhemDataset({ apply: true })).rejects.toThrow("dataset_storage_error");
    expect(mocks.rpc.mock.calls.some(([name]) => name === "ingest_lol_mayhem_dataset")).toBe(false);
    expect(mocks.rpc).toHaveBeenLastCalledWith("release_lol_collection_lease", expect.objectContaining({ p_token: token }));
  });
  it("해석할 수 없는 챔피언 ID는 숫자를 추측하지 않고 보류한다", async () => {
    mocks.championJson.mockResolvedValue('{"data":{}}');
    await expect(ingestMayhemDataset({ apply: true })).rejects.toThrow("unknown_champion");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.updates).toContainEqual(expect.objectContaining({ last_error_code: "unknown_champion" }));
  });
});
