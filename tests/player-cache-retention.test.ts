import { describe, expect, it, vi } from "vitest";
import { cleanupInactivePlayerCache } from "../scripts/cleanup_telemetry";

type RpcResult = { data: unknown; error: { message: string } | null };

type RpcFn = (name: string, args?: Record<string, unknown>) => Promise<RpcResult>;

function createClient(results: RpcResult[]) {
  const rpc = vi.fn<RpcFn>(async () => results.shift() ?? { data: null, error: null });
  return { client: { rpc } as never, rpc };
}

function compactionResult(deleted: number, remaining: number): RpcResult {
  return {
    data: {
      candidate_count: deleted + remaining,
      deleted_count: deleted,
      remaining_count: remaining,
      total_count: 1_000,
      retention_days: 90,
      dry_run: false,
    },
    error: null,
  };
}

describe("pubg_player_cache 보존 정책", () => {
  it("last_seen_at 기준 보존 기간으로 RPC를 호출한다", async () => {
    const { client, rpc } = createClient([compactionResult(0, 0)]);

    await cleanupInactivePlayerCache(client);

    expect(rpc).toHaveBeenCalledWith("compact_pubg_player_cache", {
      p_retention_days: 90,
      p_apply: true,
      p_batch_limit: 5_000,
      p_keep_recent: 150_000,
    });
  });

  it("남은 대상이 있으면 배치를 반복 호출한다", async () => {
    const { client, rpc } = createClient([
      compactionResult(5_000, 12_000),
      compactionResult(5_000, 7_000),
      compactionResult(5_000, 2_000),
      compactionResult(2_000, 0),
    ]);

    await cleanupInactivePlayerCache(client);

    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it("한 번 실행의 삭제 규모에 상한을 둔다", async () => {
    // 잔여 대상이 계속 남아 있어도 배치 상한에서 멈춘다.
    // 배포 직후 27만 행이 한 번에 삭제되지 않도록 하는 안전장치다.
    const many = Array.from({ length: 100 }, () => compactionResult(5_000, 250_000));
    const { client, rpc } = createClient(many);

    await cleanupInactivePlayerCache(client);

    expect(rpc.mock.calls.length).toBeLessThanOrEqual(10);
    expect(rpc.mock.calls.length).toBeGreaterThan(1);
  });

  it("삭제가 진행되지 않으면 무한 반복하지 않고 멈춘다", async () => {
    // 잔여 건수가 보고되지만 실제 삭제가 0이면 더 진행할 수 없는 상태다.
    const { client, rpc } = createClient([compactionResult(0, 9_999)]);

    await cleanupInactivePlayerCache(client);

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("상한 인자를 반드시 넘긴다", async () => {
    // p_keep_recent 를 빼면 RPC 기본값 null 이 적용되어 상한 없이
    // 활동 신호가 없는 행 전부(실측 42만)가 삭제 대상이 된다.
    // 자동완성 후보 풀이 589행까지 줄어드는 결과라 반드시 명시해야 한다.
    const { client, rpc } = createClient([compactionResult(0, 0)]);

    await cleanupInactivePlayerCache(client);

    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(args?.p_keep_recent).toBeTypeOf("number");
    expect(args?.p_keep_recent).toBeGreaterThan(0);
  });

  it("RPC 오류는 조용히 넘기지 않는다", async () => {
    const { client } = createClient([{ data: null, error: { message: "boom" } }]);

    await expect(cleanupInactivePlayerCache(client)).rejects.toThrow(
      "telemetry-cleanup-player-cache-failed",
    );
  });

  it("형식이 어긋난 응답을 성공으로 처리하지 않는다", async () => {
    const { client } = createClient([{ data: { deleted_count: "many" }, error: null }]);

    await expect(cleanupInactivePlayerCache(client)).rejects.toThrow(
      "telemetry-cleanup-player-cache-invalid-result",
    );
  });
});

describe("전적 조회 라우트의 last_seen_at 기록", () => {
  it("사용자 조회 시 last_seen_at 을 갱신한다", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/pubg/player/route.ts"),
      "utf8",
    );

    expect(source).toContain("last_seen_at: nowIso");
  });

  it("매치 분석의 대량 upsert 는 last_seen_at 을 쓰지 않는다", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "lib/pubg-analysis/persistMatchAnalysis.ts"),
      "utf8",
    );

    // 이 파일이 last_seen_at 을 쓰기 시작하면 보존 정책이 다시 무력화된다.
    expect(source).not.toContain("last_seen_at");
  });
});
