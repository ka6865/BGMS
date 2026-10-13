import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { consumeBoardWriteQuota } from "@/lib/board/writeQuota.server";
import { extractClientIp } from "@/lib/board/ipUtils";
import { readGuestDeleteHash } from "@/lib/board/guestDelete.server";

/**
 * @fileoverview 비회원 댓글 삭제 API
 *
 * 비회원이 작성 시 등록한 비밀번호를 대조하여 일치할 경우에만 삭제를 허용합니다.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const { commentId, password } = body ?? {};
    const numericCommentId = typeof commentId === "number" || typeof commentId === "string" ? Number(commentId) : Number.NaN;
    if (!Number.isSafeInteger(numericCommentId) || numericCommentId <= 0 || typeof password !== "string" || !password) {
      return NextResponse.json({ error: "필수 입력값이 누락되었습니다." }, { status: 400 });
    }

    const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey);
    const quota = await consumeBoardWriteQuota({ supabaseAdmin, scope: "comment_delete", actor: extractClientIp(request) });
    if (!quota.ok) return NextResponse.json({ error: quota.error }, { status: quota.status, headers: quota.status === 429 ? { "Retry-After": "60" } : undefined });

    // 1. 댓글 조회 (비회원 댓글 여부 및 password_hash 확인)
    const { data: comment, error: fetchError } = await supabaseAdmin
      .from("comments")
      .select("id, user_id, password_hash")
      .eq("id", numericCommentId)
      .single();

    if (fetchError || !comment) {
      return NextResponse.json({ error: "댓글을 찾을 수 없습니다." }, { status: 404 });
    }

    // 회원 댓글은 이 라우트로 삭제 불가 (회원은 기존 클라이언트 직접 삭제 사용)
    if (comment.user_id !== null) {
      return NextResponse.json({ error: "회원 댓글은 로그인 후 삭제해주세요." }, { status: 403 });
    }

    const passwordHash = await readGuestDeleteHash({ supabaseAdmin, scope: "comment", id: numericCommentId, legacyHash: comment.password_hash });
    if (!passwordHash) {
      return NextResponse.json({ error: "비밀번호 정보가 없는 댓글입니다." }, { status: 400 });
    }

    // 2. 비밀번호 대조
    const isMatch = await bcrypt.compare(password, passwordHash);
    if (!isMatch) {
      return NextResponse.json({ error: "비밀번호가 일치하지 않습니다." }, { status: 401 });
    }

    // 3. 비회원 댓글 삭제
    const { error: deleteError } = await supabaseAdmin
      .from("comments")
      .delete()
      .eq("id", numericCommentId);

    if (deleteError) {
      console.error("[Guest Comment Delete] DB error:", deleteError);
      return NextResponse.json({ error: "삭제 중 오류가 발생했습니다." }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[Guest Comment Delete] Unexpected error:", err);
    return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
  }
}
