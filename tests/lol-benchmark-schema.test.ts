import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261023050000_lol_benchmark_aggregates.sql", "utf8");
const previous = readFileSync("supabase/migrations/20261023040000_lol_player_summaries.sql", "utf8");
function definition(source: string, name: string) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  return source.slice(start, source.indexOf("end $$;", start) + "end $$;".length);
}
describe("익명 벤치마크 저장 계약", () => {
  it.each(["persist_lol_search_snapshot", "persist_lol_match_details"])("%s는 원문 저장 직후 집계 호출만 추가한다", (name) => {
    const next = definition(sql, name);
    expect(next.replace(/^\s*perform public.aggregate_lol_match_benchmarks\(v_match_id\);\n/m, "")).toBe(definition(previous, name));
    expect(next.indexOf("aggregate_lol_match_benchmarks(v_match_id)")).toBeLessThan(next.indexOf("upsert_lol_player_match_summaries(v_match_id"));
  });
  it("원문 전체 백필과 서비스 전용 RLS·RPC를 유지한다", () => {
    for (const table of ["lol_benchmark_processed_matches", "lol_benchmark_aggregates"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).not.toContain("security definer");
    expect(sql).toContain("from public.lol_matches where request_json is not null order by match_id");
    expect(sql).toContain("on conflict(match_id) do nothing");
  });
});
