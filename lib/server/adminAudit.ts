/**
 * @fileoverview 관리자 조작 감사 로그(public.admin_audit_events) 기록 헬퍼입니다.
 *
 * 기록 시점 원칙
 *   - 기록은 best-effort 이다. insert 가 실패해도 예외를 던지지 않고 서버 로그만 남긴다.
 *     감사 테이블 장애(예: migration 미적용)가 운영 조작 자체를 막으면 안 되기 때문이다.
 *   - 되돌릴 수 없는 삭제(회원 삭제, 게시글 강제 삭제)는 실행 직전에 "requested" 단계를 남기고,
 *     실행 뒤 결과("succeeded"/"failed")를 한 번 더 남긴다. 실행 도중 프로세스가 끊겨도 시도 기록이 남는다.
 *   - 그 외 조작은 실행이 끝난 뒤 결과와 함께 한 번 기록한다.
 *   - detail 에는 비밀값·토큰·이메일을 넣지 않는다.
 */

export type AdminAuditPhase = "requested" | "succeeded" | "failed";

export type AdminAuditEvent = {
  actorId: string | null | undefined;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  phase?: AdminAuditPhase;
  detail?: Record<string, unknown>;
};

/** 감사 로그를 남깁니다. 실패해도 throw 하지 않고 기록 성공 여부만 돌려준다. */
export async function recordAdminAudit(supabaseAdmin: any, event: AdminAuditEvent): Promise<boolean> {
  try {
    if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") return false;
    const table = supabaseAdmin.from("admin_audit_events");
    if (!table || typeof table.insert !== "function") return false;

    const { error } = await table.insert({
      actor_id: event.actorId || null,
      action: event.action,
      target_type: event.targetType ?? null,
      target_id: event.targetId === undefined || event.targetId === null ? null : String(event.targetId),
      detail: {
        ...(event.detail || {}),
        ...(event.phase ? { phase: event.phase } : {})
      }
    });
    if (error) {
      console.error("[ADMIN-AUDIT] insert failed:", event.action, error.message || error);
      return false;
    }
    return true;
  } catch (error: any) {
    console.error("[ADMIN-AUDIT] insert threw:", event.action, error?.message || error);
    return false;
  }
}
