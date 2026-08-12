import { createClient } from "@supabase/supabase-js";
import { calculateWeaponBurstStats } from "../lib/pubg-analysis/weaponMetaBurst";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function runBackfill() {
  console.log("[BACKFILL] Starting pre-patch weapon meta backfill...");
  if (!supabaseUrl || !supabaseKey) {
    console.warn("[BACKFILL] Supabase credentials not found, skipping execution.");
    return { count: 0, status: "skipped" };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, platform, player_id, data, updated_at")
    .gte("updated_at", since14d)
    .limit(1000);

  if (error) {
    console.error("[BACKFILL] Failed to fetch telemetry:", error.message);
    return { count: 0, status: "error", error: error.message };
  }

  const telemetryRows = rows || [];
  let backfilledCount = 0;

  for (const row of telemetryRows) {
    if (!Array.isArray(row.data)) continue;
    const burstStats = calculateWeaponBurstStats(row.data, row.player_id);
    if (burstStats.size === 0) continue;

    const dateStr = (row.updated_at || new Date().toISOString()).split("T")[0];
    const snapshotRows = Array.from(burstStats.values()).map((stat) => ({
      patch_version: "pre_patch",
      snapshot_date: dateStr,
      weapon_category: stat.category,
      weapon_name: stat.weaponName,
      match_count: 1,
      active_pick_count: stat.totalDamage > 0 ? 1 : 0,
      total_kills: 0,
      total_dbnos: 0,
      total_damage: Math.floor(stat.totalDamage),
      first_sec_hits: stat.firstSecHits,
      sustained_hits: stat.sustainedHits,
      sustained_burst_count: stat.sustainedBurstCount,
    }));

    const { error: upsertErr } = await supabase.from("weapon_meta_snapshots").upsert(snapshotRows, {
      onConflict: "patch_version,snapshot_date,weapon_name",
    });

    if (!upsertErr) {
      backfilledCount += snapshotRows.length;
    }
  }

  console.log(`[BACKFILL] Successfully backfilled ${backfilledCount} snapshot records from ${telemetryRows.length} telemetry matches.`);
  return { count: backfilledCount, status: "success" };
}

if (process.argv[1]?.endsWith("backfill_weapon_meta.ts")) {
  runBackfill().catch((err) => console.error("[BACKFILL] Unhandled error:", err));
}
