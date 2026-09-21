import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import { requireAdmin } from "@/lib/server/adminGuard";
import { getSupportAttachmentSignedUrl, SupportAttachmentError } from "@/lib/support/attachmentStorage.server";
import { canTransitionSupportTicket } from "@/lib/support/validation";
import { getSupportTicketForActor } from "@/lib/support/ticketStore.server";

const STATUS_VALUES = new Set(["new", "in_progress", "awaiting_user", "answered", "resolved", "rejected"]);
const VERIFICATION_VALUES = new Set(["not_required", "pending", "verified", "additional_info", "rejected"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
  try {
    const ticket = await getSupportTicketForActor(admin.supabaseAdmin as any, id, { userId: admin.user.id, isAdmin: true });
    if (!ticket) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    const attachments = await Promise.all(ticket.attachments.map(async (attachment) => {
      try {
        const signedUrl = await getSupportAttachmentSignedUrl({
          supabaseAdmin: admin.supabaseAdmin as any,
          attachmentId: attachment.id,
          actor: { userId: admin.user.id, isAdmin: true },
        });
        return { ...attachment, signedUrl };
      } catch (error) {
        if (error instanceof SupportAttachmentError && error.code === "not_found") return attachment;
        return attachment;
      }
    }));
    return NextResponse.json({ ticket: { ...ticket, attachments } });
  } catch {
    return NextResponse.json({ error: "문의를 불러오지 못했습니다." }, { status: 503 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
  const body = await parseBody(request);
  if (!body || !hasOnlyKeys(body, ["status", "verificationStatus"])
    || (body.status !== undefined && (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)))
    || (body.verificationStatus !== undefined && (typeof body.verificationStatus !== "string" || !VERIFICATION_VALUES.has(body.verificationStatus)))) {
    return NextResponse.json({ error: "문의 상태 입력값이 올바르지 않습니다." }, { status: 400 });
  }
  if (body.status === undefined && body.verificationStatus === undefined) {
    return NextResponse.json({ error: "변경할 상태가 없습니다." }, { status: 400 });
  }
  try {
    const current = await getSupportTicketForActor(admin.supabaseAdmin as any, id, { userId: admin.user.id, isAdmin: true });
    if (!current) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    if (body.status && body.status !== current.status && !canTransitionSupportTicket(current.status, body.status as any)) {
      return NextResponse.json({ error: "허용되지 않은 문의 상태 전이입니다." }, { status: 400 });
    }
    if (body.verificationStatus && current.category !== "privacy" && body.verificationStatus !== "not_required") {
      return NextResponse.json({ error: "일반 문의에는 전적 검증 상태를 설정할 수 없습니다." }, { status: 400 });
    }
    if (body.verificationStatus === "not_required" && current.category === "privacy") {
      return NextResponse.json({ error: "전적 문의에는 검증 상태가 필요합니다." }, { status: 400 });
    }
    const patch: Record<string, unknown> = {};
    if (body.status) patch.status = body.status;
    if (body.verificationStatus) patch.verification_status = body.verificationStatus;
    if (body.status === "resolved" || body.status === "rejected") patch.resolved_at = new Date().toISOString();
    const updated = await (admin.supabaseAdmin as any).from("support_tickets").update(patch).eq("id", id).select("*").maybeSingle();
    if (updated.error) return NextResponse.json({ error: "문의 상태를 저장하지 못했습니다." }, { status: 503 });
    if (body.status && body.status !== current.status) {
      await (admin.supabaseAdmin as any).from("support_ticket_events").insert({
        ticket_id: id, actor_id: admin.user.id, event_type: "status_changed", from_status: current.status, to_status: body.status,
      });
    }
    if (body.verificationStatus && body.verificationStatus !== current.verification_status) {
      await (admin.supabaseAdmin as any).from("support_ticket_events").insert({
        ticket_id: id, actor_id: admin.user.id, event_type: "verification_changed", metadata: { to: body.verificationStatus },
      });
    }
    return NextResponse.json({ ticket: updated.data ?? { ...current, ...patch } });
  } catch {
    return NextResponse.json({ error: "문의 상태를 저장하지 못했습니다." }, { status: 503 });
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
