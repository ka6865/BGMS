'use server';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from "@/lib/pubg-analysis/constants";

import { createClient } from '@supabase/supabase-js';
import {
  BENCHMARK_FILTER_VERSION,
  BENCHMARK_POPULATION_EVIDENCE_VERSION,
} from '@/lib/pubg-analysis/benchmarkLookup';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export type GameModeFilter = 'all' | 'squad' | 'duo' | 'solo';
export type MatchTypeFilter = 'all' | 'competitive' | 'official';
export type PerspectiveFilter = 'all' | 'fpp' | 'tpp';

export type RankingEntry = {
  rank: number;
  platform?: "steam" | "kakao";
  player_id: string;
  nickname: string;
  value: number;         // damage | kills | score
  secondary?: number;    // kills (for damage tab) | damage (for kills tab)
  game_mode: string;
  map_name: string;
  tier?: string;
  created_at?: string;
  match_count?: number;
};

export type RankingQueryResult = {
  data: RankingEntry[];
  hasError: boolean;
};

const MAP_NAME_KO: Record<string, string> = {
  Baltic_Main: '에란겔',
  Desert_Main: '미라마',
  Tiger_Main: '태이고',
  Kiki_Main: '데스턴',
  DihorOtok_Main: '비켄디',
  Neon_Main: '론도',
  Summerland_Main: '카라킨',
  Savage_Main: '사녹',
  Chimera_Main: '파라모',
  Range_Main: '훈련장',
};

const GAME_MODE_KO: Record<string, string> = {
  squad: '스쿼드',
  'squad-fpp': '스쿼드 FPP',
  duo: '듀오',
  'duo-fpp': '듀오 FPP',
  solo: '솔로',
  'solo-fpp': '솔로 FPP',
};

function logRankingError(scope: string, error: unknown) {
  if (error) {
    console.error(`[RANKINGS] ${scope} query failed`, error);
  }
}

function getModes(filter: GameModeFilter, perspective: PerspectiveFilter): string[] {
  let modes: string[] = [];
  if (filter === 'all') {
    modes = ['solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp'];
  } else if (filter === 'squad') {
    modes = ['squad', 'squad-fpp'];
  } else if (filter === 'duo') {
    modes = ['duo', 'duo-fpp'];
  } else if (filter === 'solo') {
    modes = ['solo', 'solo-fpp'];
  }

  if (perspective === 'fpp') {
    return modes.filter(m => m.endsWith('-fpp'));
  } else if (perspective === 'tpp') {
    return modes.filter(m => !m.endsWith('-fpp'));
  }
  return modes;
}

function privateRankingKeys(rows: Array<{ platform?: string; lower_nickname?: string; nickname?: string; account_id?: string }>): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    const platform = String(row.platform || '').toLowerCase();
    if (!platform) continue;
    const platforms = platform === 'all' ? ['steam', 'kakao'] : [platform];
    const nickname = String(row.lower_nickname || row.nickname || '').trim().toLowerCase();
    for (const scopedPlatform of platforms) {
      if (nickname) keys.push(`${scopedPlatform}:${nickname}`);
      if (row.account_id) keys.push(`${scopedPlatform}:account:${row.account_id}`);
    }
  }
  return [...new Set(keys)];
}

/** The database selects each player's best match before applying TOP 30. */
async function readRanking(tab: 'damage' | 'kills' | 'tier', mode: GameModeFilter, perspective: PerspectiveFilter, matchType: MatchTypeFilter): Promise<RankingQueryResult> {
  try {
    const privacy = await supabase.from('system_settings').select('value').eq('key', 'private_players_list').maybeSingle();
    if (privacy.error) throw privacy.error;
    const privatePlayers = privacy.data?.value ? JSON.parse(privacy.data.value) : [];
    if (!Array.isArray(privatePlayers)) throw new Error('Invalid privacy settings');
    const { data, error } = await supabase.rpc('get_pubg_rankings', {
      p_tab: tab, p_modes: getModes(mode, perspective), p_match_type: matchType,
      p_calculation: ANALYSIS_CALCULATION_VERSION, p_filter: BENCHMARK_FILTER_VERSION,
      p_population: BENCHMARK_POPULATION_EVIDENCE_VERSION, p_result: RESULT_VERSION,
      p_excluded: privateRankingKeys(privatePlayers),
    });
    if (error || !Array.isArray(data)) throw error || new Error('Missing ranking response');
    return { hasError: false, data: data.map((row, index) => ({
      rank: index + 1, platform: row.platform, player_id: row.player_id, nickname: row.player_id,
      value: Math.round(row.value), secondary: Math.round(row.secondary), tier: row.tier || undefined,
      game_mode: GAME_MODE_KO[row.game_mode] || row.game_mode,
      map_name: MAP_NAME_KO[row.map_name] || row.map_name || '', created_at: row.played_at,
      match_count: Number(row.match_count),
    })) };
  } catch (error) {
    logRankingError(tab, error);
    return { data: [], hasError: true };
  }
}

// Privacy settings can change at any time. Do not put rankings behind a
// time-based cache that can keep a newly-private player visible for a minute.
// The underlying RPC remains indexed and returns only the requested top rows.
const readRankingCached = readRanking;

export async function getWeeklyTopDamage(mode: GameModeFilter = 'all', perspective: PerspectiveFilter = 'all', matchType: MatchTypeFilter = 'all'): Promise<RankingQueryResult> {
  return readRankingCached('damage', mode, perspective, matchType);
}
export async function getWeeklyTopKills(mode: GameModeFilter = 'all', perspective: PerspectiveFilter = 'all', matchType: MatchTypeFilter = 'all'): Promise<RankingQueryResult> {
  return readRankingCached('kills', mode, perspective, matchType);
}
export async function getTopTierRanking(mode: GameModeFilter = 'all', perspective: PerspectiveFilter = 'all', matchType: MatchTypeFilter = 'all'): Promise<RankingQueryResult> {
  return readRankingCached('tier', mode, perspective, matchType);
}
