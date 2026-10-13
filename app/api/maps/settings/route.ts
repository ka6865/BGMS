import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { MAP_CATEGORIES } from "@/lib/map_config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MapSettingsRow = {
  map_id: string;
  categories: string[];
};

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { data, error } = await supabase
      .from("map_settings")
      .select("map_id,categories");

    if (error) throw new Error(error.message);

    const mapCategories: Record<string, string[]> = { ...MAP_CATEGORIES };
    for (const setting of (data ?? []) as MapSettingsRow[]) {
      mapCategories[setting.map_id] = setting.categories;
    }

    return NextResponse.json(
      { mapCategories },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (error) {
    console.error("[MAP-SETTINGS] read failed", error);
    return NextResponse.json({ error: "지도 설정을 불러오지 못했습니다." }, { status: 500 });
  }
}
