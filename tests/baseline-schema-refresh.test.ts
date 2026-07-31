import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASELINE_PATH, STRIPPED_PATTERNS, transformDump } from "../scripts/refresh_baseline_schema";

function baselineText(): string {
  return readFileSync(resolve(process.cwd(), BASELINE_PATH), "utf8");
}

/** 주석을 제외한 실행 구문만 남깁니다. 헤더 주석에 제거 대상 이름이 등장합니다. */
function statementsOnly(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("baseline 스키마 변환", () => {
  it("Supabase 플랫폼 전용 구문을 제거한다", () => {
    const dump = [
      'CREATE TABLE "public"."posts" (id bigint);',
      'CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";',
      'GRANT ALL ON TABLE "public"."posts" TO "anon";',
      'ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";',
    ].join("\n");

    const { content } = transformDump(dump);
    const statements = statementsOnly(content);

    expect(statements).not.toContain("supabase_vault");
    expect(statements).not.toContain("supabase_realtime");
    expect(content).toContain('CREATE TABLE "public"."posts"');
    expect(content).toContain('GRANT ALL ON TABLE "public"."posts"');
  });

  it("확장이 참조하는 스키마를 먼저 만든다", () => {
    // 덤프가 WITH SCHEMA "extensions" 를 쓰는데 그 스키마가 없으면 적용이 실패한다.
    const { content } = transformDump('CREATE TABLE "public"."posts" (id bigint);');

    expect(content).toContain('CREATE SCHEMA IF NOT EXISTS "extensions"');
    expect(content).toContain('CREATE SCHEMA IF NOT EXISTS "vault"');
  });

  it("직접 편집하지 말라는 안내를 남긴다", () => {
    const { content } = transformDump('CREATE TABLE "public"."posts" (id bigint);');

    expect(content).toContain("직접 편집하지 마세요");
  });

  it("제거 패턴은 플랫폼 전용에 한정한다", () => {
    // 여기에 일반 구문 패턴이 들어가면 baseline 에서 실제 객체가 사라진다.
    for (const pattern of STRIPPED_PATTERNS) {
      expect(pattern.test('CREATE TABLE "public"."posts" (id bigint);')).toBe(false);
      expect(pattern.test('CREATE POLICY "x" ON "public"."posts";')).toBe(false);
    }
  });
});

describe("baseline 파일 상태", () => {
  it("저장소에 baseline 이 존재한다", () => {
    // 이 파일이 없으면 빈 DB 복구 경로가 사라진다.
    // migration 만으로는 재현이 불가능하다(실측: 58개 중 26개 실패, 테이블 32/60).
    expect(existsSync(resolve(process.cwd(), BASELINE_PATH))).toBe(true);
  });

  it("핵심 테이블을 모두 담고 있다", () => {
    const content = baselineText();

    // migration 이력이 없어 baseline 이 유일한 정의인 테이블들이다.
    for (const table of [
      "posts",
      "comments",
      "profiles",
      "map_markers",
      "pubg_player_cache",
      "match_stats_raw",
      "processed_match_telemetry",
      "notifications",
      "post_likes",
      "global_benchmarks",
    ]) {
      expect(content).toContain(`"public"."${table}"`);
    }
  });

  it("RLS 활성화 구문을 포함한다", () => {
    const content = baselineText();
    const rlsCount = (content.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length;

    // 운영 실측으로 public 스키마 60개 테이블 전부 RLS 가 켜져 있다.
    expect(rlsCount).toBeGreaterThanOrEqual(55);
  });

  it("플랫폼 전용 구문이 남아 있지 않다", () => {
    // 헤더 주석은 무엇을 제거했는지 설명하므로 이름이 등장한다.
    const statements = statementsOnly(baselineText());

    expect(statements).not.toContain("supabase_vault");
    expect(statements).not.toContain("supabase_realtime");
  });
});
