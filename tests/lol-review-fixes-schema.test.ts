import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261024040000_lol_review_fixes.sql", "utf8");
const foundation = readFileSync("supabase/migrations/20261022114157_lol_persistence_foundation.sql", "utf8");
function definition(source: string, name: string) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  return source.slice(start, source.indexOf("$$;", start) + 3);
}

describe("LoL 심사 보완 migration", () => {
  it("헤더 함수는 형식 오류 차단 시간 외에 기존 구현을 유지한다", () => {
    expect(definition(migration, "record_lol_riot_rate_headers")).toBe(
      definition(foundation, "record_lol_riot_rate_headers").replace(
        "((pg_catalog.timezone('UTC',v_now)::date + 1)::timestamp at time zone 'UTC')", "v_now + interval '10 minutes'",
      ),
    );
  });
  it("수집 lease 함수는 TTL 상한만 180초로 늘린다", () => {
    expect(definition(migration, "acquire_lol_collection_lease")).toBe(
      definition(foundation, "acquire_lol_collection_lease").replace("p_ttl_seconds not between 1 and 120", "p_ttl_seconds not between 1 and 180"),
    );
  });
});
