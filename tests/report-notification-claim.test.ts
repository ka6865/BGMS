import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve(
  "supabase/migrations/20260730094908_report_notification_claim.sql",
);
const ROUTE_PATH = resolve("app/api/report/notify/route.ts");

describe("제보 임계값 알림 claim", () => {
  it("DB에서 임계값과 미발송 상태를 조건부 갱신해 한 요청만 claim한다", () => {
    const source = readFileSync(MIGRATION_PATH, "utf8");

    for (const requiredFragment of [
      "claim_pending_marker_notification",
      "p_marker_id uuid",
      "p_direction text",
      "weight >= 5",
      "down_weight >= 5",
      "is_notified = false",
      "is_down_notified = false",
      "FOR UPDATE",
      "RETURNING",
      "SECURITY DEFINER",
      "SET search_path = ''",
      "REVOKE ALL ON FUNCTION public.claim_pending_marker_notification(uuid, text) FROM PUBLIC",
      "GRANT EXECUTE ON FUNCTION public.claim_pending_marker_notification(uuid, text) TO service_role",
    ]) {
      expect(source).toContain(requiredFragment);
    }
  });

  it("알림 API가 요청값을 신뢰하지 않고 DB claim RPC 결과만 발송 근거로 사용한다", () => {
    const source = readFileSync(ROUTE_PATH, "utf8");

    expect(source).toContain('type !== "up" && type !== "down"');
    expect(source).toMatch(/rpc\(\s*"claim_pending_marker_notification"/);
    expect(source).not.toContain('.from("pending_markers")\n      .select("*")');
  });
});
