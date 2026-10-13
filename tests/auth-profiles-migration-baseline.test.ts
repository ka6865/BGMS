import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve("supabase/migrations/20260526022000_auth_profiles_trigger.sql");
const BASELINE_PATH = resolve("tests/fixtures/migration-check/baseline-schema.sql");
const BASELINE_VERIFY_PATH = resolve("scripts/verify_baseline_restore.sh");

describe("인증 프로필 마이그레이션 기준선", () => {
  it("새 데이터베이스에서 트리거보다 먼저 profiles 테이블을 준비한다", () => {
    const source = readFileSync(MIGRATION_PATH, "utf8");
    const tableIndex = source.indexOf("CREATE TABLE IF NOT EXISTS public.profiles");
    const triggerFunctionIndex = source.indexOf("CREATE OR REPLACE FUNCTION public.handle_new_user()");

    expect(tableIndex).toBeGreaterThanOrEqual(0);
    expect(triggerFunctionIndex).toBeGreaterThan(tableIndex);

    for (const requiredFragment of [
      "nickname text UNIQUE",
      "pubg_platform text DEFAULT 'steam'",
      "ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY",
      "CREATE POLICY \"Users can update own profile\"",
      "CREATE POLICY \"누구나 프로필 조회 가능\"",
    ]) {
      expect(source).toContain(requiredFragment);
    }
  });

  it("2026-08 baseline 이후 모든 migration을 소유한 격리 DB에 적용한다", () => {
    const baseline = readFileSync(BASELINE_PATH, "utf8");
    const verifier = readFileSync(BASELINE_VERIFY_PATH, "utf8");

    expect(baseline).toContain("2026-08-01 실측");
    expect(verifier).toContain("202608");
    expect(verifier).not.toMatch(/202608\*\.sql\s+supabase\/migrations\/202609\*\.sql/);
    expect(verifier).toMatch(/find [\s\S]*supabase\/migrations/);
    expect(verifier).toContain("sort)");
    expect(verifier).toMatch(/mktemp/);
    expect(verifier).toContain("postgresql@17");
    expect(verifier).toContain('docker rm -f "$CONTAINER_ID"');
    expect(verifier).not.toMatch(/docker rm -f "\$CONTAINER_NAME"/);
  });
});
