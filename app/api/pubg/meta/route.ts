import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const patchVersion = process.env.PUBG_META_PATCH_VERSION?.trim() || "";
const patchStartedAt = process.env.PUBG_META_PATCH_STARTED_AT || "";
export const BURST_COMPARISON_MIN_MATCHES = 20;

type MetaRow = {
  weapon_name: string;
  weapon_category: string;
  period: "pre" | "post";
  player_match_count: number;
  active_pick_count: number;
  total_damage: number;
  total_kills: number;
  total_dbnos: number;
  sustained_hits: number;
  burst_sample_count: number;
};

type DailyTrendPoint = {
  date: string;
  player_match_count: number;
  weapon_pick_count: number;
  weapon_name: string;
  weapon_category: string;
  scope: "weapon" | "category";
};

type ScopePickShare = {
  scope: "category";
  weapon_category: string;
  period: "pre" | "post";
  player_match_count: number;
  weapon_pick_count: number;
};

function metric(row: MetaRow | undefined) {
  const samples = Number(row?.player_match_count || 0);
  const picks = Number(row?.active_pick_count || 0);
  const damage = Number(row?.total_damage || 0);
  const killsAndDbnos = Number(row?.total_kills || 0) + Number(row?.total_dbnos || 0);
  return {
    match_count: samples,
    pick_share: samples > 0 ? Number(((picks / samples) * 100).toFixed(1)) : 0,
    avg_damage: picks > 0 ? Math.round(damage / picks) : 0,
    sustained_hits: Number(row?.burst_sample_count || 0) > 0
      ? Number((Number(row?.sustained_hits || 0) / Number(row?.burst_sample_count || 1)).toFixed(2))
      : 0,
    burst_sample_count: Number(row?.burst_sample_count || 0),
    burst_available: Number(row?.burst_sample_count || 0) >= BURST_COMPARISON_MIN_MATCHES,
    kill_efficiency: damage > 0 ? Number(((killsAndDbnos * 1000) / damage).toFixed(1)) : 0,
  };
}

