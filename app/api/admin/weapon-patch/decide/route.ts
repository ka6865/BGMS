import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import {
  decideProposalChanges,
  isChangeDecision,
} from "@/lib/patch-notes/weaponProposalQuery";

const MAX_CHANGE_IDS = 200;

/**
 * 변경 항목의 승인/거부 결정만 기록합니다. 서비스 테이블에는 쓰지 않습니다.
 * 실제 적용은 /api/admin/weapon-patch/apply 가 담당합니다.
 */
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  const { proposalId, changeIds, decision } = body as {
    proposalId?: unknown;
    changeIds?: unknown;
    decision?: unknown;
  };

  if (typeof proposalId !== "string" || proposalId.length === 0) {
    return NextResponse.json({ error: "proposalId 가 필요합니다." }, { status: 400 });
  }
  if (!isChangeDecision(decision) || decision === "pending") {
    return NextResponse.json(
      { error: "decision 은 accepted 또는 rejected 여야 합니다." },
      { status: 400 }
    );
  }
  if (!Array.isArray(changeIds) || changeIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "changeIds 는 문자열 배열이어야 합니다." }, { status: 400 });
  }
  if (changeIds.length > MAX_CHANGE_IDS) {
    return NextResponse.json(
      { error: `한 번에 결정할 수 있는 항목은 최대 ${MAX_CHANGE_IDS}건입니다.` },
      { status: 400 }
    );
  }

  const result = await decideProposalChanges(
    admin.supabaseAdmin,
    proposalId,
    changeIds as string[],
    decision,
    admin.user.id
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  return NextResponse.json({ success: true, updated: result.updated });
}
