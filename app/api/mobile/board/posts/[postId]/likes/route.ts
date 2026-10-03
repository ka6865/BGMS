import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isDuplicateLike(error: any) {
  return error?.code === "23505";
}

/**
 * Member-only one-way recommendation. The existing post_likes unique key is
 * the duplicate boundary; increment_likes is called only after that insert
 * succeeds, matching the web board's established storage contract.
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
  const { supabaseAdmin } = auth;

  const { data: post, error: postError } = await supabaseAdmin
    .from("posts")
    .select("id")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (postError) return jsonError("게시글을 확인하지 못했습니다.", 503);
  if (!post) return jsonError("게시글을 찾을 수 없습니다.", 404);

  const { error: likeError } = await supabaseAdmin
    .from("post_likes")
    .insert([{ post_id: id, user_id: auth.user.id }]);
  if (isDuplicateLike(likeError)) return jsonError("이미 추천한 게시글입니다.", 409);
  if (likeError) return jsonError("추천을 저장하지 못했습니다.", 503);

  const { error: incrementError } = await supabaseAdmin.rpc("increment_likes", { row_id: id });
  if (incrementError) {
    // Do not leave a permanent duplicate marker when the counter did not
    // acknowledge. A successful retry can then perform the normal sequence.
    try {
      await supabaseAdmin
        .from("post_likes")
        .delete()
        .eq("post_id", id)
        .eq("user_id", auth.user.id);
    } catch {
      // The original counter failure is the only safe client-facing result.
    }
    return jsonError("추천을 반영하지 못했습니다.", 503);
  }

  const { data: updatedPost, error: updatedPostError } = await supabaseAdmin
    .from("posts")
    .select("likes")
    .eq("id", id)
    .maybeSingle();
  if (updatedPostError || !updatedPost || !Number.isFinite(Number(updatedPost.likes))) {
    return jsonError("추천 결과를 확인하지 못했습니다.", 503);
  }
  return NextResponse.json({ success: true, liked: true, likes: Number(updatedPost.likes) }, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