function buildDailyWeaponTrend(rows: Array<{
  played_at: string;
  weapon_category: string;
  weapon_name: string;
  active_pick: boolean;
}>): DailyTrendPoint[] {
  const totalMatchesByDate = new Map<string, Set<string>>();
  const days = new Map<string, { weaponMatches: Set<string>; weaponName: string; weaponCategory: string; scope: "weapon" | "category" }>();
  for (const row of rows as Array<typeof rows[number] & { match_id: string; platform: string; player_id: string }>) {
    const date = row.played_at.slice(0, 10);
    const key = `${date}:${row.weapon_name}`;
    const identity = `${row.match_id}:${row.platform}:${row.player_id}`;
    const totalMatches = totalMatchesByDate.get(date) || new Set<string>();
    totalMatches.add(identity);
    totalMatchesByDate.set(date, totalMatches);
    const current = days.get(key) || { weaponMatches: new Set<string>(), weaponName: row.weapon_name, weaponCategory: row.weapon_category, scope: "weapon" as const };
    if (row.active_pick) current.weaponMatches.add(identity);
    days.set(key, current);

    const categoryKey = `${date}:category:${row.weapon_category}`;
    const category = days.get(categoryKey) || { weaponMatches: new Set<string>(), weaponName: row.weapon_category, weaponCategory: row.weapon_category, scope: "category" as const };
    if (row.active_pick) category.weaponMatches.add(identity);
    days.set(categoryKey, category);

    const allCategoryKey = `${date}:category:ALL`;
    const allCategory = days.get(allCategoryKey) || { weaponMatches: new Set<string>(), weaponName: "ALL", weaponCategory: "ALL", scope: "category" as const };
    if (row.active_pick) allCategory.weaponMatches.add(identity);
    days.set(allCategoryKey, allCategory);
  }
  return Array.from(days.entries())
    .map(([key, values]) => ({ date: key.slice(0, 10), player_match_count: totalMatchesByDate.get(key.slice(0, 10))?.size || 0, weapon_pick_count: values.weaponMatches.size, weapon_name: values.weaponName, weapon_category: values.weaponCategory, scope: values.scope }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function buildScopePickShares(rows: Array<{
  played_at: string; weapon_category: string; active_pick: boolean; match_id: string; platform: string; player_id: string;
}> , patchStartedAt: string): ScopePickShare[] {
  const allMatchesByPeriod = new Map<"pre" | "post", Set<string>>();
  const scopes = new Map<string, { picks: Set<string>; weapon_category: string; period: "pre" | "post" }>();
  for (const row of rows) {
    const period = Date.parse(row.played_at) < Date.parse(patchStartedAt) ? "pre" : "post";
    const identity = `${row.match_id}:${row.platform}:${row.player_id}`;
    const allMatches = allMatchesByPeriod.get(period) || new Set<string>();
    allMatches.add(identity);
    allMatchesByPeriod.set(period, allMatches);
    for (const category of [row.weapon_category, "ALL"]) {
      const key = `${period}:${category}`;
      const scope = scopes.get(key) || { picks: new Set<string>(), weapon_category: category, period };
      if (row.active_pick) scope.picks.add(identity);
      scopes.set(key, scope);
    }
  }
  return Array.from(scopes.values()).map((scope) => ({
    scope: "category",
    weapon_category: scope.weapon_category,
    period: scope.period,
    player_match_count: allMatchesByPeriod.get(scope.period)?.size || 0,
    weapon_pick_count: scope.picks.size,
  }));
}

export async function GET(request: NextRequest) {
  const requestedMatchType = request.nextUrl.searchParams.get("matchType");
  const matchType = requestedMatchType === "official" || requestedMatchType === "competitive" ? requestedMatchType : "all";
  if (!supabaseUrl || !supabaseKey || !patchVersion || !Number.isFinite(Date.parse(patchStartedAt))) {
    return NextResponse.json({
      success: false,
      status: "not_configured",
      message: "메타 비교 시작 시각이 아직 설정되지 않았습니다.",
      patchVersion: patchVersion || null,
      weapons: [],
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase.rpc("get_weapon_meta_comparison", {
      p_patch_version: patchVersion,
      p_patch_started_at: patchStartedAt,
      p_baseline_days: 14,
      p_match_type: matchType,
    });
    if (error) {
      console.error("[META API] comparison query failed", { code: error.code, message: error.message });
      return NextResponse.json({
        success: false,
        status: "unavailable",
        message: "집계 테이블을 준비 중입니다.",
        patchVersion,
        weapons: [],
        updatedAt: new Date().toISOString(),
      }, { status: 503 });
    }

    const rows = (data || []) as MetaRow[];
    const baselineStartAt = new Date(Date.parse(patchStartedAt) - 14 * 86_400_000).toISOString();
    let trendQuery = supabase
      .from("weapon_meta_match_samples")
      .select("match_id,platform,player_id,played_at,weapon_category,weapon_name,active_pick,first_sec_hits,match_type")
      .gte("played_at", baselineStartAt)
      .lt("played_at", new Date().toISOString())
      .in("patch_version", [`pre_${patchVersion}`, patchVersion]);
    trendQuery = matchType === "all"
      ? trendQuery.in("match_type", ["official", "competitive"])
      : trendQuery.eq("match_type", matchType);
    const { data: trendRows, error: trendError } = await trendQuery;
    if (trendError) console.error("[META API] daily trend query failed", { code: trendError.code, message: trendError.message });
    const byWeapon = new Map<string, { pre?: MetaRow; post?: MetaRow }>();
    for (const row of rows) {
      const current = byWeapon.get(row.weapon_name) || {};
      current[row.period] = row;
      byWeapon.set(row.weapon_name, current);
    }
    const weapons = Array.from(byWeapon.entries())
      .map(([weapon_name, periods], index) => ({
        id: index + 1,
        weapon_name,
        weapon_category: periods.post?.weapon_category || periods.pre?.weapon_category || "OTHERS",
        pre_patch: metric(periods.pre),
        post_patch: metric(periods.post),
      }))
      .sort((a, b) => b.post_patch.pick_share - a.post_patch.pick_share);

    return NextResponse.json({
      success: true,
      status: weapons.length > 0 ? "ready" : "collecting",
      message: weapons.length > 0 ? null : "분석된 매치가 쌓이면 실제 비교값이 표시됩니다.",
      patchVersion,
      patchStartedAt,
      matchType,
      dailyWeaponTrend: trendError ? [] : buildDailyWeaponTrend(trendRows || []),
      scopePickShares: trendError ? [] : buildScopePickShares(trendRows || [], patchStartedAt),
      burstCollection: trendError ? null : {
        pre: {
          total: new Set((trendRows || []).filter((row: any) => Date.parse(row.played_at) < Date.parse(patchStartedAt)).map((row: any) => `${row.match_id}:${row.platform}:${row.player_id}`)).size,
          completed: new Set((trendRows || []).filter((row: any) => Date.parse(row.played_at) < Date.parse(patchStartedAt) && row.first_sec_hits !== null).map((row: any) => `${row.match_id}:${row.platform}:${row.player_id}`)).size,
        },
        post: {
          total: new Set((trendRows || []).filter((row: any) => Date.parse(row.played_at) >= Date.parse(patchStartedAt)).map((row: any) => `${row.match_id}:${row.platform}:${row.player_id}`)).size,
          completed: new Set((trendRows || []).filter((row: any) => Date.parse(row.played_at) >= Date.parse(patchStartedAt) && row.first_sec_hits !== null).map((row: any) => `${row.match_id}:${row.platform}:${row.player_id}`)).size,
        },
      },
      weapons,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[META API] unexpected failure", error);
    return NextResponse.json({ success: false, status: "unavailable", message: "메타 집계를 불러오지 못했습니다.", weapons: [] }, { status: 500 });
  }
}
