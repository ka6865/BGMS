import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// 운영 migration 역할은 슈퍼유저가 아니라서, 확장 라이브러리가 로드되기 전에는
// pg_trgm.* 설정을 함수 설정(SET)으로 붙일 수 없다. 실제 역할 검증은 verify:migrations 에서 수행한다.
const MIGRATIONS_DIR = resolve("supabase/migrations");
const trgmMigration = readFileSync(
  resolve(MIGRATIONS_DIR, "20261014130000_suggest_similar_players_trgm_index_scan.sql"),
  "utf8",
);
const preload = "select public.similarity('', '');";

function hasTrgmPreload(source: string): boolean {
  const sql = source.replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$|'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\//g, " ");
  const loadIndex = sql.search(/(?:^|;)\s*select\s+public\.similarity\s*\(/i);
  const definitionIndex = sql.search(/\bcreate\s+(?:or\s+replace\s+)?function\b/i);
  return loadIndex >= 0 && loadIndex < definitionIndex;
}

describe("확장 설정을 함수에 붙이는 migration", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
  const targets = files.filter((name) =>
    /\bset\s+pg_trgm\.\w+\s*=/i.test(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8")),
  );

  it("검사 대상 migration 이 있다", () => {
    expect(targets).toContain("20261014130000_suggest_similar_players_trgm_index_scan.sql");
  });

  it.each([
    `-- ${preload}`,
    `/* ${preload} */`,
    `select '${preload.replaceAll("'", "''")}';`,
    `select '; ${preload.replaceAll("'", "''")}';`,
    `select $$; ${preload}$$;`,
    `select $q$; ${preload}$q$;`,
    "",
  ])("실행되지 않는 preload 는 인정하지 않는다: %s", (replacement) => {
    expect(hasTrgmPreload(trgmMigration.replace(preload, () => replacement))).toBe(false);
  });

  it("함수 정의 뒤의 preload 는 인정하지 않는다", () => {
    expect(hasTrgmPreload(trgmMigration.replace(preload, "") + preload)).toBe(false);
  });

  for (const name of targets) {
    it(`${name} 는 함수 정의 전에 pg_trgm 을 로드한다`, () => {
      const source = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
      expect(hasTrgmPreload(source)).toBe(true);
    });
  }
});
