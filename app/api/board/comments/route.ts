import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { checkIpBlacklist, extractClientIp } from "@/lib/board/ipUtils";
import { checkProfanity } from "@/lib/board/profanityFilter";
import { TURNSTILE_ACTIONS } from "@/lib/board/turnstileContract";
import { verifyTurnstileToken } from "@/lib/board/turnstile.server";
import { consumeBoardWriteQuota } from "@/lib/board/writeQuota.server";
import { withOptionalAuth } from "@/utils/supabase/guard";

const CONTENT_MAX_LENGTH = 5000;
const AUTHOR_MAX_LENGTH = 20;
const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_MAX_LENGTH = 20;
const TOKEN_MAX_LENGTH = 2048;
const USER_ID_MAX_LENGTH = 128;

type PostTarget = {
  id: number;
  user_id: string | null;
  title: string;
  status: "published" | "draft";
};

type UserProfile = { nickname: string | null; role: string | null };

type CommentBody = {
  post_id: number;
  content: string;
  parent_id: number | null;
  author: string | null;
  password: string | null;
  user_id: string | null;
  turnstileToken: string | null;
};

type ParentCommentTarget = {
  id: number;
  post_id: number;
  user_id: string | null;
  author: string;
  content: string;
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNullableBoundedString(
  value: unknown,
  maxLength: number,
  minLength = 1,
): value is string | null | undefined {
  return value === null
    || value === undefined
    || (
      typeof value === "string"
      && value.length >= minLength
      && value.length <= maxLength
      && Boolean(value.trim())
    );
}

function parseCommentBody(value: unknown): CommentBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  const {
    post_id,
    content,
    parent_id,
    author,
    password,
    user_id,
    turnstileToken,
  } = body;

  if (
    !isPositiveSafeInteger(post_id)
    || typeof content !== "string"
    || !content.trim()
    || content.length > CONTENT_MAX_LENGTH
    || (parent_id !== null && parent_id !== undefined && !isPositiveSafeInteger(parent_id))
    || !isNullableBoundedString(author, AUTHOR_MAX_LENGTH)
    || !isNullableBoundedString(password, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH)
    || !isNullableBoundedString(user_id, USER_ID_MAX_LENGTH)
    || !isNullableBoundedString(turnstileToken, TOKEN_MAX_LENGTH)
  ) {
    return null;
  }

  return {
    post_id,
    content: content.trim(),
    parent_id: parent_id ?? null,
    author: author ?? null,
    password: password ?? null,
    user_id: user_id ?? null,
    turnstileToken: turnstileToken ?? null,
  };
}

