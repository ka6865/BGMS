import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve("supabase/migrations/20260526022000_auth_profiles_trigger.sql");

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
});
