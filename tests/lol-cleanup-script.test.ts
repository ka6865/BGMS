import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runLolCleanup } from "../scripts/lol_cleanup_expired";

const pending = { cache_rows: 1, match_rows: 0, account_rows: 0, lease_rows: 0, public_rate_limit_rows: 1 };
const empty = { cache_rows: 0, match_rows: 0, account_rows: 0, lease_rows: 0, public_rate_limit_rows: 0 };
afterEach(() => vi.useRealTimers());
describe("LoL 자동 정리", () => {
  it("실제 CLI dry-run도 로컬 fixture의 미리보기 RPC만 호출한다", async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(pending));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      if (!address || typeof address === "string") throw new Error("로컬 포트 생성 실패");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/lol_cleanup_expired.ts", "--dry-run"], {
        env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "fixture-local-key", LOL_CLEANUP_ENABLED: "true" }, timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, deletedCount: 0, remainingCount: 2, batches: 0 });
      expect(calls).toEqual(["POST /rest/v1/rpc/preview_lol_expired_data"]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("기본 실행과 명시적 dry-run은 미리보기만 읽는다", async () => {
    for (const args of [[], ["--dry-run"]]) {
      const rpc = vi.fn().mockResolvedValue(pending);
      expect(await runLolCleanup(rpc, args, true)).toMatchObject({ dryRun: true, batches: 0, remainingCount: 2 });
      expect(rpc).toHaveBeenCalledExactlyOnceWith("preview_lol_expired_data");
    }
  });
  it("쓰기 플래그 없이는 lease와 삭제를 호출하지 않는다", async () => {
    const rpc = vi.fn().mockResolvedValue(pending);
    await expect(runLolCleanup(rpc, ["--apply"], false)).rejects.toThrow("LOL_CLEANUP_ENABLED");
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("배치 결과를 합치고 lease를 해제한다", async () => {
    const rpc = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce([{ lease_token: "fixture-token" }])
      .mockResolvedValueOnce({ deleted: pending, remaining: empty }).mockResolvedValueOnce(true);
    expect(await runLolCleanup(rpc, ["--apply"], true)).toMatchObject({ deletedCount: 2, remainingCount: 0, batches: 1 });
    expect(rpc).toHaveBeenNthCalledWith(3, "cleanup_lol_expired_batch", { p_limit: 100 });
    expect(rpc).toHaveBeenLastCalledWith("release_lol_collection_lease", { p_key: "ops:expired-cleanup", p_token: "fixture-token" });
  });
  it("중복 실행과 배치 오류를 숨기지 않고 해제한다", async () => {
    const rpc = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce([]);
    await expect(runLolCleanup(rpc, ["--apply"], true)).rejects.toThrow("진행 중");
    rpc.mockReset().mockResolvedValueOnce(pending).mockResolvedValueOnce([{ lease_token: "fixture" }])
      .mockRejectedValueOnce(new Error("batch_failed")).mockResolvedValueOnce(true);
    await expect(runLolCleanup(rpc, ["--apply"], true)).rejects.toThrow("batch_failed");
    expect(rpc).toHaveBeenLastCalledWith("release_lol_collection_lease", { p_key: "ops:expired-cleanup", p_token: "fixture" });
  });
  it("대기 후 최대 10배치에서 멈추며 남은 대상을 보고한다", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn().mockImplementation(async (name) => name === "preview_lol_expired_data" ? pending
      : name === "acquire_lol_collection_lease" ? [{ lease_token: "fixture" }]
      : name === "cleanup_lol_expired_batch" ? { deleted: pending, remaining: pending } : true);
    const result = runLolCleanup(rpc, ["--apply"], true);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ batches: 10, deletedCount: 20, remainingCount: 2 });
    expect(rpc.mock.calls.filter(([name]) => name === "cleanup_lol_expired_batch")).toHaveLength(10);
  });
});
