import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BENCHMARK_FILTER_VERSION, BENCHMARK_POPULATION_EVIDENCE_VERSION } from "@/lib/pubg-analysis/benchmarkLookup";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
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
  filter_version?: number;
  population_evidence_version?: number;
};

type ScopePickShare = {
  scope: "category";
  weapon_category: string;
  period: "pre" | "post";
  player_match_count: number;
  weapon_pick_count: number;
};

/** Strict evidence gate retained for benchmark consumers. The public patch report
 * separately includes preserved historical samples; it never promotes their provenance.
 */
export function isSafeWeaponMetaPopulationRow(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const candidate = row as Record<string, unknown>;
  if (Number(candidate.filter_version) !== BENCHMARK_FILTER_VERSION) return false;
  const evidence = candidate.population_evidence_version ?? candidate.populationEvidenceVersion;
  return Number(evidence) === BENCHMARK_POPULATION_EVIDENCE_VERSION;
}

function metric(row: MetaRow | undefined, periodSamples = 0) {
  const samples = Number(row?.player_match_count ?? periodSamples);
  const picks = Number(row?.active_pick_count || 0);
  const damage = Number(row?.total_damage || 0);
  const killsAndDbnos = Number(row?.total_kills || 0) + Number(row?.total_dbnos || 0);
  return {
    match_count: samples,
    active_pick_count: picks,
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
  const patchVersion = request.nextUrl.searchParams.get("patch")?.trim() || null;
  if (patchVersion && !/^[a-zA-Z0-9._-]{1,32}$/.test(patchVersion)) {
    return NextResponse.json({ success: false, message: "올바른 패치를 선택해 주세요." }, { status: 400 });
  }
  const matchType = requestedMatchType === "official" || requestedMatchType === "competitive" ? requestedMatchType : "all";
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({
      success: false,
      status: "not_configured",
      message: "메타 집계 연결이 아직 설정되지 않았습니다.",
      patchVersion: patchVersion || null,
      weapons: [],
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase.rpc("get_weapon_meta_patch_report", {
      p_patch_version: patchVersion,
      p_match_type: matchType,
    });
    if (error?.code === "22023") {
      return NextResponse.json({ success: false, message: "등록되지 않은 패치입니다." }, { status: 400 });
    }
    if (error || !data || !Array.isArray(data.comparison)) {
      console.error("[META API] report query failed", { code: error?.code });
      return NextResponse.json({ success: false, status: "unavailable",
        message: "메타 집계를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        patchVersion, weapons: [] }, { status: 503 });
    }
    // The public report reuses stored samples by match date within each patch window.
    // It aggregates in the DB, so the REST row cap cannot truncate totals/trends.
    const rows = data.comparison as MetaRow[];
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
        pre_patch: metric(periods.pre, data.burstCollection?.pre.total),
        post_patch: metric(periods.post, data.burstCollection?.post.total),
      }))
      .sort((a, b) => b.post_patch.pick_share - a.post_patch.pick_share);

    const hasPre = Number(data.burstCollection?.pre.total) > 0;
    const hasPost = Number(data.burstCollection?.post.total) > 0;
    return NextResponse.json({
      success: true,
      status: hasPre && hasPost ? "ready" : "collecting",
      message: data.scheduled ? "패치 적용 예정입니다. 지금은 패치 전 기록을 볼 수 있으며, 적용 후 수집된 경기가 비교에 반영됩니다." : !hasPost ? "패치 후 표본을 수집 중입니다. 경기가 쌓이면 비교가 표시됩니다." : !hasPre ? "보관된 패치 전 표본이 없습니다. 패치 후 기록부터 확인할 수 있습니다." : null,
      patchVersion: data.patchVersion,
      patchStartedAt: data.patchStartedAt,
      preStartedAt: data.preStartedAt,
      preEndedAt: data.preEndedAt,
      postEndedAt: data.postEndedAt,
      timingStatus: data.timingStatus,
      patches: data.patches,
      matchType,
      dailyWeaponTrend: data.dailyWeaponTrend,
      scopePickShares: data.scopePickShares,
      burstCollection: data.burstCollection,
      weapons,
      updatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch (error) {
    console.error("[META API] unexpected failure", error);
    return NextResponse.json({ success: false, status: "unavailable", message: "메타 집계를 불러오지 못했습니다.", weapons: [] }, { status: 500 });
  }
}
