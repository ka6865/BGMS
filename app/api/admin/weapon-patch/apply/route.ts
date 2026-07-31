import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";

interface ApplyResultRow {
  change_id: string;
  target_table: string;
  target_id: string;
  column_name: string;
  result: string;
}

/**
 * 승인된 변경 항목을 서비스 테이블에 적용합니다.
 *
 * 실제 쓰기는 apply_weapon_patch_proposal RPC 안에서 일어납니다.
 * RPC 는 항목별로 대상 행을 잠그고, 제안 시점 값과 현재 값이 다르면
 * stale 로 표시해 건너뛰며, 적용 전후 스냅샷을 로그에 남깁니다.
 */
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  const body = await request.json().catch(() => null);
  const proposalId = (body as { proposalId?: unknown } | null)?.proposalId;

  if (typeof proposalId !== "string" || proposalId.length === 0) {
    return NextResponse.json({ error: "proposalId 가 필요합니다." }, { status: 400 });
  }

  const { data, error } = await admin.supabaseAdmin.rpc("apply_weapon_patch_proposal", {
    p_proposal_id: proposalId,
    p_actor: admin.user.id,
  });

  if (error) {
    return NextResponse.json({ error: `적용 실패: ${error.message}` }, { status: 500 });
  }

  const rows = ((data ?? []) as unknown) as ApplyResultRow[];
  const applied = rows.filter((row) => row.result === "applied");
  const skipped = rows.filter((row) => row.result !== "applied");

  return NextResponse.json({
    success: true,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    results: rows.map((row) => ({
      changeId: row.change_id,
      targetTable: row.target_table,
      targetId: row.target_id,
      columnName: row.column_name,
      result: row.result,
    })),
  });
}
