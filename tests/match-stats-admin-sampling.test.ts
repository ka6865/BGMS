import { describe, expect, it, vi } from "vitest";
import { buildContentDraft } from "../lib/admin-agent/content";
import { runDbStatQuery } from "../lib/admin-agent/tools";

type Query = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => unknown;
};

function createSupabase(rows: Record<string, unknown[]> = {}) {
  const queries = new Map<string, Query[]>();
  const from = vi.fn((table: string) => {
    const query = {} as Query;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.gte = vi.fn(() => query);
    query.order = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.then = (resolve) => resolve({ data: rows[table] ?? [], error: null });
    const tableQueries = queries.get(table) ?? [];
    tableQueries.push(query);
    queries.set(table, tableQueries);
    return query;
  });

  return { supabase: { from }, queries };
}

describe("관리자 match stats 표본 조회", () => {
  it.each(["map_preference", "general_stats"])(
    "%s는 분석 대상자 표본만 최근순으로 조회한다",
    async (statType) => {
      const { supabase, queries } = createSupabase({
        match_stats_raw: [{ map_name: "Baltic_Main", kills: 2, damage: 240 }],
      });

      await runDbStatQuery(statType, supabase);

      const query = queries.get("match_stats_raw")?.[0];
      expect(query?.eq).toHaveBeenCalledWith("is_analysis_sample", true);
      expect(query?.order).toHaveBeenCalledWith("created_at", { ascending: false });
    },
  );

  it("top_players는 승자 전체에서 damage 상위 5명을 조회하는 계약을 유지한다", async () => {
    const { supabase, queries } = createSupabase({ match_stats_raw: [] });

    const result = await runDbStatQuery("top_players", supabase);

    const query = queries.get("match_stats_raw")?.[0];
    expect(query?.eq).toHaveBeenCalledWith("win_place", 1);
    expect(query?.eq).not.toHaveBeenCalledWith("is_analysis_sample", true);
    expect(query?.order).toHaveBeenCalledWith("damage", { ascending: false });
    expect(query?.limit).toHaveBeenCalledWith(5);
    expect(JSON.parse(result)).toEqual(expect.objectContaining({ data: [] }));
  });

  it("콘텐츠 맵 통계는 분석 대상자 표본만 사용하고 기존 결과 형식을 유지한다", async () => {
    const { supabase, queries } = createSupabase({
      match_stats_raw: [{ map_name: "Baltic_Main", kills: 2, damage: 240 }],
    });

    const draft = await buildContentDraft(supabase, { draftType: "map_trends" });

    const query = queries.get("match_stats_raw")?.[0];
    expect(query?.eq).toHaveBeenCalledWith("is_analysis_sample", true);
    expect(draft.sourceFacts.mapStats).toEqual({
      topMaps: [{ mapName: "Baltic_Main", matches: 1, avgKills: 2, avgDamage: 240 }],
    });
  });
});
