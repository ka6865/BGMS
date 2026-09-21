import { NextResponse } from "next/server";
import { hasOnlyKeys } from "@/lib/board/imageStorageContract";
import {
  reserveSupportAttachment,
  SupportAttachmentError,
} from "@/lib/support/attachmentStorage.server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  const body = await parseBody(request);
  if (!body || !hasOnlyKeys(body, ["mimeType", "byteSize", "originalName"])
    || typeof body.mimeType !== "string"
    || typeof body.byteSize !== "number"
    || !Number.isInteger(body.byteSize)
    || typeof body.originalName !== "string"
    || body.originalName.length > 255) {
    return NextResponse.json({ error: "첨부파일 요청이 올바르지 않습니다." }, { status: 400 });
  }

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  try {
    const result = await reserveSupportAttachment({
      supabaseAdmin: auth.supabaseAdmin as any,
      ownerUserId: auth.user.id,
      mimeType: body.mimeType,
      byteSize: body.byteSize,
      originalName: body.originalName,
    });
    return privateJson(result);
  } catch (error) {
    return attachmentErrorResponse(error);
  }
}

function attachmentErrorResponse(error: unknown): NextResponse {
  const code = error instanceof SupportAttachmentError ? error.code : "unavailable";
  if (code === "attachment_quota") return NextResponse.json({ error: "첨부파일 한도를 초과했습니다." }, { status: 429 });
  if (code === "attachment_too_large") {
    return NextResponse.json({ error: "첨부파일 크기가 너무 큽니다." }, { status: 413 });
  }
  if (["unsupported_mime", "attachment_size_invalid", "invalid_input"].includes(code)) {
    return NextResponse.json({ error: "첨부파일 형식 또는 크기가 올바르지 않습니다." }, { status: 400 });
  }
  return NextResponse.json({ error: "첨부파일 업로드를 준비하지 못했습니다." }, { status: 503 });
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
