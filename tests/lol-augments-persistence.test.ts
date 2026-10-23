import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), metric: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/lol/ops.server", () => ({ recordLolOpsMetric: mocks.metric }));
import {
  acquireLolAugmentIngestionLease, finishLolAugmentIngestionRun, getLolAugmentCatalog,
  publishLolAugmentPatch, recordLolAugmentPatchNotes, recordLolAugmentPatchChanges, upsertLolAugmentSnapshot, type AugmentSnapshot,
} from "@/lib/lol/augments/persistence.server";
import { LolPersistenceError } from "@/lib/lol/persistence.server";

describe("증강 저장 서버 래퍼", () => {
  const abortSignal = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    abortSignal.mockResolvedValue({ data: null, error: null });
    mocks.rpc.mockReturnValue({ abortSignal });
  });
  afterEach(() => vi.restoreAllMocks());
  it("7개 RPC의 입력 계약을 유지하고 모든 요청에 타임아웃 신호를 전달한다", async () => {
    const payload = { augments: [] } as unknown as AugmentSnapshot;
    await acquireLolAugmentIngestionLease("16.21");
    await upsertLolAugmentSnapshot("run", "16.21", payload);
    await recordLolAugmentPatchChanges("run", "16.21", []);
    const notes = { url: "https://example.invalid/notes", published_at: null, added_names: [], removed_names: [], parse_status: "failed" as const };
    await recordLolAugmentPatchNotes("run", "16.21", notes);
    await finishLolAugmentIngestionRun("run", "review");
    await publishLolAugmentPatch("16.21");
    await expect(getLolAugmentCatalog()).resolves.toBeNull();
    expect(mocks.rpc.mock.calls).toEqual([
      ["acquire_lol_augment_ingestion_lease", { p_client_patch: "16.21", p_source_id: null, p_ttl_seconds: 600 }],
      ["upsert_lol_augment_snapshot", { p_run_id: "run", p_client_patch: "16.21", p_payload: payload }],
      ["record_lol_augment_patch_changes", { p_run_id: "run", p_client_patch: "16.21", p_changes: [] }],
      ["record_lol_augment_patch_notes", { p_run_id: "run", p_client_patch: "16.21", p_locale: "ko_kr", p_notes: notes }],
      ["finish_lol_augment_ingestion_run", { p_run_id: "run", p_status: "review", p_error_code: null }],
      ["publish_lol_augment_patch", { p_client_patch: "16.21" }],
      ["get_lol_augment_catalog", { p_client_patch: null }],
    ]);
    expect(abortSignal).toHaveBeenCalledTimes(7);
    expect(abortSignal.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });
  it("게시 시 확인한 실행 ID를 전달한다", async () => {
    await publishLolAugmentPatch("16.21", "run-id");
    expect(mocks.rpc).toHaveBeenCalledWith("publish_lol_augment_patch", { p_client_patch: "16.21", p_run_id: "run-id" });
  });
  it.each([
    [{ code: "22023", message: "private payload" }, "invalid_payload"],
    [{ code: "55000", message: "private run" }, "invalid_state"],
    [{ name: "AbortError", message: "private url" }, "timeout"],
    [{ code: "XX000", message: "private database" }, "db_error"],
  ])("DB 오류를 사유 코드로만 기록한다: %j", async (error, reasonCode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    abortSignal.mockResolvedValue({ data: null, error });
    await expect(getLolAugmentCatalog("16.21")).rejects.toBeInstanceOf(LolPersistenceError);
    expect(JSON.parse(log.mock.calls[0][1])).toEqual({ operation: "get_lol_augment_catalog", stage: "database", reasonCode });
    expect(log.mock.calls.flat().join(" ")).not.toContain("private");
    expect(mocks.metric).toHaveBeenCalledWith(reasonCode === "timeout" ? "db_timeout" : "db_error");
  });
  it("전송 예외도 동일한 저장 오류로 반환한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    abortSignal.mockRejectedValue(new Error("network"));
    await expect(acquireLolAugmentIngestionLease("16.21")).rejects.toBeInstanceOf(LolPersistenceError);
  });
});
