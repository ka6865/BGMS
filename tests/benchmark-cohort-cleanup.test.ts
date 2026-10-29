import { describe, expect, it, vi } from "vitest";
import {
  BENCHMARK_COHORT_BATCH_LIMIT,
  BENCHMARK_COHORT_RETENTION_DAYS,
  cleanupBenchmarkCohort,
  parseCleanupSummary,
} from "../scripts/cleanup_benchmark_cohort";

const NOW = new Date("2026-10-30T00:00:00.000Z");

function summary(overrides: Record<string, unknown> = {}) {
  return {
    dry_run: true,
    candidate_players: 2,
    searched_players_kept: 1,
    processed_match_telemetry: 3,
    pubg_match_performance: 3,
    pubg_player_matches: 1,
    pubg_player_cache: 1,
    global_benchmarks_pseudonymized: 3,
    weapon_meta_match_samples_pseudonymized: 6,
    match_stats_raw_pseudonymized: 3,
    cohort_rows_deleted: 0,
    remaining_candidates: 2,
    ...overrides,
  };
}

function createClient(results: unknown[]) {
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>>(
    async () => ({ data: results.shift(), error: null }),
  );
  return { client: { rpc } as never, rpc };
}

describe("은퇴 벤치마커 식별 정보 정리", () => {
  it("기본 실행은 90일 기준 dry-run 한 번만 호출하고 변경하지 않는다", async () => {
    const { client, rpc } = createClient([summary()]);
    const messages: string[] = [];
    const result = await cleanupBenchmarkCohort(client, { now: NOW, write: (message) => messages.push(message) });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("cleanup_retired_benchmark_cohort", {
      p_retired_before: new Date(NOW.getTime() - BENCHMARK_COHORT_RETENTION_DAYS * 86_400_000).toISOString(),
      p_apply: false,
      p_limit: BENCHMARK_COHORT_BATCH_LIMIT,
    });
    expect(result.dry_run).toBe(true);
    expect(messages.join(" ")).toContain("--apply");
  });

  it("--apply는 dry-run 뒤 남은 대상이 없을 때까지 묶음으로 정리하고 합계를 돌려준다", async () => {
    const { client, rpc } = createClient([
      summary(),
      summary({ dry_run: false, candidate_players: 1, cohort_rows_deleted: 1, processed_match_telemetry: 2, remaining_candidates: 1 }),
      summary({ dry_run: false, candidate_players: 1, cohort_rows_deleted: 1, processed_match_telemetry: 1, remaining_candidates: 0 }),
    ]);
    const result = await cleanupBenchmarkCohort(client, { now: NOW, apply: true, write: () => undefined });

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.map(([, args]) => args.p_apply)).toEqual([false, true, true]);
    expect(result).toMatchObject({ dry_run: false, cohort_rows_deleted: 2, processed_match_telemetry: 3, remaining_candidates: 0 });
  });

  it("묶음 상한에서 멈추고 RPC 오류나 잘못된 결과는 실패로 드러낸다", async () => {
    const endless = Array.from({ length: 4 }, () => summary({ dry_run: false, candidate_players: 1, remaining_candidates: 5 }));
    const { client, rpc } = createClient([summary(), ...endless]);
    await cleanupBenchmarkCohort(client, { now: NOW, apply: true, maxBatches: 2, write: () => undefined });
    expect(rpc).toHaveBeenCalledTimes(3);

    expect(() => parseCleanupSummary({ ...summary(), processed_match_telemetry: -1 })).toThrow("benchmark-cohort-cleanup-invalid-rpc-result");
    expect(() => parseCleanupSummary({ ...summary(), dry_run: "yes" })).toThrow("benchmark-cohort-cleanup-invalid-rpc-result");
    const failing = { rpc: vi.fn(async () => ({ data: null, error: { message: "permission denied" } })) } as never;
    await expect(cleanupBenchmarkCohort(failing, { now: NOW, write: () => undefined })).rejects.toThrow("permission denied");
  });
});
