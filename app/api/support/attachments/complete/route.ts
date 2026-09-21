import { NextResponse } from "next/server";
import { hasOnlyKeys, isUuid } from "@/lib/board/imageStorageContract";
import {
  completeSupportAttachment,
  SupportAttachmentError,
} from "@/lib/support/attachmentStorage.server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  const body = await parseBody(request);
  if (!body || !hasOnlyKeys(body, ["attachmentId"]) || !isUuid(body.attachmentId)) {
    return NextResponse.json({ error: "첨부파일 요청이 올바르지 않습니다." }, { status: 400 });
  }
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  try {
    return privateJson(await completeSupportAttachment({
      supabaseAdmin: auth.supabaseAdmin as any,
      ownerUserId: auth.user.id,
      attachmentId: body.attachmentId,
    }));
  } catch (error) {
    const code = error instanceof SupportAttachmentError ? error.code : "unavailable";
    if (code === "not_found") return NextResponse.json({ error: "첨부파일을 찾을 수 없습니다." }, { status: 404 });
    if (code === "upload_missing") return NextResponse.json({ error: "업로드된 첨부파일을 확인할 수 없습니다." }, { status: 400 });
    if (code === "upload_metadata_invalid" || code === "upload_metadata_mismatch") {
      return NextResponse.json({ error: "업로드한 파일 정보가 예약 내용과 다릅니다." }, { status: 400 });
    }
    return NextResponse.json({ error: "첨부파일을 완료하지 못했습니다." }, { status: 503 });
  }
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
