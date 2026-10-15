import { describe, expect, it, vi } from "vitest";
import { rows } from "../scripts/cleanup_expired_match_archives";

function client(results: Array<{ data: unknown[] | null; error: { code?: string; message: string } | null }>) {
  const calls: string[] = [];
  const from = vi.fn((table: string) => {
    calls.push(table);
    const result = results.shift() ?? { data: [], error: null };
    const query: any = { select: () => query, eq: () => query, limit: () => query, abortSignal: async () => result };
    return query;
  });
  return { db: { from } as never, from, calls };
}

describe("archive 정리 참조 조회", () => {
  it("응답을 받지 못한 조회(오류 코드 없음)는 기다렸다가 다시 읽는다", async () => {
    const mock = client([
      { data: null, error: { message: "TypeError: fetch failed" } },
      { data: null, error: { code: "", message: "AbortError" } },
      { data: [{ match_id: "m1" }], error: null },
    ]);
    const sleep = vi.fn(async () => {});

    await expect(rows(mock.db, "pubg_match_performance", "match_id", "m1", "steam", sleep))
      .resolves.toEqual([{ match_id: "m1" }]);
    expect(mock.from).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1_000], [3_000]]);
  });

  it("재시도 뒤에도 응답이 없으면 기존 사유로 멈춘다", async () => {
    const lost = { data: null, error: { message: "TypeError: fetch failed" } };
    const mock = client([lost, lost, lost]);
    const sleep = vi.fn(async () => {});

    await expect(rows(mock.db, "pubg_match_performance", "match_id", "m1", "steam", sleep))
      .rejects.toThrow("retention-query-failed:pubg_match_performance:unknown");
    expect(mock.from).toHaveBeenCalledTimes(3);
  });

  it("DB가 거절한 오류는 다시 읽지 않는다", async () => {
    const mock = client([{ data: null, error: { code: "42501", message: "permission denied" } }]);
    const sleep = vi.fn(async () => {});

    await expect(rows(mock.db, "pubg_match_performance", "match_id", "m1", "steam", sleep))
      .rejects.toThrow("retention-query-failed:pubg_match_performance:42501");
    expect(mock.from).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
