import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Member-only one-way recommendation. Insert and counter update share one
 * database transaction so a lost RPC acknowledgement remains safe to retry.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  if (!UUID_PATTERN.test(auth.user.id)) return jsonError("인증 정보가 올바르지 않습니다.", 401);

  // This RPC is the sole write path. On an error (including an unavailable
  // forward migration), do not fall back to a non-atomic table write.
  let rpcResult: { data: unknown; error: unknown };
  try {
    rpcResult = await auth.supabaseAdmin.rpc("recommend_mobile_board_post", {
      p_post_id: id,
      p_user_id: auth.user.id,
    });
  } catch {
    return jsonError("추천을 반영하지 못했습니다.", 503);
  }
  const { data, error } = rpcResult;
  if (error) return jsonError("추천을 반영하지 못했습니다.", 503);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return jsonError("추천 결과를 확인하지 못했습니다.", 503);
  }

  const result = data as { status?: unknown; likes?: unknown };
  if (result.status === "not_found") return jsonError("게시글을 찾을 수 없습니다.", 404);
  if (result.status === "already_liked") return jsonError("이미 추천한 게시글입니다.", 409);
  if (result.status !== "liked" || !Number.isSafeInteger(result.likes) || (result.likes as number) < 0) {
    return jsonError("추천 결과를 확인하지 못했습니다.", 503);
  }

  return NextResponse.json({ success: true, liked: true, likes: result.likes }, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
