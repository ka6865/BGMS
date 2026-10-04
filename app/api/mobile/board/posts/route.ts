import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { withAuthGuard } from "@/utils/supabase/guard";
import { checkIpBlacklist, extractClientIp } from "@/lib/board/ipUtils";
import { toBoardImageProxyUrl } from "@/lib/board-image-proxy";
import { boardCategoryFilterValues, parseCurrentBoardCategory } from "@/lib/board/mobileCategories";
import { POST as writeBoardPost } from "@/app/api/posts/write/route";

const clean = (value: string | undefined) => (value || "").replace(/['";\s]+/g, "").trim();
const supabaseUrl = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseServiceKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

type BoardPostCursor = {
  isNotice: boolean;
  createdAt: string;
  id: number;
};

function adminClient() {
  return createAdminClient<any>(supabaseUrl, supabaseServiceKey);
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function originOf(request: Request) {
  return new URL(request.url).origin;
}

function encodeCursor(row: any) {
  const cursor: BoardPostCursor = {
    isNotice: Boolean(row.is_notice),
    createdAt: row.created_at,
    id: Number(row.id),
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): BoardPostCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed?.isNotice === "boolean" &&
      isCursorTimestamp(parsed?.createdAt) &&
      Number.isSafeInteger(parsed?.id) &&
      parsed.id > 0
    ) {
      return {
        isNotice: parsed.isNotice,
        createdAt: parsed.createdAt,
        id: parsed.id,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isCursorTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseLimit(rawLimit: string | null): number | null {
  if (rawLimit === null || rawLimit.trim() === "") return 20;
  const requested = Number(rawLimit);
  if (!Number.isSafeInteger(requested)) return null;
  // Keep the previous default for an explicit zero while bounding all other
  // integer values to the endpoint's documented page size.
  if (requested === 0) return 20;
  return Math.min(Math.max(requested, 1), 20);
}

function applyCursor(query: any, rawCursor: string | null) {
  const cursor = decodeCursor(rawCursor);
  if (!rawCursor) return query;
  if (!cursor) return query.lt("created_at", rawCursor);

  const sameNoticeOlderRows = `and(is_notice.eq.${cursor.isNotice},created_at.lt.${cursor.createdAt})`;
  const sameNoticeSameTimeOlderRows = `and(is_notice.eq.${cursor.isNotice},created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;

  if (cursor.isNotice) {
    return query.or(`${sameNoticeOlderRows},${sameNoticeSameTimeOlderRows},is_notice.eq.false`);
  }

  return query.or(`${sameNoticeOlderRows},${sameNoticeSameTimeOlderRows}`);
}

function authorName(row: any) {
  return row.user_id
    ? row.profiles?.nickname || row.author || "알 수 없음"
    : row.author || "익명";
}

function mapPost(row: any, origin: string) {
  const commentCount = Array.isArray(row.comments) && row.comments[0]?.count
    ? Number(row.comments[0].count)
    : 0;

  return {
    id: row.id,
    title: row.title,
    author: authorName(row),
    category: row.category,
    imageUrl: toBoardImageProxyUrl(row.image_url, origin) || null,
    isNotice: Boolean(row.is_notice),
    createdAt: row.created_at,
    views: Number(row.views || 0),
    likes: Number(row.likes || 0),
    commentCount,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) return jsonError("게시글 수 제한이 올바르지 않습니다.", 400);
  const cursor = url.searchParams.get("cursor");
  if (cursor && !decodeCursor(cursor) && !isCursorTimestamp(cursor)) {
    return jsonError("게시글 커서가 올바르지 않습니다.", 400);
  }
  const category = url.searchParams.get("category");
  const queryText = url.searchParams.get("q")?.trim();
  const origin = originOf(request);

  let query = adminClient()
    .from("posts")
    .select("id,title,author,user_id,category,image_url,is_notice,created_at,views,likes,status,comments(count),profiles(nickname)")
    .eq("status", "published")
    .order("is_notice", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  query = applyCursor(query, cursor);
  if (category && category !== "all") {
    const values = boardCategoryFilterValues(category);
    if (!values) return jsonError("게시판 분류가 올바르지 않습니다.", 400);
    query = values.length === 1 ? query.eq("category", values[0]) : query.in("category", values);
  }
  if (queryText) {
    const safeQuery = queryText.replace(/[%_]/g, "");
    if (safeQuery) query = query.or(`title.ilike.%${safeQuery}%,content.ilike.%${safeQuery}%`);
  }

  query = query.limit(limit + 1);

  const { data, error } = await query;
  if (error) return jsonError("게시글 목록을 불러오지 못했습니다.", 500);

  const rows = data || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => mapPost(row, origin));

  return NextResponse.json(
    {
      items,
      nextCursor: hasMore ? encodeCursor(rows[limit - 1]) : null,
      hasMore,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=180",
      },
    }
  );
}

export async function POST(request: Request) {
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

  const category = parseCurrentBoardCategory(body.category);
  if (!category) return jsonError("게시판 분류가 올바르지 않습니다.", 400);

  const clientIp = extractClientIp(request);
  if (await checkIpBlacklist(clientIp, auth.supabaseAdmin)) {
    return jsonError("차단된 IP입니다. 관리자에게 문의해주세요.", 403);
  }

  // 이미지 소유권·본문 정화·quota·revision RPC를 웹 작성 API와 하나로 유지한다.
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: forwardHeaders(request),
    body: JSON.stringify({
      title: body.title,
      content: body.content,
      category,
      user_id: auth.user.id,
      image_url: imageUrlForThumbnail(body.thumbnailImageId),
      is_notice: false,
      contentImageIds: body.contentImageIds ?? [],
      thumbnailImageId: body.thumbnailImageId ?? null,
    }),
  });
  return writeBoardPost(forwarded);
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
