import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAP_ALIASES: Record<string, string> = {
  baltic_main: "Erangel",
  erangel: "Erangel",
  에란겔: "Erangel",
  desert_main: "Miramar",
  miramar: "Miramar",
  미라마: "Miramar",
  tiger_main: "Taego",
  taego: "Taego",
  태이고: "Taego",
  neon_main: "Rondo",
  rondo: "Rondo",
  론도: "Rondo",
  dihorotok_main: "Vikendi",
  vikendi: "Vikendi",
  비켄디: "Vikendi",
  kiki_main: "Deston",
  deston: "Deston",
  데스턴: "Deston",
};

type RouteContext = {
  params: Promise<{ mapId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { mapId: rawMapId } = await context.params;
  const mapId = normalizeMapId(rawMapId);
  const requestedLayers = parseLayers(request.nextUrl.searchParams.get("layers"));

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    let query = supabase
      .from("map_markers")
      .select("id,name,type,x,y,map_id")
      .eq("map_id", mapId);

    if (requestedLayers.length > 0) {
      query = query.in("type", requestedLayers);
    }

    const { data, error } = await query.order("type", { ascending: true });
    if (error) throw new Error(error.message);

    return NextResponse.json(
      {
        mapId,
        markers: (data ?? []).map((marker) => ({
          id: String(marker.id),
          label: marker.name || marker.type || "마커",
          layer: marker.type || "default",
          x: normalizeCoord(marker.x),
          y: normalizeCoord(marker.y),
          rawX: marker.x,
          rawY: marker.y,
        })),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (error) {
    console.error("[MAP-MARKERS] read failed", { mapId, error });
    return NextResponse.json({ error: "지도 마커를 불러오지 못했습니다.", mapId }, { status: 500 });
  }
}

function normalizeMapId(value: string) {
  const key = decodeURIComponent(value).trim().toLowerCase();
  return MAP_ALIASES[key] ?? value;
}

function parseLayers(value: string | null) {
  if (!value) return [];
  return value
    .split(",")
    .map((layer) => layer.trim())
    .filter(Boolean);
}

function normalizeCoord(value: unknown) {
  const numeric =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(numeric)) return 0.5;
  if (numeric >= 0 && numeric <= 1) return numeric;
  if (numeric >= 0 && numeric <= 100) return numeric / 100;
  return Math.max(0, Math.min(1, numeric / 8192));
}
