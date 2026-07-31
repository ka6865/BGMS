import { describe, expect, it, vi } from "vitest";
import {
  MATCH_STATS_RAW_BATCH_LIMIT,
  compactMatchStatsRaw,
} from "../scripts/cleanup_match_stats_raw";

type RpcResult = {
  candidate_count: number;
  deleted_count: number;
  remaining_count: number;
  dry_run: boolean;
};

function createClient(results: RpcResult[]) {
  const rpc = vi.fn(async () => ({
    data: results.shift(),
    error: null,
  }));
  return { client: { rpc } as never, rpc };
}

describe("match_stats_raw 기존 데이터 정리", () => {
  it("기본 실행은 dry-run 한 번만 수행하고 대상 건수를 출력한다", async () => {
    const { client, rpc } = createClient([{
      candidate_count: 330_931,
      deleted_count: 0,
      remaining_count: 330_931,
      dry_run: true,
    }]);
    const messages: string[] = [];

    const result = await compactMatchStatsRaw(client, { write: (message) => messages.push(message) });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("compact_match_stats_raw", {
      p_apply: false,
      p_batch_limit: MATCH_STATS_RAW_BATCH_LIMIT,
    });
    expect(messages.join(" ")).toContain("330,931");
    expect(result).toEqual({
      candidateCount: 330_931,
      deletedCount: 0,
      remainingCount: 330_931,
      dryRun: true,
      hasRemaining: true,
    });
  });

  it("apply도 먼저 dry-run 대상 건수를 출력한 뒤 제한된 배치로 삭제한다", async () => {
    const { client, rpc } = createClient([
      {
        candidate_count: 7_200,
        deleted_count: 0,
        remaining_count: 7_200,
        dry_run: true,
      },
      {
        candidate_count: 7_200,
        deleted_count: 5_000,
        remaining_count: 2_200,
        dry_run: false,
      },
      {
        candidate_count: 2_200,
        deleted_count: 2_200,
        remaining_count: 0,
        dry_run: false,
      },
    ]);
    const messages: string[] = [];

    const result = await compactMatchStatsRaw(client, {
      apply: true,
      write: (message) => messages.push(message),
    });

    expect(rpc.mock.calls[0]).toEqual([
      "compact_match_stats_raw",
      { p_apply: false, p_batch_limit: MATCH_STATS_RAW_BATCH_LIMIT },
    ]);
    expect(rpc.mock.calls.slice(1)).toEqual([
      ["compact_match_stats_raw", { p_apply: true, p_batch_limit: MATCH_STATS_RAW_BATCH_LIMIT }],
      ["compact_match_stats_raw", { p_apply: true, p_batch_limit: MATCH_STATS_RAW_BATCH_LIMIT }],
    ]);
    expect(messages[0]).toContain("7,200");
    expect(messages.join(" ")).toContain("VACUUM (FULL, ANALYZE) public.match_stats_raw");
    expect(result).toEqual({
      candidateCount: 7_200,
      deletedCount: 7_200,
      remainingCount: 0,
      dryRun: false,
      hasRemaining: false,
    });
  });

  it.each([99, 5_001])("안전 범위를 벗어난 batchLimit=%s를 거부한다", async (batchLimit) => {
    const { client, rpc } = createClient([]);

    await expect(compactMatchStatsRaw(client, { batchLimit }))
      .rejects.toThrow("match-stats-raw-cleanup-invalid-batch-limit");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("RPC 오류 원인을 숨기지 않는다", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));

    await expect(compactMatchStatsRaw({ rpc } as never))
      .rejects.toThrow("match_stats_raw 정리 RPC 실패: permission denied");
  });
});
