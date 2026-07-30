import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";

/**
 * 적용 로그 1건을 되돌립니다.
 *
 * revert_weapon_patch_apply RPC 가 적용 전 스냅샷의 값과 patch_version 을
 * 함께 복원하고, 로그에 되돌린 사람과 시각을 기록합니다.
 */
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  const body = await request.json().catch(() => null);
  const logId = (body as { logId?: unknown } | null)?.logId;

  if (typeof logId !== "string" || logId.length === 0) {
    return NextResponse.json({ error: "logId 가 필요합니다." }, { status: 400 });
  }

  const { error } = await admin.supabaseAdmin.rpc("revert_weapon_patch_apply", {
    p_log_id: logId,
    p_actor: admin.user.id,
  });

  if (error) {
    return NextResponse.json({ error: `되돌리기 실패: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

/** 적용 이력을 최신순으로 조회합니다. 되돌리기 대상을 고르는 데 사용합니다. */
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  const { searchParams } = new URL(request.url);
  const proposalId = searchParams.get("proposalId");

  let query = admin.supabaseAdmin
    .from("weapon_patch_apply_log")
    .select(
      "id,proposal_id,target_table,target_id,column_name,patch_version,previous_patch_version,applied_at,reverted_at"
    )
    .order("applied_at", { ascending: false })
    .limit(100);

  if (proposalId) query = query.eq("proposal_id", proposalId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: `이력 조회 실패: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ logs: data ?? [] });
}
