import { readPerformanceCache, readPerformanceStates } from "@/lib/pubg/performanceCache";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchPlayerMatchesPaginated, normalizePlayerMatchesPage, normalizePlayerMatchHistoryFilter } from "@/lib/pubg/playerMatches";
 
 export const dynamic = "force-dynamic";
 export const runtime = "nodejs";
 
 function getAdminClient() {
   const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
   const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
   if (!url || !key) return null;
   return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
 }

async function readCachedAccountId(supabase: ReturnType<typeof getAdminClient>, platform: string, nickname: string): Promise<string | null> {
  try {
    if (!supabase || typeof (supabase as any).from !== "function") return null;
    const query = (supabase as any).from("pubg_player_cache")
      .select("id")
      .eq("platform", platform)
      .eq("lower_nickname", nickname.trim().toLowerCase());
    if (typeof query?.maybeSingle !== "function") return null;
    const { data, error } = await query.maybeSingle();
    if (error || typeof data?.id !== "string" || !/^account\.[A-Za-z0-9_-]+$/.test(data.id)) return null;
    return data.id;
  } catch {
    return null;
  }
}

async function readDiscoveredAccountIds(supabase: ReturnType<typeof getAdminClient>, platform: string, nickname: string): Promise<string[]> {
  try {
    if (!supabase || typeof (supabase as any).from !== "function") return [];
    const query = (supabase as any).from("pubg_player_match_discovery")
      .select("account_id")
      .eq("platform", platform)
      .ilike("nickname_at_discovery", nickname.trim())
      .limit(50);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return [];
    return [...new Set(data
      .map((row) => row && typeof row.account_id === "string" ? row.account_id : null)
      .filter((accountId): accountId is string => Boolean(accountId && /^account\.[A-Za-z0-9_-]+$/.test(accountId))))];
  } catch {
    return [];
  }
}
 
 export async function GET(request: NextRequest) {
   const { searchParams } = request.nextUrl;
  const nickname = searchParams.get("nickname");
  const platform = searchParams.get("platform") || "steam";
  const matchId = searchParams.get("matchId");
  const filter = normalizePlayerMatchHistoryFilter(searchParams.get("filter"));
  if (matchId !== null && !/^[A-Za-z0-9_.-]{1,128}$/.test(matchId)) return NextResponse.json({ error: "올바르지 않은 경기 ID입니다." }, { status: 400 });
  const page = normalizePlayerMatchesPage(searchParams.get("page"));
 
   if (!nickname) {
     return NextResponse.json({ error: "닉네임을 입력해주세요." }, { status: 400 });
   }
 
   if (!['steam', 'kakao'].includes(platform)) return NextResponse.json({ error: '지원하지 않는 플랫폼입니다.' }, { status: 400 });
   if (await isPlayerPrivate(platform, nickname)) return NextResponse.json({ error: '비공개 플레이어입니다.' }, { status: 403 });
   const supabase = getAdminClient();
   if (!supabase) {
     return NextResponse.json({ error: "DB credentials missing" }, { status: 500 });
  }

  try {
    let accountId: string | null = null;
    let result;
    if (matchId) {
      const { data, error } = await supabase.from("pubg_player_matches").select("player_id, platform, account_id, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time")
        .eq("player_id", nickname.trim().toLowerCase()).eq("platform", platform).eq("match_id", matchId).limit(1);
      if (error) throw error;
      if (!data?.length) return NextResponse.json({ error: "이 플레이어의 저장된 경기 기록을 찾을 수 없습니다." }, { status: 404 });
      result = { matches: data, page: 1, pageSize: 1, totalCount: 1, totalPages: 1 };
      accountId = typeof data[0]?.account_id === "string" ? data[0].account_id : null;
    } else {
      accountId = await readCachedAccountId(supabase, platform, nickname);
      result = await fetchPlayerMatchesPaginated(supabase, nickname, platform, page, 20, filter);
    }
    if (!accountId) {
      const matchAccountId = result.matches.find((match) => typeof match.account_id === "string")?.account_id;
      if (typeof matchAccountId === "string" && /^account\.[A-Za-z0-9_-]+$/.test(matchAccountId)) accountId = matchAccountId;
    }
    if (!accountId) accountId = await readCachedAccountId(supabase, platform, nickname);
    if (accountId && await isPlayerPrivate(platform, nickname, accountId)) {
      return NextResponse.json({ error: '비공개 플레이어입니다.' }, { status: 403 });
    }
    const discoveredAccountIds = await readDiscoveredAccountIds(supabase, platform, nickname);
    for (const discoveredAccountId of discoveredAccountIds) {
      if (discoveredAccountId !== accountId && await isPlayerPrivate(platform, nickname, discoveredAccountId)) {
        return NextResponse.json({ error: '비공개 플레이어입니다.' }, { status: 403 });
      }
    }
    const performances = await readPerformanceCache(supabase, platform, nickname, result.matches.map(m => m.match_id));
    const performanceStates = await readPerformanceStates(supabase, platform, nickname, result.matches.map(m => m.match_id));
    return NextResponse.json({ ...result, performances, performanceStates }, { headers: { 'Cache-Control': 'no-store' } });
   } catch (error: any) {
     return NextResponse.json({ error: error.message || "과거 매치 조회 실패" }, { status: 500 });
   }
 }
