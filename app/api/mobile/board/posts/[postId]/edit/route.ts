import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";
import { isUuid } from "@/lib/board/imageStorageContract";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError("게시글 ID가 올바르지 않습니다.", 400);

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { data: post, error } = await auth.supabaseAdmin
    .from("posts")
    .select("id,title,content,category,image_url,user_id,revision,status")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (error) return jsonError("게시글을 불러오지 못했습니다.", 503);
  if (!post) return jsonError("게시글을 찾을 수 없습니다.", 404);
  if (post.user_id !== auth.user.id) return jsonError("게시글 수정 권한이 없습니다.", 403);
  if (!validRevision(post.revision)) return jsonError("게시글을 불러오지 못했습니다.", 503);

  const { data: refs, error: refsError } = await auth.supabaseAdmin
    .from("board_post_image_refs")
    .select("image_id,usage")
    .eq("post_id", id);
  if (refsError || !Array.isArray(refs)) return jsonError("게시글 이미지를 불러오지 못했습니다.", 503);
  const contentImageIds = refs
    .filter((ref) => ref?.usage === "content" && isUuid(ref.image_id))
    .map((ref) => ref.image_id);
  const thumbnailRef = refs.find((ref) => ref?.usage === "thumbnail" && isUuid(ref.image_id));

  return NextResponse.json({
    post: {
      id: post.id,
      title: post.title,
      content: post.content,
      category: post.category,
      imageUrl: post.image_url,
      revision: post.revision,
      contentImageIds,
      thumbnailImageId: thumbnailRef?.image_id ?? null,
      canEdit: true,
    },
  }, { headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" } });
}