export async function POST(request: Request) {
  let bodyValue: unknown;
  try {
    bodyValue = await request.json();
  } catch {
    return jsonError("요청 형식이 올바르지 않습니다.", 400);
  }

  const body = parseCommentBody(bodyValue);
  if (!body) {
    return jsonError("요청 형식이 올바르지 않습니다.", 400);
  }

  try {
    const auth = await withOptionalAuth();
    if (auth.error) return auth.error;

    const { user, supabaseAdmin } = auth;
    const clientIp = extractClientIp(request);
    let userProfile: UserProfile | null = null;

    if (!user) {
      const author = body.author?.trim() ?? "";
      const password = body.password ?? "";
      const token = body.turnstileToken?.trim() ?? "";
      if (!author || password.length < PASSWORD_MIN_LENGTH || !password.trim()) {
        return jsonError("필수 입력값이 누락되었습니다.", 400);
      }
      if (!token) {
        return jsonError("보안 인증 토큰이 필요합니다.", 400);
      }

      if (await checkIpBlacklist(clientIp, supabaseAdmin)) {
        return jsonError("차단된 IP입니다. 관리자에게 문의해주세요.", 403);
      }
    }

    if (!user) {
      const turnstile = await verifyTurnstileToken({
        token: body.turnstileToken,
        remoteIp: clientIp,
        expectedAction: TURNSTILE_ACTIONS.comment,
      });
      if (!turnstile.ok) {
        return jsonError(turnstile.error, turnstile.status);
      }
    }

    const quota = await consumeBoardWriteQuota({
      supabaseAdmin,
      scope: "comment",
      actor: user?.id ?? clientIp,
    });
    if (!quota.ok) {
      return jsonError(quota.error, quota.status);
    }

    const { data: post, error: postError } = await supabaseAdmin
      .from("posts")
      .select("id, user_id, title, status")
      .eq("id", body.post_id)
      .maybeSingle();
    if (postError) {
      return jsonError("게시글을 확인하지 못했습니다.", 503);
    }
    if (
      !post
      || !isPositiveSafeInteger(post.id)
      || typeof post.title !== "string"
      || (post.user_id !== null && typeof post.user_id !== "string")
      || (post.status !== "published" && post.status !== "draft")
    ) {
      return jsonError("게시글을 찾을 수 없습니다.", 404);
    }
    if (post.status === "draft") {
      if (!user) return jsonError("게시글을 찾을 수 없습니다.", 404);
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("nickname,role")
        .eq("id", user.id)
        .single();
      if (profileError) return jsonError("댓글 작성자를 확인하지 못했습니다.", 500);
      userProfile = profile as UserProfile | null;
      if (userProfile?.role !== "admin") return jsonError("게시글을 찾을 수 없습니다.", 404);
    }
    const postTarget: PostTarget = post;

    let parentTarget: ParentCommentTarget | null = null;
    if (body.parent_id) {
      const { data: parent, error: parentError } = await supabaseAdmin
        .from("comments")
        .select("id, post_id, user_id, author, content")
        .eq("id", body.parent_id)
        .maybeSingle();
      if (parentError) {
        return jsonError("부모 댓글을 확인하지 못했습니다.", 503);
      }
      if (!parent) {
        return jsonError("부모 댓글을 찾을 수 없습니다.", 404);
      }
      if (
        !isPositiveSafeInteger(parent.id)
        || !isPositiveSafeInteger(parent.post_id)
        || typeof parent.author !== "string"
        || !parent.author.trim()
        || typeof parent.content !== "string"
        || (parent.user_id !== null && typeof parent.user_id !== "string")
      ) {
        return jsonError("부모 댓글을 확인하지 못했습니다.", 503);
      }
      if (parent.post_id !== body.post_id) {
        return jsonError("부모 댓글이 게시글과 일치하지 않습니다.", 400);
      }
      parentTarget = parent;
    }

    let author: string;
    let passwordHash: string | null = null;
    let ipAddress: string | null = null;
    let storedContent = body.content;

    if (user) {
      if (checkProfanity(body.content).blocked) {
        return jsonError("부적절한 표현이 포함되어 있습니다. 내용을 수정해주세요.", 400);
      }
      if (!userProfile) {
        const { data: profile, error: profileError } = await supabaseAdmin
          .from("profiles")
          .select("nickname,role")
          .eq("id", user.id)
          .single();
        if (profileError) return jsonError("댓글 작성자를 확인하지 못했습니다.", 500);
        userProfile = profile as UserProfile | null;
      }
      author = typeof userProfile?.nickname === "string" && userProfile.nickname.trim()
        ? userProfile.nickname.trim()
        : "익명";
      if (parentTarget) {
        const replyPrefix = `@${parentTarget.author.trim()} `;
        if (!storedContent.startsWith(replyPrefix)) {
          storedContent = `${replyPrefix}${storedContent}`;
        }
        if (storedContent.length > CONTENT_MAX_LENGTH) {
          return jsonError("댓글은 5,000자 이하로 작성해주세요.", 400);
        }
      }
    } else {
      author = body.author!.trim();
      if (checkProfanity(author).blocked) {
        return jsonError("닉네임에 부적절한 표현이 포함되어 있습니다.", 400);
      }
      if (checkProfanity(body.content).blocked) {
        return jsonError("부적절한 표현이 포함되어 있습니다. 내용을 수정해주세요.", 400);
      }
      passwordHash = await bcrypt.hash(body.password!, 10);
      ipAddress = clientIp;
    }

    const commentFunction = post.status === "draft"
      ? "create_reviewable_post_comment"
      : "create_published_post_comment";
    const { data, error } = await supabaseAdmin.rpc(commentFunction, {
      p_post_id: body.post_id,
      p_user_id: user?.id ?? null,
      p_author: author,
      p_content: storedContent,
      p_parent_id: body.parent_id,
      p_password_hash: passwordHash,
      p_ip_address: ipAddress,
    });

    if (error) {
      return jsonError("댓글 저장 중 오류가 발생했습니다.", 500);
    }
    const comment = Array.isArray(data) ? data[0] : null;
    if (!comment) {
      return jsonError("게시글을 찾을 수 없습니다.", 404);
    }

    if (user) {
      const target = parentTarget ?? postTarget;
      if (target.user_id && target.user_id !== user.id) {
        await supabaseAdmin
          .from("notifications")
          .insert([{
            user_id: target.user_id,
            sender_id: user.id,
            sender_name: author,
            type: body.parent_id ? "reply" : "comment",
            post_id: body.post_id,
            preview_text: parentTarget ? parentTarget.content : postTarget.title,
          }]);
      }
    }

    return NextResponse.json({ success: true, data: comment });
  } catch {
    return jsonError("서버 오류가 발생했습니다.", 500);
  }
}
