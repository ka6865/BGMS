import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { consumeBoardWriteQuota } from "@/lib/board/writeQuota.server";
import { extractClientIp } from "@/lib/board/ipUtils";
import { readGuestDeleteHash } from "@/lib/board/guestDelete.server";

/**
 * @fileoverview 비회원 게시글 삭제 API
 *
 * 비밀번호 대조 후 일치할 경우 게시글과 관련 댓글·좋아요를 함께 삭제합니다.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const { postId, password } = body ?? {};
    const numericPostId = typeof postId === "number" || typeof postId === "string" ? Number(postId) : Number.NaN;
    if (!Number.isSafeInteger(numericPostId) || numericPostId <= 0 || typeof password !== "string" || !password) {
      return NextResponse.json({ error: "필수 입력값이 누락되었습니다." }, { status: 400 });
    }

    const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey);
    const quota = await consumeBoardWriteQuota({ supabaseAdmin, scope: "post_delete", actor: extractClientIp(request) });
    if (!quota.ok) return NextResponse.json({ error: quota.error }, { status: quota.status, headers: quota.status === 429 ? { "Retry-After": "60" } : undefined });

    // 1. 게시글 조회 (비회원 게시글 여부 및 password_hash 확인)
    const { data: post, error: fetchError } = await supabaseAdmin
      .from("posts")
      .select("id, user_id, password_hash")
      .eq("id", numericPostId)
      .single();

    if (fetchError || !post) {
      return NextResponse.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    }

    // 회원 게시글은 이 라우트로 삭제 불가
    if (post.user_id !== null) {
      return NextResponse.json({ error: "회원 게시글은 로그인 후 삭제해주세요." }, { status: 403 });
    }

    const passwordHash = await readGuestDeleteHash({ supabaseAdmin, scope: "post", id: numericPostId, legacyHash: post.password_hash });
    if (!passwordHash) {
      return NextResponse.json({ error: "비밀번호 정보가 없는 게시글입니다." }, { status: 400 });
    }

    // 2. 비밀번호 대조
    const isMatch = await bcrypt.compare(password, passwordHash);
    if (!isMatch) {
      return NextResponse.json({ error: "비밀번호가 일치하지 않습니다." }, { status: 401 });
    }

    // 댓글·좋아요는 기존 ON DELETE CASCADE로 글과 함께 원자적으로 삭제한다.
    const { error: deleteError } = await supabaseAdmin
      .from("posts")
      .delete()
      .eq("id", numericPostId);

    if (deleteError) {
      console.error("[Guest Post Delete] DB error:", deleteError);
      return NextResponse.json({ error: "삭제 중 오류가 발생했습니다." }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[Guest Post Delete] Unexpected error:", err);
    return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
  }
}
