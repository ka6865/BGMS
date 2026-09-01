import dotenv from "dotenv";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { categorizeWeapon } from "../lib/pubg-analysis/weaponMetaBurst";
import { POPULATION_EVIDENCE_VERSION, WEAPON_NAMES } from "../lib/pubg-analysis/constants";
import { BENCHMARK_FILTER_VERSION } from "../lib/pubg-analysis/benchmarkLookup";
import { evaluateMatchEligibility } from "../lib/pubg-analysis/matchEligibility";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const patchVersion = process.env.PUBG_META_PATCH_VERSION?.trim() || "";
const patchStartedAt = process.env.PUBG_META_PATCH_STARTED_AT || "";

function patchForMatch(playedAt: string): string | null {
  return patchForMatchWithConfig(playedAt, patchVersion, patchStartedAt);
}

function patchForMatchWithConfig(
  playedAt: string,
  configuredPatchVersion: string,
  configuredPatchStartedAt: string,
): string | null {
  const boundary = Date.parse(configuredPatchStartedAt);
  const matchTime = Date.parse(playedAt);
  if (!configuredPatchVersion || !Number.isFinite(boundary) || !Number.isFinite(matchTime)) return null;
  return matchTime >= boundary ? configuredPatchVersion : `pre_${configuredPatchVersion}`;
}

type BackfillRow = {
  match_id?: unknown;
  platform?: unknown;
  player_id?: unknown;
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalFullResult(row: unknown): Record<string, any> | null {
  if (!isRecord(row)) return null;
  const data = isRecord(row.data) ? row.data : null;
  const fullResult = data && isRecord(data.fullResult) ? data.fullResult : null;
  if (!fullResult || fullResult.populationEvidenceVersion !== POPULATION_EVIDENCE_VERSION) return null;
  return fullResult;
}

function benchmarkEligibilityInput(row: unknown, fullResult: Record<string, any>): Record<string, any> {
  const rowRecord = isRecord(row) ? row : {};
  const data = isRecord(rowRecord.data) ? rowRecord.data : {};
  // Keep both the wrapper and canonical fullResult in the input.  A custom,
  // event, or TDM marker may be present on either side and must fail closed.
  return { ...rowRecord, ...data, fullResult };
}

export function buildWeaponMetaBackfillSamples(
  rows: readonly BackfillRow[],
  options: { patchVersion?: string; patchStartedAt?: string } = {},
): Record<string, unknown>[] {
  const configuredPatchVersion = options.patchVersion ?? patchVersion;
  const configuredPatchStartedAt = options.patchStartedAt ?? patchStartedAt;
  const samples: Record<string, unknown>[] = [];

  for (const row of rows) {
    const fullResult = canonicalFullResult(row);
    if (!fullResult) continue;

    const playedAt = fullResult.createdAt;
    const weaponStats = fullResult.weaponStats;
    const patch = typeof playedAt === "string"
      ? patchForMatchWithConfig(playedAt, configuredPatchVersion, configuredPatchStartedAt)
      : null;
    const eligibility = evaluateMatchEligibility(benchmarkEligibilityInput(row, fullResult), "benchmark");
    if (
      !patch
      || !isRecord(weaponStats)
      || !eligibility.eligible
      || !eligibility.matchType
    ) continue;

    for (const [weaponId, stat] of Object.entries(weaponStats)) {
      if (!isRecord(stat)) continue;
      const weaponCategory = categorizeWeapon(weaponId);
      if (weaponCategory === "OTHERS") continue;
      const damage = Math.floor(Number(stat.damage ?? stat.damageDealt ?? 0));
      samples.push({
        match_id: row.match_id,
        platform: row.platform,
        player_id: row.player_id,
        played_at: playedAt,
        patch_version: patch,
        filter_version: BENCHMARK_FILTER_VERSION,
        population_evidence_version: POPULATION_EVIDENCE_VERSION,
        match_type: eligibility.matchType,
        weapon_category: weaponCategory,
        weapon_name: WEAPON_NAMES[weaponId] || weaponId.replace(/Item_Weapon_|Weap|_C|_Projectile/gi, ""),
        active_pick: damage > 0,
        total_kills: Math.round(Number(stat.kills || 0)),
        total_dbnos: Math.round(Number(stat.dbnos ?? stat.dBNOs ?? 0)),
        total_damage: damage,
        hit_count: Math.round(Number(stat.hits || 0)),
        // Old processed results have no timestamped hit sequence. Do not invent burst data.
        first_sec_hits: stat.firstSecHits == null ? null : Math.round(Number(stat.firstSecHits)),
        sustained_hits: stat.sustainedHits == null ? null : Math.round(Number(stat.sustainedHits)),
        sustained_burst_count: stat.sustainedBurstCount == null ? null : Math.round(Number(stat.sustainedBurstCount)),
      });
    }
  }

  return samples;
}

export async function runBackfill() {
  if (!supabaseUrl || !supabaseKey || !patchForMatch(new Date().toISOString())) {
    console.warn("[BACKFILL] Set SUPABASE_SERVICE_ROLE_KEY, PUBG_META_PATCH_VERSION and PUBG_META_PATCH_STARTED_AT first.");
    return { count: 0, status: "skipped" };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: rows, error } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, platform, player_id, data")
    .order("updated_at", { ascending: false })
    .limit(1000);

  if (error) {
    console.error("[BACKFILL] Failed to fetch telemetry:", error.message);
    return { count: 0, status: "error", error: error.message };
  }

  const samples = buildWeaponMetaBackfillSamples(rows || []);

  if (samples.length === 0) return { count: 0, status: "success" };
  const { error: upsertError } = await supabase.from("weapon_meta_match_samples").upsert(samples, {
    onConflict: "match_id,platform,player_id,weapon_name",
  });
  if (upsertError) return { count: 0, status: "error", error: upsertError.message };

  console.log(`[BACKFILL] Upserted ${samples.length} idempotent weapon samples.`);
  return { count: samples.length, status: "success" };
}

if (process.argv[1]?.endsWith("backfill_weapon_meta.ts")) {
  runBackfill().catch((error) => {
    console.error("[BACKFILL] Unhandled error:", error);
    process.exitCode = 1;
  });
}
