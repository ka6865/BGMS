import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";
import { MAP_CATEGORIES, CATEGORY_INFO } from "@/lib/map_config";

export async function POST(request: Request) {
  const { user, supabaseAdmin, error: authError } = await withAuthGuard();
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const { mapName, markerType, x, y } = body ?? {};
  if (typeof mapName !== "string" || !Object.hasOwn(MAP_CATEGORIES, mapName) ||
      typeof markerType !== "string" || !markerType || markerType.length > 128 ||
      typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 8192 ||
      typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 8192) {
    return NextResponse.json({ error: "지도, 제보 종류와 위치를 확인해 주세요." }, { status: 400 });
  }

  const [settings, category] = await Promise.all([
    supabaseAdmin.from("map_settings").select("categories").eq("map_id", mapName).maybeSingle(),
    supabaseAdmin.from("categories").select("id,is_active").eq("id", markerType).maybeSingle(),
  ]);
  if (settings.error || category.error) {
    return NextResponse.json({ error: "제보 설정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
  const allowed = settings.data?.categories ?? MAP_CATEGORIES[mapName];
  const active = category.data ? category.data.is_active : Object.hasOwn(CATEGORY_INFO, markerType);
  if (!Array.isArray(allowed) || !allowed.includes(markerType) || !active) {
    return NextResponse.json({ error: "현재 지도에서 제보할 수 없는 종류입니다." }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc("create_pending_marker", {
    p_actor_user_id: user.id,
    p_map_name: mapName,
    p_marker_type: markerType,
    p_x: x,
    p_y: y,
  });
  if (error || (data?.status !== "ok" && data?.status !== "nearby")) {
    return NextResponse.json({ error: "제보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
  return NextResponse.json({ success: true, nearby: data.status === "nearby", markerId: data.id });
}
