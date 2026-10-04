import { readPerformanceCache, readPerformanceStates } from "@/lib/pubg/performanceCache";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildPlayerMatchIdentityFilter, fetchPlayerMatchesPaginated, normalizePlayerMatchesPage, normalizePlayerMatchHistoryFilter } from "@/lib/pubg/playerMatches";
 
import { readHistoryIngest } from "@/lib/pubg/matchDiscovery.server";
import { collectDiscoveredMatches } from "@/lib/pubg/discoveryBatch.server";
import { claimForceRefresh } from "@/lib/pubg/responseCache";

 export const dynamic = "force-dynamic";
 export const runtime = "nodejs";
 export const maxDuration = 30;
 
 function getAdminClient(signal?: AbortSignal) {
   const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
   const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
   if (!url || !key) return null;
   return createClient(url, key, {
     auth: { autoRefreshToken: false, persistSession: false },
     ...(signal ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
       const inputSignal = input instanceof Request ? input.signal : undefined;
       return fetch(input, { ...init, signal: AbortSignal.any(
         [signal, init?.signal, inputSignal].filter((value): value is AbortSignal => Boolean(value)),
       ) });
     } } } : {}),
   });
 }

/** Explicit collection only; GET history never performs upstream writes. */
export async function POST(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({error: '닉네임과 플랫폼을 확인해 주세요.'}, {status: 400, headers});
    }
    const nickname = typeof body?.nickname === 'string' ? body.nickname.trim() : '';
    const platform = body?.platform ?? 'steam';
    if (!nickname || nickname.length > 64 || !['steam', 'kakao'].includes(platform)) {
      return NextResponse.json({error: '닉네임과 플랫폼을 확인해 주세요.'}, {status: 400, headers});
    }
    if (!(process.env.PUBG_API_KEY ?? '').split(' ')[0].trim()) {
      return NextResponse.json({error: '경기 수집을 시작하지 못했습니다.', retryable: true}, {status: 503, headers});
    }
    // Include DB reads, leases, writes and progress in the same deadline. A
    // worker's loop budget alone cannot interrupt an awaited database request.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const db = getAdminClient(signal);
    if (!db) return NextResponse.json({error: '경기 수집을 시작하지 못했습니다.'}, {status: 503, headers});
    const initialPrivateResponse = await blockPrivatePlayer(platform, nickname, undefined, {client: db});
    if (initialPrivateResponse) return initialPrivateResponse;
    const accountId = await readCachedAccountId(db, platform, nickname, true);
    if (!accountId) return NextResponse.json({error: '먼저 플레이어 전적을 갱신해 주세요.', code: 'PLAYER_IDENTITY_REQUIRED'}, {status: 409, headers});
    const privateResponse = await blockPrivatePlayer(platform, nickname, accountId, {client: db});
    if (privateResponse) return privateResponse;
    if (!await claimForceRefresh(`history-collect:${platform}:${accountId}`, 15, db)) {
      return NextResponse.json({error: '경기 수집을 진행 중입니다. 잠시 후 다시 확인해 주세요.', retryable: true},
        {status: 429, headers: {...headers, 'Retry-After': '15'}});
    }
    const collection = await collectDiscoveredMatches(db, {platform, accountId}, signal);
    const historyIngest = await readHistoryIngest(db, platform, accountId);
    return NextResponse.json({collection, historyIngest}, {headers});
  } catch {
    return NextResponse.json({error: '경기 수집을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.', retryable: true},
      {status: 503, headers: {...headers, 'Retry-After': '15'}});
  }
}

