import { NextResponse } from "next/server";
import { withAuthGuard, withOptionalAuth } from "@/utils/supabase/guard";
import { checkProfanity } from "@/lib/board/profanityFilter";
import { extractClientIp, checkIpBlacklist } from "@/lib/board/ipUtils";
import { consumeBoardWriteQuota } from "@/lib/board/writeQuota.server";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function hasImagePayload(content: string) {
  return /<img\b|data:image\/|!\[[^\]]*]\([^)]*\)/i.test(content);
}

type CommentCursor = { createdAt: string; id: number };

function parseLimit(rawLimit: string | null): number | null {
  if (rawLimit === null || rawLimit.trim() === "") return 50;
  const requested = Number(rawLimit);
  if (!Number.isSafeInteger(requested)) return null;
  return Math.min(Math.max(requested, 1), 50);
}

function isCursorTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function encodeCursor(row: { created_at: string; id: number }) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): CommentCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return isCursorTimestamp(parsed?.createdAt) && Number.isSafeInteger(parsed?.id) && parsed.id > 0
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function authorName(row: any) {
  return row.user_id ? row.profiles?.nickname || row.author || "알 수 없음" : row.author || "익명";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) return jsonError("댓글 수 제한이 올바르지 않습니다.", 400);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return jsonError("댓글 커서가 올바르지 않습니다.", 400);

  const auth = await withOptionalAuth();
  if (auth.error) return auth.error;
  const { data: post, error: postError } = await auth.supabaseAdmin
    .from("posts")
    .select("id,status")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (postError) return jsonError("게시글을 확인하지 못했습니다.", 503);
  if (!post) return jsonError("게시글을 찾을 수 없습니다.", 404);

  let query = auth.supabaseAdmin
    .from("comments")
    .select("id,post_id,user_id,author,content,parent_id,created_at,profiles(nickname)")
    .eq("post_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (cursor) {
    query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
  }
  const { data, error } = await query.limit(limit + 1);
  if (error) return jsonError("댓글을 불러오지 못했습니다.", 503);

  const { count, error: countError } = await auth.supabaseAdmin
    .from("comments")
    .select("id", { count: "exact", head: true })
    .eq("post_id", id);
  if (countError) return jsonError("댓글 수를 불러오지 못했습니다.", 503);

  const rows = Array.isArray(data) ? data : [];
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    postId: row.post_id,
    author: authorName(row),
    content: String(row.content || ""),
    parentId: row.parent_id,
    createdAt: row.created_at,
  }));
  const hasMore = rows.length > limit;
  return NextResponse.json({
    items,
    totalCount: Number(count || 0),
    hasMore,
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]) : null,
  }, { headers: {
    "Cache-Control": auth.user
      ? "private, no-store, max-age=0, must-revalidate"
      : "public, s-maxage=30, stale-while-revalidate=120",
  } });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ postId: string }> }
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;

  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return jsonError("요청 본문이 올바르지 않습니다.", 400);
    }
    body = value as Record<string, unknown>;
  } catch {
    return jsonError("요청 본문이 올바르지 않습니다.", 400);
  }

  const content = String(body.content || "").trim();
  const parentId = body.parent_id == null ? null : Number(body.parent_id);

  if (content.length < 1 || content.length > 1000) {
    return jsonError("댓글은 1~1000자로 입력해주세요.", 400);
  }
  if (hasImagePayload(content)) {
    return jsonError("모바일 앱에서는 사진 첨부를 지원하지 않습니다.", 400);
  }

  const { data: post } = await auth.supabaseAdmin
    .from("posts")
    .select("id,status,user_id,title")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (!post) return jsonError("게시글을 찾을 수 없습니다.", 404);

  let parentComment: { user_id: string | null; author: string | null; content: string | null } | null = null;
  if (parentId !== null) {
    if (!Number.isSafeInteger(parentId) || parentId <= 0) {
      return jsonError("부모 댓글 ID가 올바르지 않습니다.", 400);
    }

    const { data } = await auth.supabaseAdmin
      .from("comments")
      .select("id,user_id,author,content")
      .eq("id", parentId)
      .eq("post_id", id)
      .maybeSingle();

    parentComment = data;
    if (!parentComment) {
      return jsonError("부모 댓글을 찾을 수 없습니다.", 400);
    }
  }

  const clientIp = extractClientIp(request);
  const isBlocked = await checkIpBlacklist(clientIp, auth.supabaseAdmin);
  if (isBlocked) return jsonError("차단된 IP입니다. 관리자에게 문의해주세요.", 403);
  if (checkProfanity(content).blocked) {
    return jsonError("부적절한 표현이 포함되어 있습니다. 내용을 수정해주세요.", 400);
  }

  const quota = await consumeBoardWriteQuota({
    supabaseAdmin: auth.supabaseAdmin,
    scope: "comment",
    actor: auth.user.id,
  });
  if (!quota.ok) return jsonError(quota.error, quota.status);

  const { data: profile } = await auth.supabaseAdmin
    .from("profiles")
    .select("nickname")
    .eq("id", auth.user.id)
    .maybeSingle();

  const author = profile?.nickname || auth.user.email || "알 수 없음";
  const { data, error } = await auth.supabaseAdmin.rpc("create_published_post_comment", {
    p_post_id: id,
    p_user_id: auth.user.id,
    p_author: author,
    p_content: content,
    p_parent_id: parentId,
    p_password_hash: null,
    p_ip_address: clientIp,
  });

  if (error) return jsonError("댓글 저장 중 오류가 발생했습니다.", 500);
  const comment = Array.isArray(data) ? data[0] : null;
  if (!comment) return jsonError("게시글을 찾을 수 없습니다.", 404);

  const notificationTarget = parentId !== null ? parentComment : post;
  if (notificationTarget?.user_id && notificationTarget.user_id !== auth.user.id) {
    // Notification delivery must not turn a stored comment into a retry that
    // can duplicate the comment. The recipient is known from the same post/
    // parent validation above.
    try {
      await auth.supabaseAdmin.from("notifications").insert([{
        user_id: notificationTarget.user_id,
        sender_id: auth.user.id,
        sender_name: author,
        type: parentId !== null ? "reply" : "comment",
        post_id: id,
        preview_text: parentId !== null ? parentComment?.content : post.title,
      }]);
    } catch {
      console.warn("[mobile-board] 댓글 알림 저장 실패", { postId: id });
    }
  }

  return NextResponse.json({ success: true, id: comment.id });
}
