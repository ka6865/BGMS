import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { recordAdminAudit } from "@/lib/server/adminAudit";

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return auth.error;
    const { id } = await request.json();
    if (typeof id !== "string") return NextResponse.json({ error: "마커 ID가 누락되었습니다." }, { status: 400 });
    const { data, error } = await auth.supabaseAdmin.rpc("process_pending_marker_admin_action", { p_marker_id: id, p_action: "reject" });
    if (error) throw error;
    const result = data?.[0];
    if (!result) return NextResponse.json({ error: "이미 처리되었거나 존재하지 않는 제보입니다." }, { status: 404 });
    await recordAdminAudit(auth.supabaseAdmin, {
      actorId: auth.user.id,
      action: "markers.reject",
      targetType: "pending_marker",
      targetId: id,
      phase: "succeeded",
      detail: { mapName: result.map_name ?? null, markerType: result.marker_type ?? null }
    });
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
    console.error("[ADMIN-MARKER] reject failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "파기 처리에 실패했습니다." }, { status: 500 });
  }
}
