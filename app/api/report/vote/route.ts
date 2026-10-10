import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  const { user, supabaseAdmin, error: authError } = await withAuthGuard();
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const markerId = body?.markerId;
  const voteType = body?.voteType;
  if (typeof markerId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(markerId) ||
      (voteType !== "up" && voteType !== "down")) {
    return NextResponse.json({ error: "제보와 투표 방향을 확인해 주세요." }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc("vote_pending_marker", {
    p_marker_id: markerId,
    p_actor_user_id: user.id,
    p_direction: voteType,
  });
  if (error) return NextResponse.json({ error: "투표를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  if (data?.status === "not_found") return NextResponse.json({ error: "존재하지 않는 제보입니다." }, { status: 404 });
  if (data?.status === "already_voted") return NextResponse.json({ error: "이미 이 제보의 검증에 참여하셨습니다." }, { status: 403 });
  if (data?.status !== "ok") return NextResponse.json({ error: "투표 결과를 확인하지 못했습니다." }, { status: 503 });
  return NextResponse.json({ success: true, weight: data.weight, down_weight: data.down_weight, triggerNotify: data.triggerNotify });
}
