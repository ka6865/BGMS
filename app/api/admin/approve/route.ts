import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { id } = await request.json();
    if (typeof id !== "string") return NextResponse.json({ error: "마커 ID가 누락되었습니다." }, { status: 400 });
    const { data: profile } = await auth.supabaseAdmin.from("profiles").select("nickname, role").eq("id", auth.user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "관리자 권한이 없습니다." }, { status: 403 });
    const { data, error } = await auth.supabaseAdmin.rpc("process_pending_marker_admin_action", { p_marker_id: id, p_action: "approve" });
    if (error) throw error;
    const result = data?.[0];
    if (!result) return NextResponse.json({ error: "이미 처리되었거나 존재하지 않는 제보입니다." }, { status: 404 });
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "[관제탑 처리 완료] 제보 승인 및 DB 등록",
            description: `관리자 **${profile.nickname || "알 수 없음"}**님이 제보를 정식 지도 마커로 등록했습니다.`,
            color: 0x10b981,
            fields: [
              { name: "맵", value: result.map_name, inline: true },
              { name: "종류", value: result.marker_type, inline: true },
              { name: "좌표", value: `${result.x.toFixed(1)}, ${result.y.toFixed(1)}`, inline: true },
            ],
          }],
        }),
      }).catch(() => undefined);
    }

    const communityWebhookUrl = process.env.DISCORD_COMMUNITY_WEBHOOK_URL;
    if (communityWebhookUrl && result.contributor_ids?.length) {
      const { data: contributors } = await auth.supabaseAdmin
        .from("profiles")
        .select("nickname")
        .in("id", result.contributor_ids);
      const nicknames = contributors?.map((contributor) => contributor.nickname).filter(Boolean).join(", ");
      if (nicknames) {
        await fetch(communityWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: "지도가 더 정확해졌습니다! (제보 승인)",
              description: `${nicknames} 님의 제보가 BGMS 지도에 등록되었습니다. 기여해주셔서 감사합니다!`,
              color: 0xffd700,
              fields: [
                { name: "맵", value: result.map_name, inline: true },
                { name: "종류", value: result.marker_type, inline: true },
              ],
            }],
          }),
        }).catch(() => undefined);
      }
    }
    return NextResponse.json({ success: true, newId: result.new_marker_id });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "승인 처리에 실패했습니다." }, { status: 500 });
  }
}
