import { describe, expect, it, vi } from "vitest";
import { runLolPendingBenchmarks } from "../scripts/lol_aggregate_pending_benchmarks";

describe("미집계 경기 재처리", () => {
  const pending = [{ match_id: "KR_1" }, { match_id: "KR_2" }];
  it("기본 dry-run은 조회만 한다", async () => {
    const rpc = vi.fn().mockResolvedValue(pending);
    expect(await runLolPendingBenchmarks(rpc, [], false)).toEqual({ dryRun: true, pending: 2, processed: 0 });
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("apply 플래그 없이는 쓰지 않고 실행 시간 안에서만 처리한다", async () => {
    const rpc = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue({});
    await expect(runLolPendingBenchmarks(rpc, ["--apply"], false)).rejects.toThrow("disabled");
    expect(rpc).not.toHaveBeenCalled();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(60_000);
    expect(await runLolPendingBenchmarks(rpc, ["--apply"], true, now)).toEqual({ dryRun: false, pending: 2, processed: 1 });
    expect(rpc).toHaveBeenLastCalledWith("aggregate_lol_match_benchmarks", { p_match_id: "KR_1" });
  });
  it("경기 집계 실패를 성공 처리하지 않는다", async () => {
    const rpc = vi.fn().mockResolvedValueOnce(pending).mockRejectedValue(new Error("db_error"));
    await expect(runLolPendingBenchmarks(rpc, ["--apply"], true)).rejects.toThrow("db_error");
  });
});
