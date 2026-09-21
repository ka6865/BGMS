import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import { SUPPORT_LIMITS } from "@/lib/support/contracts";
import { resolveSupportPlayerTarget, SupportPlayerLookupError } from "@/lib/support/playerTarget.server";
import { createSupportTicket, listSupportTicketsForUser, SupportStoreError } from "@/lib/support/ticketStore.server";
import { parseSupportCreateTicketInput } from "@/lib/support/validation";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const body = await parseBody(request);
  const parsed = parseSupportCreateTicketInput(body);
  if (!parsed.ok) return NextResponse.json({ error: validationMessage(parsed.code) }, { status: validationStatus(parsed.code) });

  const now = Date.now();
  const countResult = await (auth.supabaseAdmin as any)
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .eq("requester_id", auth.user.id)
    .gte("created_at", new Date(now - 24 * 60 * 60 * 1000).toISOString());
  if (countResult.error) return NextResponse.json({ error: "문의 제한을 확인하지 못했습니다." }, { status: 503 });
  if ((countResult.count ?? 0) >= SUPPORT_LIMITS.dailyTicketCount) {
    return NextResponse.json({ error: "24시간 문의 한도를 초과했습니다." }, { status: 429 });
  }

  let target: Awaited<ReturnType<typeof resolveSupportPlayerTarget>> | null = null;
  if (parsed.value.category === "privacy") {
    try {
      target = await resolveSupportPlayerTarget({
        platform: parsed.value.platform!,
        nickname: parsed.value.nickname!,
        supabaseAdmin: auth.supabaseAdmin as any,
        signal: request.signal,
      });
    } catch (error) {
      const code = error instanceof SupportPlayerLookupError || isLookupError(error) ? (error as { code: string }).code : "unavailable";
      if (code === "not_found") return NextResponse.json({ error: "플레이어를 찾을 수 없습니다." }, { status: 404 });
      if (code === "rate_limited") return NextResponse.json({ error: "잠시 후 다시 시도해 주세요." }, { status: 429 });
      return NextResponse.json({ error: "플레이어를 확인하지 못했습니다." }, { status: 503 });
    }
    if (target.canonicalNickname.toLowerCase() !== parsed.value.nickname!.toLowerCase()) {
      return NextResponse.json({ error: "입력한 닉네임과 확인된 플레이어가 일치하지 않습니다." }, { status: 400 });
    }
  }

  const attachments = await verifyReadyAttachments(auth.supabaseAdmin, auth.user.id, parsed.value.attachmentIds);
  if (!attachments.ok) return NextResponse.json({ error: attachments.error }, { status: attachments.status });

  try {
    const ticket = await createSupportTicket(auth.supabaseAdmin as any, {
      requesterId: auth.user.id,
      category: parsed.value.category,
      subject: parsed.value.subject,
      body: parsed.value.body,
      verificationStatus: parsed.value.verificationStatus,
      targetPlatform: target?.platform ?? null,
      targetNickname: target?.requestedNickname ?? null,
      targetAccountId: target?.accountId ?? null,
      targetResolvedNickname: target?.canonicalNickname ?? null,
      attachmentIds: parsed.value.attachmentIds,
    });
    return privateJson({ ticket }, 201);
  } catch (error) {
    if (error instanceof SupportStoreError || isStoreError(error)) {
      const code = (error as { code: string }).code;
      if (code === "duplicate") return NextResponse.json({ error: "같은 대상의 처리 중 문의가 이미 있습니다." }, { status: 409 });
      if (code === "quota") return NextResponse.json({ error: "24시간 문의 한도를 초과했습니다." }, { status: 429 });
    }
    return NextResponse.json({ error: "문의를 저장하지 못했습니다." }, { status: 503 });
  }
}

export async function GET() {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  try {
    return privateJson({ tickets: await listSupportTicketsForUser(auth.supabaseAdmin as any, auth.user.id) });
  } catch {
    return privateJson({ error: "문의 목록을 불러오지 못했습니다." }, 503);
  }
}

async function verifyReadyAttachments(db: unknown, userId: string, attachmentIds: string[]) {
  if (attachmentIds.length === 0) return { ok: true as const };
  if (attachmentIds.length > SUPPORT_LIMITS.maxAttachments) return { ok: false as const, status: 400, error: "첨부파일 한도를 초과했습니다." };
  const result = await (db as any).from("support_attachments").select("id,uploader_id,ticket_id,status,byte_size,expires_at").in("id", attachmentIds);
  if (result.error) return { ok: false as const, status: 503, error: "첨부파일을 확인하지 못했습니다." };
  const rows = Array.isArray(result.data) ? result.data : [];
  const totalBytes = rows.reduce((sum: number, row: { byte_size?: unknown }) => sum + (typeof row.byte_size === "number" ? row.byte_size : 0), 0);
  const now = Date.now();
  const valid = rows.length === attachmentIds.length
    && rows.every((row: { id?: unknown; uploader_id?: unknown; ticket_id?: unknown; status?: unknown; expires_at?: unknown }) => (
      typeof row.id === "string" && isUuid(row.id) && row.uploader_id === userId && row.ticket_id === null && row.status === "ready"
      && (row.expires_at == null || (typeof row.expires_at === "string" && Date.parse(row.expires_at) > now))
    ));
  if (!valid) return { ok: false as const, status: 400, error: "첨부파일을 확인할 수 없습니다." };
  if (totalBytes > SUPPORT_LIMITS.totalAttachmentBytes) return { ok: false as const, status: 413, error: "첨부파일 한도를 초과했습니다." };
  return { ok: true as const };
}

function isLookupError(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}
function isStoreError(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}
function validationMessage(code: string): string {
  if (code === "privacy_evidence_required") return "전적 비공개 요청에는 스크린샷이 필요합니다.";
  if (code === "body_too_long" || code === "subject_too_long") return "문의 내용이 너무 깁니다.";
  return "문의 입력값을 확인해 주세요.";
}
function validationStatus(code: string): number {
  return code === "body_too_long" ? 413 : 400;
}
async function parseBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}
