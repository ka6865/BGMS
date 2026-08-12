import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

const CURRENT_PUBG_PATCH = "34.1";

const FALLBACK_WEAPONS = [
  { id: 1, weapon_name: "M249", weapon_category: "LMG", match_count: 142, active_pick_count: 118, total_kills: 84, total_dbnos: 96, total_damage: 34500, first_sec_hits: 240, sustained_hits: 410, sustained_burst_count: 62 },
  { id: 2, weapon_name: "DP-28", weapon_category: "LMG", match_count: 85, active_pick_count: 62, total_kills: 38, total_dbnos: 45, total_damage: 18200, first_sec_hits: 110, sustained_hits: 195, sustained_burst_count: 28 },
  { id: 3, weapon_name: "Beryl M762", weapon_category: "AR", match_count: 680, active_pick_count: 620, total_kills: 512, total_dbnos: 580, total_damage: 184000, first_sec_hits: 1850, sustained_hits: 1120, sustained_burst_count: 145 },
  { id: 4, weapon_name: "M416", weapon_category: "AR", match_count: 740, active_pick_count: 690, total_kills: 540, total_dbnos: 610, total_damage: 192000, first_sec_hits: 1980, sustained_hits: 1250, sustained_burst_count: 160 },
  { id: 5, weapon_name: "Dragunov", weapon_category: "DMR", match_count: 510, active_pick_count: 480, total_kills: 390, total_dbnos: 420, total_damage: 142000, first_sec_hits: 1200, sustained_hits: 340, sustained_burst_count: 45 },
  { id: 6, weapon_name: "Kar98k", weapon_category: "SR", match_count: 210, active_pick_count: 195, total_kills: 165, total_dbnos: 180, total_damage: 58000, first_sec_hits: 450, sustained_hits: 50, sustained_burst_count: 8 },
];

export async function GET(request: Request) {
  try {
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({
        success: true,
        patchVersion: CURRENT_PUBG_PATCH,
        weapons: FALLBACK_WEAPONS,
        updatedAt: new Date().toISOString(),
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: snapshotRows, error } = await supabase
      .from("weapon_meta_snapshots")
      .select("*")
      .order("snapshot_date", { ascending: false })
      .limit(500);

    if (error || !snapshotRows || snapshotRows.length === 0) {
      if (error) console.warn("[META API] Database fetch info:", error.message);
      return NextResponse.json({
        success: true,
        patchVersion: CURRENT_PUBG_PATCH,
        weapons: FALLBACK_WEAPONS,
        updatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      patchVersion: CURRENT_PUBG_PATCH,
      weapons: snapshotRows,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || "Failed to fetch meta" }, { status: 500 });
  }
}
