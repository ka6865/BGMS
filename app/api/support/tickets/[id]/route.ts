import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import { getSupportTicketForActor } from "@/lib/support/ticketStore.server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  try {
    const ticket = await getSupportTicketForActor(auth.supabaseAdmin as any, id, { userId: auth.user.id, isAdmin: false });
    if (!ticket) return NextResponse.json({ error: "문의를 찾을 수 없습니다." }, { status: 404 });
    return privateJson({ ticket });
  } catch {
    return privateJson({ error: "문의를 불러오지 못했습니다." }, 503);
  }
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}
