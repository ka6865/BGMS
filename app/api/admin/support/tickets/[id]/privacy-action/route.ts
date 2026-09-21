import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import { requireAdmin } from "@/lib/server/adminGuard";
import { applySupportPrivacyAction, SupportPrivacyActionError } from "@/lib/support/privacyAction.server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
  try {
    const result = await applySupportPrivacyAction({ ticketId: id, actorId: admin.user.id, db: admin.supabaseAdmin as any });
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof SupportPrivacyActionError || isActionError(error) ? (error as { code: string }).code : "database";
    if (code === "not_found") return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    if (code === "not_verified" || code === "invalid_target") return NextResponse.json({ error: "검증 완료된 전적 문의만 처리할 수 있습니다." }, { status: 400 });
    return NextResponse.json({ error: "비공개 처리를 완료하지 못했습니다." }, { status: 503 });
  }
}
function isActionError(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}
