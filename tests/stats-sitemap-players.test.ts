import { beforeEach, describe, expect, it, vi } from "vitest";

const query = { filters: [] as string[], rows: [] as unknown[], error: null as unknown };
const settings = { value: JSON.stringify([{ platform: "steam", nickname: "Hidden" }]) as string | null, error: null as unknown };

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "system_settings") {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: settings.value === null ? null : { value: settings.value }, error: settings.error }) };
        return chain;
      }
      const chain: any = {};
      for (const name of ["select", "gte", "not", "order"]) chain[name] = (...args: unknown[]) => { query.filters.push(`${name}:${String(args[0])}`); return chain; };
      chain.limit = async (n: number) => { query.filters.push(`limit:${n}`); return { data: query.rows, error: query.error }; };
      return chain;
    },
  }),
}));

describe("사이트맵 플레이어 목록", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder";
    query.filters = [];
    query.error = null;
    settings.error = null;
    query.rows = [
      { id: "account.1", platform: "steam", nickname: "Player One", updated_at: "2026-11-10T00:00:00Z" },
      { id: "account.2", platform: "steam", nickname: "Hidden", updated_at: null },
      { id: "account.3", platform: "kakao", nickname: null, updated_at: null },
    ];
  });

  it("최근 검색 조건으로 1000명까지 읽고 비공개·이름 없는 행을 뺀다", async () => {
    const { listPublicPlayersForSitemap } = await import("@/lib/stats/playerSeo.server");
    expect(await listPublicPlayersForSitemap()).toEqual([{ platform: "steam", nickname: "Player One", updatedAt: "2026-11-10T00:00:00Z" }]);
    expect(query.filters).toEqual(expect.arrayContaining(["gte:search_count", "gte:last_seen_at", "not:season_stats_data", "limit:1000"]));
  });

  it("조회나 비공개 목록 확인이 실패하면 빈 목록 대신 예외를 던진다", async () => {
    const { listPublicPlayersForSitemap } = await import("@/lib/stats/playerSeo.server");
    query.error = new Error("db");
    await expect(listPublicPlayersForSitemap()).rejects.toThrow("sitemap_players_query_failed");
    query.error = null;
    settings.error = new Error("settings");
    await expect(listPublicPlayersForSitemap()).rejects.toThrow();
  });
});
