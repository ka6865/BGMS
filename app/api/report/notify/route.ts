import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

type ClaimedMarker = {
  id: string;
  map_name: string;
  marker_type: string;
  x: number;
  y: number;
  weight: number;
  down_weight: number;
  contributor_ids: string[] | null;
  downvoter_ids: string[] | null;
};

export async function POST(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { supabaseAdmin } = auth;

    const { markerId, type } = await request.json();
    if (typeof markerId !== "string" || markerId.length === 0) {
      return NextResponse.json({ error: "마커 ID가 없습니다." }, { status: 400 });
    }
    if (type !== "up" && type !== "down") {
      return NextResponse.json({ error: "유효하지 않은 알림 유형입니다." }, { status: 400 });
    }

    const { data: claimedMarkers, error: claimError } = await supabaseAdmin.rpc(
      "claim_pending_marker_notification",
      { p_marker_id: markerId, p_direction: type },
    );
    if (claimError) throw claimError;

    const marker = (claimedMarkers as ClaimedMarker[] | null)?.[0];
    if (!marker) {
      return NextResponse.json({ message: "알림 조건을 만족하지 않거나 이미 처리되었습니다." });
    }

    const targetIds = type === "down" ? marker.downvoter_ids : marker.contributor_ids;
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("nickname")
      .in("id", targetIds ?? []);
    if (profileError) throw profileError;

    const nicknames = profiles?.map((profile) => profile.nickname).join(", ") || "알 수 없음";
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
    if (!webhookUrl) throw new Error("디스코드 웹훅 URL이 설정되지 않았습니다.");

    const embed = type === "down"
      ? {
          title: "[관제탑 경고] 허위 제보 누적 초과 (비추천 5 이상)",
          description: "허위 제보가 많아 파기 처리가 요구됩니다. 관리자 팝업에서 파기해주세요.",
          color: 0xef4444,
          fields: [
            { name: "맵", value: marker.map_name, inline: true },
            { name: "종류", value: marker.marker_type, inline: true },
            { name: "비추천 점수", value: `${marker.down_weight}점`, inline: true },
            { name: "좌표 (x, y)", value: `${marker.x.toFixed(1)}, ${marker.y.toFixed(1)}`, inline: false },
            { name: "비추천 유저", value: nicknames, inline: false },
            { name: "관리자 제보 검토 센터", value: `[심사 페이지](${siteUrl}/admin/review?id=${marker.id}) | [에디터](${siteUrl}/map-editor?lat=${marker.y}&lng=${marker.x})`, inline: false },
          ],
          timestamp: new Date().toISOString(),
        }
      : {
          title: "[관제탑] 새로운 차량 제보가 임계점을 돌파했습니다!",
          description: "교차 검증(추천 5 이상)이 완료되었습니다. 승인 여부를 결정해주세요.",
          color: 0xf2a900,
          fields: [
            { name: "맵", value: marker.map_name, inline: true },
            { name: "종류", value: marker.marker_type, inline: true },
            { name: "신뢰도(추천)", value: `${marker.weight}점`, inline: true },
            { name: "좌표 (x, y)", value: `${marker.x.toFixed(1)}, ${marker.y.toFixed(1)}`, inline: false },
            { name: "기여자 목록", value: nicknames, inline: false },
            { name: "관리자 제보 검토 센터", value: `[심사 페이지](${siteUrl}/admin/review?id=${marker.id}) | [에디터](${siteUrl}/map-editor?lat=${marker.y}&lng=${marker.x})`, inline: false },
          ],
          timestamp: new Date().toISOString(),
        };

    const discordResponse = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!discordResponse.ok) throw new Error("디스코드 알림 발송 실패");

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "디스코드 알림 처리에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
