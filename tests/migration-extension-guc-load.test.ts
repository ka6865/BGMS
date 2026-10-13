import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// 운영 migration 역할은 슈퍼유저가 아니라서, 확장 라이브러리가 로드되기 전에는
// pg_trgm.* 설정을 함수 설정(SET)으로 붙일 수 없다. 격리 검증은 슈퍼유저로 돌아 이 차이를 잡지 못한다.
const MIGRATIONS_DIR = resolve("supabase/migrations");

describe("확장 설정을 함수에 붙이는 migration", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
  const targets = files.filter((name) =>
    /\bset\s+pg_trgm\.\w+\s*=/i.test(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8")),
  );

  it("검사 대상 migration 이 있다", () => {
    expect(targets).toContain("20261014130000_suggest_similar_players_trgm_index_scan.sql");
  });

  for (const name of targets) {
    it(`${name} 는 함수 정의 전에 pg_trgm 을 로드한다`, () => {
      const source = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
      const loadIndex = source.search(/select\s+public\.similarity\(/i);
      const setIndex = source.search(/\bset\s+pg_trgm\.\w+\s*=/i);
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeLessThan(setIndex);
    });
  }
});
