// app/api/admin/approve/route.ts
import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

export async function POST(request: Request) {
  try {
    const supabaseServer = await createClient();
    const { data: { user } } = await supabaseServer.auth.getUser();
    if (!user) return NextResponse.json({ error: "🔒 로그인이 만료되었거나 유효하지 않습니다." }, { status: 401 });

    const { data: profile } = await supabaseServer.from("profiles").select("nickname, role").eq("id", user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "⛔ 관리자 권한이 없습니다." }, { status: 403 });

    const supabaseAdmin = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: "마커 ID가 누락되었습니다." }, { status: 400 });

    // --- 이후 승인 로직 (기존과 동일) ---
    const { data: pending, error: fetchError } = await supabaseAdmin
      .from("pending_markers")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !pending) {
      return NextResponse.json({ error: "이미 다른 관리자가 처리했거나 없는 제보입니다." }, { status: 404 });
    }

    const { data: newIdData, error: rpcError } = await supabaseAdmin.rpc(
      "get_next_marker_id",
      {
        map_id_in: pending.map_name,
        marker_type_in: pending.marker_type,
      }
    );

    if (rpcError) throw rpcError;
    const newId = newIdData;

    const { error: insertError } = await supabaseAdmin
      .from("map_markers")
      .insert({
        id: newId,
        map_id: pending.map_name,
        name: pending.marker_type,
        type: pending.marker_type,
        x: pending.x,
        y: pending.y,
      });

    if (insertError) throw insertError;
    await supabaseAdmin.from("pending_markers").delete().eq("id", id);

    // 🌟 디스코드 알림 전송 (승인 완료)
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      const embed = {
        title: "✅ [관제탑 처리 완료] 제보 승인 및 DB 등록",
        description: `관리자 **${profile?.nickname || "알 수 없음"}**님이 제보를 확인하여 정식 지도 마커로 등록했습니다.`,
        color: 0x10b981, // 초록색
        fields: [
          { name: "🗺️ 맵", value: pending.map_name, inline: true },
          { name: "🚙 종류", value: pending.marker_type, inline: true },
          { name: "📍 좌표", value: `${pending.x.toFixed(1)}, ${pending.y.toFixed(1)}`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }).catch(err => console.error("Discord send error:", err));
    }

    // 🌟 [추가] 커뮤니티 전용 감사 로그 (유저 대상)
    const communityWebhookUrl = process.env.DISCORD_COMMUNITY_WEBHOOK_URL;
    if (communityWebhookUrl && pending.contributor_ids && pending.contributor_ids.length > 0) {
      const { data: contributors } = await supabaseAdmin
        .from("profiles")
        .select("nickname")
        .in("id", pending.contributor_ids);

      if (contributors && contributors.length > 0) {
        const nicknames = contributors.map(c => `**${c.nickname}**`).join(", ");
        const communityEmbed = {
          title: "🙌 지도가 더 정확해졌습니다! (제보 승인)",
          description: `${nicknames} 님의 제보가 관리자의 검토를 거쳐 BGMS 지도에 등록되었습니다.\n기여해주셔서 감사합니다!`,
          color: 0xffd700, // 골드색
          fields: [
            { name: "🗺️ 맵", value: pending.map_name, inline: true },
            { name: "🚙 종류", value: pending.marker_type, inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "PUBG 통합 지도 커뮤니티" }
        };

        await fetch(communityWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [communityEmbed] }),
        }).catch(err => console.error("Community Discord send error:", err));
      }
    }

    return NextResponse.json({ success: true, newId });
  } catch (error: any) {
    console.error("승인 API 에러:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
