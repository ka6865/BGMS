import { NextResponse } from "next/server";
import { isUuid } from "@/lib/board/imageStorageContract";
import {
  getSupportAttachmentSignedUrl,
  SupportAttachmentError,
} from "@/lib/support/attachmentStorage.server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "첨부파일을 찾을 수 없습니다." }, { status: 404 });
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { data: profile } = await auth.supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  try {
    const signedUrl = await getSupportAttachmentSignedUrl({
      supabaseAdmin: auth.supabaseAdmin as any,
      attachmentId: id,
      actor: { userId: auth.user.id, isAdmin },
    });
    return privateJson({ signedUrl, expiresIn: 300 });
  } catch (error) {
    const code = error instanceof SupportAttachmentError ? error.code : "unavailable";
    if (code === "not_found") return privateJson({ error: "첨부파일을 찾을 수 없습니다." }, 404);
    return privateJson({ error: "첨부파일 URL을 만들지 못했습니다." }, 503);
  }
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}
