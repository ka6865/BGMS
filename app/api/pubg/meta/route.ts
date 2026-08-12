import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function GET(request: Request) {
  try {
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({
        success: true,
        patchVersion: "31.2",
        weapons: [],
        updatedAt: new Date().toISOString(),
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: snapshotRows, error } = await supabase
      .from("weapon_meta_snapshots")
      .select("*")
      .order("snapshot_date", { ascending: false })
      .limit(500);

    if (error) {
      console.error("[META API] Database fetch error:", error.message);
      return NextResponse.json({
        success: true,
        patchVersion: "31.2",
        weapons: [],
        updatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      patchVersion: "31.2",
      weapons: snapshotRows || [],
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || "Failed to fetch meta" }, { status: 500 });
  }
}
