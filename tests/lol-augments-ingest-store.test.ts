import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sample from "./fixtures/lol-augments/sample-16.21";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({
  rpc: (name: string, args: unknown) => ({ abortSignal: () => mocks.rpc(name, args) }), from: mocks.from,
  storage: { from: () => ({ upload: mocks.upload }) },
}) }));
import { runIngestion } from "../scripts/lol_augments_ingest";
let folder: string;
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv("LOL_AUGMENT_INGEST_ENABLED", "true");
  folder = await mkdtemp(join(tmpdir(), "lol-ingest-store-"));
  const sources = { "augment-lists": sample.augmentLists, "cherry-augments": sample.cherryAugments,
    "kiwi-bin": sample.kiwiBin, "stringtable-ko": sample.stringTableKo, "stringtable-en": sample.stringTableEn };
  for (const [kind, value] of Object.entries(sources)) await writeFile(join(folder, `${kind}.json`), JSON.stringify(value));
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }));
  mocks.rpc.mockImplementation(async name => ({ data: name === "acquire_lol_augment_ingestion_lease" ? "run-id" : null, error: null }));
  mocks.upload.mockResolvedValue({ error: null });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(folder, { recursive: true, force: true }); });
describe("수집 저장 안전장치", () => {
  it("원본·manifest를 저장한 뒤 검토 상태로 종료하며 자동 게시는 하지 않는다", async () => {
    const result = await runIngestion({ patch: "16.21", sourceDir: folder, dryRun: false });
    expect(result).toMatchObject({ count: 46 });
    expect(mocks.upload).toHaveBeenCalledTimes(6);
    expect(mocks.upload.mock.calls.every(([path]) => /^16\.21\/(?:[a-z-]+-)?[0-9a-f]{64}\.json$/.test(path))).toBe(true);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).not.toContain("publish_lol_augment_patch");
    expect(mocks.rpc).toHaveBeenLastCalledWith("finish_lol_augment_ingestion_run", { p_run_id: "run-id", p_status: "review", p_error_code: null });
    const payload = mocks.rpc.mock.calls.find(([name]) => name === "upsert_lol_augment_snapshot")![1].p_payload;
    expect(payload.patch.verified_at).toBeNull();
    expect(payload.augments[0].localizations).toHaveLength(2);
  });
  it("같은 해시 경로가 이미 있으면(409 중복) 정상으로 보고 계속 진행한다", async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: "409", message: "The resource already exists" } });
    await runIngestion({ patch: "16.21", sourceDir: folder, dryRun: false });
    expect(mocks.rpc).toHaveBeenLastCalledWith("finish_lol_augment_ingestion_run", { p_run_id: "run-id", p_status: "review", p_error_code: null });
  });
  it("Storage 실패 시 안전한 코드로 실행을 종료하고 DB 스냅샷·게시본을 건드리지 않는다", async () => {
    mocks.upload.mockResolvedValue({ error: { message: "private credential body" } });
    await expect(runIngestion({ patch: "16.21", sourceDir: folder, dryRun: false })).rejects.toThrow("storage_error");
    expect(mocks.rpc).toHaveBeenLastCalledWith("finish_lol_augment_ingestion_run", { p_run_id: "run-id", p_status: "failed", p_error_code: "storage_error" });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).not.toContain("upsert_lol_augment_snapshot");
  });
  it("설명 누락으로 검증이 차단되면 업로드·스냅샷 저장 없이 blocked로 종료한다", async () => {
    await writeFile(join(folder, "stringtable-ko.json"), JSON.stringify({ entries: {} }));
    const result = await runIngestion({ patch: "16.21", sourceDir: folder, dryRun: false });
    expect(result).toMatchObject({ validation: { ok: false } });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenLastCalledWith("finish_lol_augment_ingestion_run", { p_run_id: "run-id", p_status: "blocked", p_error_code: "validation_blocked" });
  });
});
