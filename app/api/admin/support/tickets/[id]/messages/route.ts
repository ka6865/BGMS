import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import { requireAdmin } from "@/lib/server/adminGuard";
import { createSupportReplyNotification } from "@/lib/support/supportNotifications.server";
import { appendSupportMessage, getSupportTicketForActor, SupportStoreError } from "@/lib/support/ticketStore.server";
import { parseSupportMessageInput } from "@/lib/support/validation";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = parseSupportMessageInput(body);
  if (!parsed.ok) return NextResponse.json({ error: "메시지 입력값을 확인해 주세요." }, { status: 400 });
  try {
    const ticket = await getSupportTicketForActor(admin.supabaseAdmin as any, id, { userId: admin.user.id, isAdmin: true });
    if (!ticket || !ticket.requester_id) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    const message = await appendSupportMessage(admin.supabaseAdmin as any, {
      ticketId: id,
      actor: { userId: admin.user.id, isAdmin: true },
      senderType: "admin",
      body: parsed.value.body,
    });
    const previewText = parsed.value.body.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 200);
    await createSupportReplyNotification(admin.supabaseAdmin as any, {
      ticketId: id,
      requesterId: ticket.requester_id,
      adminId: admin.user.id,
      previewText,
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    const code = error instanceof SupportStoreError || isStoreError(error) ? (error as { code: string }).code : "database";
    if (code === "not_found" || code === "forbidden") return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ error: "메시지를 저장하지 못했습니다." }, { status: 503 });
  }
}
function isStoreError(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}
