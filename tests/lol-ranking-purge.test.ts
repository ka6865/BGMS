import { describe, expect, it } from "vitest";
import { runLolRankingSeasonPurge } from "../scripts/lol_cleanup_expired";

describe("장인 시즌 작업 데이터 정리", () => {
  it("dry-run은 정리 RPC를 부르지 않는다", async () => {
    const calls: string[] = [];
    const rpc = (async (name: string) => { calls.push(name); return 0; }) as never;
    expect(await runLolRankingSeasonPurge(rpc, ["--dry-run"], false)).toEqual({ dryRun: true, deleted: null });
    expect(calls).toHaveLength(0);
  });

  it("apply는 현재 시각을 넘겨 종료 후 30일이 지난 행만 지우도록 호출한다", async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const rpc = (async (name: string, args: unknown) => { seen.push({ name, args }); return 3; }) as never;
    const now = new Date("2026-03-01T00:00:00Z");
    const result = await runLolRankingSeasonPurge(rpc, ["--apply"], true, now);
    expect(result).toEqual({ dryRun: false, deleted: 3 });
    expect(seen).toEqual([{ name: "purge_lol_expired_season_accounts", args: { p_now: "2026-03-01T00:00:00.000Z" } }]);
  });

  it("쓰기 플래그가 없으면 apply를 거절한다", async () => {
    const rpc = (async () => 0) as never;
    await expect(runLolRankingSeasonPurge(rpc, ["--apply"], false)).rejects.toThrow("LOL_CLEANUP_ENABLED");
  });
});