async function readCachedAccountId(supabase: ReturnType<typeof getAdminClient>, platform: string, nickname: string, strict = false): Promise<string | null> {
  try {
    if (!supabase || typeof (supabase as any).from !== "function") return null;
    const query = (supabase as any).from("pubg_player_cache")
      .select("id")
      .eq("platform", platform)
      .eq("lower_nickname", nickname.trim().toLowerCase());
    if (typeof query?.maybeSingle !== "function") return null;
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error('player-identity-read-failed');
    if (typeof data?.id !== "string" || !/^account\.[A-Za-z0-9_-]+$/.test(data.id)) return null;
    return data.id;
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

async function readDiscoveredAccountIds(supabase: ReturnType<typeof getAdminClient>, platform: string, nickname: string): Promise<string[]> {
  try {
    if (!supabase || typeof (supabase as any).from !== "function") return [];
    const query = (supabase as any).from("pubg_player_match_discovery")
      .select("account_id")
      .eq("platform", platform)
      .ilike("nickname_at_discovery", nickname.trim().replace(/[\\%_]/g, "\\$&"))
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
   const initialPrivateResponse = await blockPrivatePlayer(platform, nickname);
   if (initialPrivateResponse) return initialPrivateResponse;
   const supabase = getAdminClient();
   if (!supabase) {
     return NextResponse.json({ error: "DB credentials missing" }, { status: 500 });
  }

  try {
    let accountId = await readCachedAccountId(supabase, platform, nickname);
    let result;
    if (matchId) {
      let query = supabase.from("pubg_player_matches").select("player_id, platform, account_id, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time");
      const identityFilter = buildPlayerMatchIdentityFilter(nickname, accountId);
      query = identityFilter ? query.or(identityFilter) : query.eq("player_id", nickname.trim().toLowerCase());
      const { data, error } = await query.eq("platform", platform).eq("match_id", matchId).limit(1);
      if (error) throw error;
      if (!data?.length) return NextResponse.json({ error: "이 플레이어의 저장된 경기 기록을 찾을 수 없습니다." }, { status: 404 });
      result = { matches: data, page: 1, pageSize: 1, totalCount: 1, totalPages: 1 };
      accountId ??= typeof data[0]?.account_id === "string" ? data[0].account_id : null;
    } else {
      result = await fetchPlayerMatchesPaginated(supabase, nickname, platform, page, 20, filter, accountId);
    }
    if (!accountId) {
      const matchAccountId = result.matches.find((match) => typeof match.account_id === "string")?.account_id;
      if (typeof matchAccountId === "string" && /^account\.[A-Za-z0-9_-]+$/.test(matchAccountId)) accountId = matchAccountId;
    }
    if (!accountId) accountId = await readCachedAccountId(supabase, platform, nickname);
    const storedAccounts = new Set(result.matches.map(match => match.account_id).filter((id): id is string => typeof id === "string"));
    if (accountId) storedAccounts.add(accountId);
    for (const storedAccount of storedAccounts) {
      const accountPrivateResponse = await blockPrivatePlayer(platform, nickname, storedAccount);
      if (accountPrivateResponse) return accountPrivateResponse;
    }
    const discoveredAccountIds = await readDiscoveredAccountIds(supabase, platform, nickname);
    for (const discoveredAccountId of discoveredAccountIds) {
      if (discoveredAccountId === accountId) continue;
      const discoveredPrivateResponse = await blockPrivatePlayer(platform, nickname, discoveredAccountId);
      if (discoveredPrivateResponse) return discoveredPrivateResponse;
    }
    if (!accountId) {
      const privateResponse = await blockPrivatePlayer(platform, nickname, undefined, { lookupUpstream: true });
      if (privateResponse) return privateResponse;
    }
    const performances = await readPerformanceCache(supabase, platform, nickname, result.matches.map(m => m.match_id), accountId);
    const performanceStates = await readPerformanceStates(supabase, platform, nickname, result.matches.map(m => m.match_id), accountId);
    const historyIngest = accountId ? await readHistoryIngest(supabase, platform, accountId) : null;
    return NextResponse.json({ ...result, performances, performanceStates, historyIngest }, { headers: { 'Cache-Control': 'no-store' } });
   } catch (error: any) {
     return NextResponse.json({ error: error.message || "과거 매치 조회 실패" }, { status: 500 });
   }
 }
