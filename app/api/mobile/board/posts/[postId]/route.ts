import { NextResponse } from "next/server";
import { rewriteBoardImageUrls, toBoardImageProxyUrl } from "@/lib/board-image-proxy";
import { withAuthGuard, withOptionalAuth } from "@/utils/supabase/guard";
import { parseCurrentBoardCategory } from "@/lib/board/mobileCategories";
import { POST as writeBoardPost } from "@/app/api/posts/write/route";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function extractImageUrls(html: string, origin: string) {
  const urls = new Set<string>();
  const rewritten = rewriteBoardImageUrls(html);
  const imageRegex = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match = imageRegex.exec(rewritten);
  while (match) {
    const src = match[1];
    urls.add(src.startsWith("/api/") ? `${origin}${src}` : src);
    match = imageRegex.exec(rewritten);
  }
  return [...urls];
}

function authorName(row: any) {
  return row.user_id
    ? row.profiles?.nickname || row.author || "알 수 없음"
    : row.author || "익명";
}

function mapComment(row: any) {
  return {
    id: row.id,
    postId: row.post_id,
    author: authorName(row),
    content: stripHtml(String(row.content || "")),
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}

function cacheControlForRequest(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("refresh") === "1") {
    return "no-store, max-age=0, must-revalidate";
  }

  return "public, s-maxage=30, stale-while-revalidate=120";
}

function noStore() {
  return "private, no-store, max-age=0, must-revalidate";
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ postId: string }> }
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isFinite(id)) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const auth = await withOptionalAuth();
  if (auth.error) return auth.error;
  const supabase = auth.supabaseAdmin;

  const origin = new URL(request.url).origin;
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id,title,content,author,user_id,category,image_url,is_notice,created_at,views,likes,status,revision,profiles(nickname)")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();

  if (postError) return jsonError("게시글을 불러오지 못했습니다.", 500);
  if (!post) return jsonError("게시글을 찾을 수 없습니다.", 404);

  const { data: comments, error: commentsError } = await supabase
    .from("comments")
    .select("id,post_id,user_id,author,content,parent_id,created_at,profiles(nickname)")
    .eq("post_id", id)
    .order("created_at", { ascending: true })
    .limit(50);

  if (commentsError) return jsonError("댓글을 불러오지 못했습니다.", 500);

  const content = String(post.content || "");
  const coverImage = toBoardImageProxyUrl(post.image_url, origin);
  const imageUrls = extractImageUrls(content, origin);
  if (coverImage) imageUrls.unshift(coverImage);
  const canEdit = typeof post.user_id === "string" && post.user_id === auth.user?.id;

  return NextResponse.json(
    {
      post: {
        id: post.id,
        title: post.title,
        author: authorName(post),
        category: post.category,
        contentText: stripHtml(content),
        imageUrls: [...new Set(imageUrls)],
        isNotice: Boolean(post.is_notice),
        createdAt: post.created_at,
        views: Number(post.views || 0),
        likes: Number(post.likes || 0),
        canEdit,
        revision: canEdit && validRevision(post.revision) ? post.revision : null,
      },
      comments: (comments || []).map(mapComment),
    },
    {
      headers: {
        "Cache-Control": auth.user ? noStore() : cacheControlForRequest(request),
      },
    }
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;

  let body: Record<string, unknown>;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
    body = value as Record<string, unknown>;
  } catch {
    return jsonError("요청 본문이 올바르지 않습니다.", 400);
  }
  if (!validRevision(body.expectedRevision)) return jsonError("수정 버전이 올바르지 않습니다.", 400);

  const category = parseCurrentBoardCategory(body.category);
  if (!category) return jsonError("게시판 분류가 올바르지 않습니다.", 400);

  // Mobile does not edit Discord, clan or legacy thumbnail metadata. Read the
  // exact revision being edited so the shared atomic writer preserves them.
  const { data: original, error: lookupError } = await auth.supabaseAdmin
    .from("posts")
    .select("id,user_id,revision,status,image_url,is_notice,discord_url,discord_channel_id,clan_info")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (lookupError) return jsonError("게시글을 확인하지 못했습니다.", 503);
  if (!original) return jsonError("게시글을 찾을 수 없습니다.", 404);
  if (original.user_id !== auth.user.id) return jsonError("게시글 수정 권한이 없습니다.", 403);
  if (original.revision !== body.expectedRevision) {
    return jsonError("게시글이 다른 곳에서 수정되었습니다.", 409);
  }

  const forwarded = new Request(request.url, {
    method: "POST",
    headers: forwardHeaders(request),
    body: JSON.stringify({
      title: body.title,
      content: body.content,
      category,
      user_id: auth.user.id,
      editingPostId: id,
      expectedRevision: body.expectedRevision,
      image_url: body.thumbnailImageId == null
        ? original.image_url
        : imageUrlForThumbnail(body.thumbnailImageId),
      is_notice: original.is_notice === true,
      discord_url: original.discord_url,
      discord_channel_id: original.discord_channel_id,
      clan_info: original.clan_info,
      contentImageIds: body.contentImageIds ?? [],
      thumbnailImageId: body.thumbnailImageId ?? null,
    }),
  });
  return writeBoardPost(forwarded);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
    body = value as Record<string, unknown>;
  } catch {
    return jsonError("요청 본문이 올바르지 않습니다.", 400);
  }
  if (!validRevision(body.expectedRevision)) return jsonError("삭제 버전이 올바르지 않습니다.", 400);

  const { data: post, error: lookupError } = await auth.supabaseAdmin
    .from("posts")
    .select("id,user_id,revision")
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return jsonError("게시글을 확인하지 못했습니다.", 503);
  if (!post) return jsonError("게시글을 찾을 수 없습니다.", 404);
  if (post.user_id !== auth.user.id) return jsonError("게시글 삭제 권한이 없습니다.", 403);
  if (post.revision !== body.expectedRevision) {
    return jsonError("게시글이 다른 곳에서 수정되었습니다.", 409);
  }

  const { data, error } = await auth.supabaseAdmin
    .from("posts")
    .delete()
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .eq("revision", body.expectedRevision)
    .select("id");
  if (error) return jsonError("게시글을 삭제하지 못했습니다.", 503);
  if (!Array.isArray(data) || data.length !== 1) {
    return jsonError("게시글이 다른 곳에서 수정되었습니다.", 409);
  }
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": noStore() } });
}


function forwardHeaders(request: Request) {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["authorization", "cookie", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function imageUrlForThumbnail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  return baseUrl ? `${baseUrl}/storage/v1/object/public/board-images-v2/${encodeURIComponent(value)}` : null;
}
