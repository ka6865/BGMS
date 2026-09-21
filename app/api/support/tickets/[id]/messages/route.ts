import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import { appendSupportMessage, SupportStoreError } from "@/lib/support/ticketStore.server";
import { parseSupportMessageInput } from "@/lib/support/validation";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = parseSupportMessageInput(body);
  if (!parsed.ok) return NextResponse.json({ error: "메시지 입력값을 확인해 주세요." }, { status: 400 });
  try {
    const message = await appendSupportMessage(auth.supabaseAdmin as any, {
      ticketId: id,
      actor: { userId: auth.user.id, isAdmin: false },
      senderType: "user",
      body: parsed.value.body,
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
