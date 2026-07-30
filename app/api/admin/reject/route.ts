import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { id } = await request.json();
    if (typeof id !== "string") return NextResponse.json({ error: "마커 ID가 누락되었습니다." }, { status: 400 });
    const { data: profile } = await auth.supabaseAdmin.from("profiles").select("role").eq("id", auth.user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "관리자 권한이 없습니다." }, { status: 403 });
    const { data, error } = await auth.supabaseAdmin.rpc("process_pending_marker_admin_action", { p_marker_id: id, p_action: "reject" });
    if (error) throw error;
    const result = data?.[0];
    if (!result) return NextResponse.json({ error: "이미 처리되었거나 존재하지 않는 제보입니다." }, { status: 404 });
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [{ title: "[관제탑 처리 완료] 허위 제보 파기", color: 0x6b7280, fields: [{ name: "맵", value: result.map_name, inline: true }, { name: "종류", value: result.marker_type, inline: true }] }] }),
      }).catch(() => undefined);
    }
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "파기 처리에 실패했습니다." }, { status: 500 });
  }
}
