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
  if (!parsed.ok) return NextResponse.json({ error: "메시지 입력값을 확인해 주세요." }, { status: parsed.code === "body_too_long" ? 413 : 400 });
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || crypto.randomUUID();
  if (!isUuid(idempotencyKey)) return NextResponse.json({ error: "메시지 요청 키가 올바르지 않습니다." }, { status: 400 });
  try {
    const ticket = await getSupportTicketForActor(admin.supabaseAdmin as any, id, { userId: admin.user.id, isAdmin: true });
    if (!ticket) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    const message = await appendSupportMessage(admin.supabaseAdmin as any, {
      ticketId: id,
      actor: { userId: admin.user.id, isAdmin: true },
      senderType: "admin",
      body: parsed.value.body,
      idempotencyKey,
    });
    if (ticket.requester_id && typeof (admin.supabaseAdmin as any).rpc !== "function") {
      const previewText = parsed.value.body.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 200);
      await createSupportReplyNotification(admin.supabaseAdmin as any, {
        ticketId: id,
        messageId: message.id,
        requesterId: ticket.requester_id,
        adminId: admin.user.id,
        previewText,
      });
    }
    return privateJson({ message }, 201);
  } catch (error) {
    const code = error instanceof SupportStoreError || isStoreError(error) ? (error as { code: string }).code : "database";
    if (code === "not_found" || code === "forbidden") return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    if (code === "idempotency_conflict") return NextResponse.json({ error: "같은 요청 키로 다른 답변을 보낼 수 없습니다." }, { status: 409 });
    return NextResponse.json({ error: "메시지를 저장하지 못했습니다." }, { status: 503 });
  }
}
function isStoreError(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}
