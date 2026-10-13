/**
 * app/api/pubg/hotdrop/route.ts
 *
 * GET /api/pubg/hotdrop?mapName=erangel
 * → Supabase에서 해당 맵의 현재 시즌 히트맵 데이터 반환
 * Cache-Control: s-maxage=3600 (CDN 1시간 캐싱)
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic  = "force-dynamic";
export const runtime  = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mapName = (searchParams.get("mapName") ?? "erangel").toLowerCase();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  try {
    // 현재 시즌(가장 최신 updated_at 기준)의 season 값 조회
    const { data: seasonRow } = await supabase
      .from("hotdrop_heatmap")
      .select("season")
      .eq("map_name", mapName)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (!seasonRow) {
      return NextResponse.json(
        { points: [], season: null, message: "데이터 없음 (아직 Cron이 실행되지 않았습니다)" },
        {
          headers: {
            "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
          },
        }
      );
    }

    const season = seasonRow.season;

    // 해당 맵 + 시즌의 모든 셀 조회 (count > 0 인 셀만)
    const { data, error } = await supabase
      .from("hotdrop_heatmap")
      .select("px, py, count")
      .eq("map_name", mapName)
      .eq("season", season)
      .gt("count", 0)
      .order("count", { ascending: false });

    if (error) throw new Error(error.message);

    // leaflet.heat 형식: [lat, lng, intensity]
    // 데이터가 적을 때도 잘 보이도록 강도를 상향 조정 (로그/제곱근 스케일)
    const maxCount = data && data.length > 0 ? data[0].count : 1;
    const points = (data ?? []).map((row) => {
      // 인구 밀도 차이를 극명하게 보여주기 위해 선형(Linear) 비율 사용
      // 데이터가 적은 곳은 아주 흐릿하게(0.1), 핫스팟은 진하게(1.0) 표시
      const intensity = Math.max(0.1, row.count / maxCount);
      
      return {
        lat: row.py,
        lng: row.px,
        intensity: intensity,
        count: row.count,
      };
    });

    return NextResponse.json(
      { points, season, total: points.length },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        },
      }
    );
  } catch (err: unknown) {
    console.error("[HOTDROP] read failed", err);
    return NextResponse.json({ error: "핫드랍 데이터를 불러오지 못했습니다." }, { status: 500 });
  }
}
