import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { recordAdminAudit } from "@/lib/server/adminAudit";

// postId 는 posts.id(bigint) 이다. 숫자만 허용하고 JS 안전 정수 범위를 넘지 않게 한다.
function parsePostId(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const postId = parsePostId(searchParams.get("postId"));

    if (postId === null) {
      return NextResponse.json({ error: "게시글 ID가 올바르지 않습니다." }, { status: 400 });
    }

    const admin = await requireAdmin();
    if (!admin.ok) return admin.error;

    // 되돌릴 수 없는 삭제이므로 실행 전에 시도 기록을 남긴다.
    await recordAdminAudit(admin.supabaseAdmin, {
      actorId: admin.user.id,
      action: "posts.force_delete",
      targetType: "post",
      targetId: postId,
      phase: "requested"
    });

    // comments, post_likes, notifications, board_post_image_refs 등은 posts(id) 에
    // ON DELETE CASCADE 로 묶여 있어 게시글 한 건 삭제가 한 트랜잭션 안에서 함께 지워진다.
    const { data: deleteData, error: deleteError } = await admin.supabaseAdmin
      .from("posts")
      .delete()
      .eq("id", postId)
      .select("id");

    if (deleteError) {
      console.error("[Delete] Post delete error:", deleteError.message || deleteError);
      await recordAdminAudit(admin.supabaseAdmin, {
        actorId: admin.user.id,
        action: "posts.force_delete",
        targetType: "post",
        targetId: postId,
        phase: "failed"
      });
      return NextResponse.json({ error: "게시글을 삭제하지 못했습니다." }, { status: 500 });
    }

    if (!deleteData || deleteData.length === 0) {
      await recordAdminAudit(admin.supabaseAdmin, {
        actorId: admin.user.id,
        action: "posts.force_delete",
        targetType: "post",
        targetId: postId,
        phase: "failed",
        detail: { reason: "not_found" }
      });
      return NextResponse.json({ error: "이미 삭제되었거나 존재하지 않는 게시글입니다." }, { status: 404 });
    }

    await recordAdminAudit(admin.supabaseAdmin, {
      actorId: admin.user.id,
      action: "posts.force_delete",
      targetType: "post",
      targetId: postId,
      phase: "succeeded"
    });

    return NextResponse.json({ success: true, message: "게시글과 관련 데이터가 강제 삭제되었습니다." });
  } catch (err: any) {
    console.error("Admin force delete error:", err?.message || err);
    return NextResponse.json({ error: "게시글 삭제 중 오류가 발생했습니다." }, { status: 500 });
  }
}
