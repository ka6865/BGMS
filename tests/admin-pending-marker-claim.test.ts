import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve("supabase/migrations/20260730100640_admin_pending_marker_claim.sql");

describe("관리자 제보 처리 claim", () => {
  it("승인·파기를 DB 행 잠금이 있는 단일 함수로 처리한다", () => {
    const source = readFileSync(migrationPath, "utf8");
    for (const fragment of ["process_pending_marker_admin_action", "FOR UPDATE", "INSERT INTO public.map_markers", "DELETE FROM public.pending_markers", "SECURITY DEFINER", "SET search_path = ''", "TO service_role"]) {
      expect(source).toContain(fragment);
    }
  });

  it("관리자 API가 Bearer와 쿠키를 모두 지원하는 인증 가드를 사용한다", () => {
    for (const routePath of ["app/api/admin/approve/route.ts", "app/api/admin/reject/route.ts"]) {
      const source = readFileSync(resolve(routePath), "utf8");
      expect(source).toContain("withAuthGuard");
      expect(source).toContain("process_pending_marker_admin_action");
    }
  });
});
