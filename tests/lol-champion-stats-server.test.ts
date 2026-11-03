import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  result: { data: [{ updated_at: "2026-11-04T01:00:00.000Z" }, { updated_at: "2026-11-04T00:00:00.000Z" }], error: null } as { data: { updated_at: string }[] | null; error: unknown },
  query: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({
  rpc: (name: string) => ({ abortSignal: async () => name === "get_lol_stat_patches"
    ? { data: [{ patch: "16.21", matches: 100, timeline_matches: 50 }], error: null }
    : name === "get_lol_champion_detail"
      ? { data: { matches: 80, timelineMatches: 40, bans: 2, positions: [], builds: [], matchups: [] }, error: null }
      : { data: [{ team_position: "TOP", champion_id: 266, games: 20, wins: 12, bans: 3, matches: 100 }], error: null } }),
  from: mocks.from,
}) }));

import { getLolChampionDetailStats, getLolChampionStats } from "../lib/lol/championStats.server";

describe("챔피언 통계 집계시각 조회", () => {
  beforeEach(() => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
    mocks.query.length = 0;
    mocks.from.mockImplementation((table: string) => {
      mocks.query.push(["from", table]);
      const builder = {
        select(columns: string) { mocks.query.push(["select", columns]); return this; },
        eq(column: string, value: unknown) { mocks.query.push(["eq", column, value]); return this; },
        in(column: string, values: unknown) { mocks.query.push(["in", column, values]); return this; },
        order(column: string, options: unknown) { mocks.query.push(["order", column, options]); return this; },
        limit(count: number) { mocks.query.push(["limit", count]); return this; },
        abortSignal() { return Promise.resolve(mocks.result); },
      };
      return builder;
    });
    mocks.result = { data: [{ updated_at: "2026-11-04T01:00:00.000Z" }, { updated_at: "2026-11-04T00:00:00.000Z" }], error: null };
  });

  it("선택한 patch·queue·tiers의 totals만 최대 10행 읽고 표본을 보존한다", async () => {
    const stats = await getLolChampionStats(["DIAMOND", "MASTER"]);
    expect(stats).toMatchObject({ patch: "16.21", matches: 100, collectionUpdatedAt: "2026-11-04T01:00:00.000Z" });
    expect(stats.rows).toHaveLength(1);
    expect(mocks.query).toContainEqual(["from", "lol_stat_totals"]);
    expect(mocks.query).toContainEqual(["select", "updated_at"]);
    expect(mocks.query).toContainEqual(["eq", "patch", "16.21"]);
    expect(mocks.query).toContainEqual(["eq", "queue_id", 420]);
    expect(mocks.query).toContainEqual(["in", "tier", ["DIAMOND", "MASTER"]]);
    expect(mocks.query).toContainEqual(["limit", 10]);
  });

  it("상세도 같은 patch·queue·tiers 메타데이터만 읽고 상세 통계를 보존한다", async () => {
    const detail = await getLolChampionDetailStats(266, ["DIAMOND", "MASTER"]);
    expect(detail).toMatchObject({ matches: 80, collectionUpdatedAt: "2026-11-04T01:00:00.000Z" });
    expect(mocks.query).toContainEqual(["eq", "patch", "16.21"]);
    expect(mocks.query).toContainEqual(["eq", "queue_id", 420]);
    expect(mocks.query).toContainEqual(["in", "tier", ["DIAMOND", "MASTER"]]);
    expect(mocks.query).toContainEqual(["limit", 10]);
  });

  it("메타 조회 오류는 시각만 확인 불가로 두고 기본 통계와 표본을 유지한다", async () => {
    mocks.result = { data: null, error: new Error("metadata unavailable") };
    const stats = await getLolChampionStats(["DIAMOND"]);
    expect(stats).toMatchObject({ matches: 100, collectionUpdatedAt: null });
    expect(stats.rows).toHaveLength(1);
    const detail = await getLolChampionDetailStats(266, ["DIAMOND"]);
    expect(detail).toMatchObject({ matches: 80, collectionUpdatedAt: null });
  });
});
