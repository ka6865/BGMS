'use server';

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export type GameModeFilter = 'all' | 'squad' | 'duo' | 'solo';
export type MatchTypeFilter = 'all' | 'competitive' | 'official';
export type PerspectiveFilter = 'all' | 'fpp' | 'tpp';

export type RankingEntry = {
  rank: number;
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
  Kiki_Main: '론도',
  DihorOtok_Main: '비켄디',
  Neon_Main: '데스턴',
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

/** player_id 배열로 닉네임 맵 조회 */
async function fetchNicknameMap(playerIds: string[]): Promise<{ nicknameMap: Map<string, string>; hasError: boolean }> {
  if (playerIds.length === 0) return { nicknameMap: new Map(), hasError: false };
  const { data, error } = await supabase
    .from('pubg_player_cache')
    .select('lower_nickname, nickname')
    .in('lower_nickname', playerIds.slice(0, 100));
  if (error || !data) {
    logRankingError('nickname_map', error);
    return { nicknameMap: new Map(), hasError: true };
  }
  return {
    nicknameMap: new Map(data.map((c: any) => [c.lower_nickname, c.nickname])),
    hasError: false,
  };
}

/** 이번 주 최고 딜량 TOP 30 */
export async function getWeeklyTopDamage(
  modeFilter: GameModeFilter = 'all',
  perspectiveFilter: PerspectiveFilter = 'all',
  matchTypeFilter: MatchTypeFilter = 'all'
): Promise<RankingQueryResult> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('global_benchmarks')
    .select('player_id, damage, kills, game_mode, map_name, created_at, tier')
    .gte('created_at', since)
    .in('game_mode', getModes(modeFilter, perspectiveFilter))
    .order('damage', { ascending: false })
    .order('kills', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);

  if (matchTypeFilter !== 'all') {
    query = query.eq('match_type', matchTypeFilter);
  }

  const { data, error } = await query;
  if (error || !data) {
    logRankingError('weekly_top_damage', error);
    return { data: [], hasError: true };
  }

  // 플레이어당 최고 딜량만 유지
  const seen = new Set<string>();
  const deduped: typeof data = [];
  for (const row of data) {
    if (!seen.has(row.player_id)) {
      seen.add(row.player_id);
      deduped.push(row);
    }
    if (deduped.length >= 30) break;
  }

  const { nicknameMap, hasError: hasNicknameError } = await fetchNicknameMap(deduped.map(d => d.player_id));
  if (hasNicknameError) return { data: [], hasError: true };

  return {
    data: deduped.map((row, i) => ({
      rank: i + 1,
      player_id: row.player_id,
      nickname: nicknameMap.get(row.player_id) || row.player_id,
      value: Math.round(row.damage),
      secondary: row.kills,
      game_mode: GAME_MODE_KO[row.game_mode] || row.game_mode,
      map_name: MAP_NAME_KO[row.map_name] || row.map_name || '알 수 없음',
      tier: row.tier || 'C',
      created_at: row.created_at,
    })),
    hasError: false,
  };
}

/** 이번 주 최고 킬 TOP 30 */
export async function getWeeklyTopKills(
  modeFilter: GameModeFilter = 'all',
  perspectiveFilter: PerspectiveFilter = 'all',
  matchTypeFilter: MatchTypeFilter = 'all'
): Promise<RankingQueryResult> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('global_benchmarks')
    .select('player_id, damage, kills, game_mode, map_name, created_at, tier')
    .gte('created_at', since)
    .in('game_mode', getModes(modeFilter, perspectiveFilter))
    .order('kills', { ascending: false })
    .order('damage', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);

  if (matchTypeFilter !== 'all') {
    query = query.eq('match_type', matchTypeFilter);
  }

  const { data, error } = await query;
  if (error || !data) {
    logRankingError('weekly_top_kills', error);
    return { data: [], hasError: true };
  }

  const seen = new Set<string>();
  const deduped: typeof data = [];
  for (const row of data) {
    if (!seen.has(row.player_id)) {
      seen.add(row.player_id);
      deduped.push(row);
    }
    if (deduped.length >= 30) break;
  }

  const { nicknameMap, hasError: hasNicknameError } = await fetchNicknameMap(deduped.map(d => d.player_id));
  if (hasNicknameError) return { data: [], hasError: true };

  return {
    data: deduped.map((row, i) => ({
      rank: i + 1,
      player_id: row.player_id,
      nickname: nicknameMap.get(row.player_id) || row.player_id,
      value: row.kills,
      secondary: Math.round(row.damage),
      game_mode: GAME_MODE_KO[row.game_mode] || row.game_mode,
      map_name: MAP_NAME_KO[row.map_name] || row.map_name || '알 수 없음',
      tier: row.tier || 'C',
      created_at: row.created_at,
    })),
    hasError: false,
  };
}

/** BGMS 티어 상위 30명 — 플레이어당 최고 스코어 기준 */
export async function getTopTierRanking(
  modeFilter: GameModeFilter = 'all',
  perspectiveFilter: PerspectiveFilter = 'all',
  matchTypeFilter: MatchTypeFilter = 'all'
): Promise<RankingQueryResult> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('global_benchmarks')
    .select('player_id, score, tier, damage, kills, game_mode, created_at')
    .gte('created_at', since)
    .in('game_mode', getModes(modeFilter, perspectiveFilter))
    .order('score', { ascending: false })
    .order('damage', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);

  if (matchTypeFilter !== 'all') {
    query = query.eq('match_type', matchTypeFilter);
  }

  const { data, error } = await query;
  if (error || !data) {
    logRankingError('top_tier', error);
    return { data: [], hasError: true };
  }

  // 플레이어당 최고 스코어만 유지 + match_count 집계
  const playerBest = new Map<string, { score: number; tier: string; damage: number; kills: number; game_mode: string; created_at: string; count: number }>();
  for (const row of data) {
    const existing = playerBest.get(row.player_id);
    if (!existing) {
      playerBest.set(row.player_id, { score: row.score, tier: row.tier, damage: row.damage, kills: row.kills, game_mode: row.game_mode, created_at: row.created_at, count: 1 });
    } else {
      existing.count++;
      if (row.score > existing.score) {
        existing.score = row.score;
        existing.tier = row.tier;
        existing.damage = row.damage;
        existing.kills = row.kills;
        existing.game_mode = row.game_mode;
        existing.created_at = row.created_at;
      }
    }
  }

  // 스코어 내림차순 정렬
  const sorted = [...playerBest.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 30);

  const { nicknameMap, hasError: hasNicknameError } = await fetchNicknameMap(sorted.map(([id]) => id));
  if (hasNicknameError) return { data: [], hasError: true };

  return {
    data: sorted.map(([player_id, d], i) => ({
      rank: i + 1,
      player_id,
      nickname: nicknameMap.get(player_id) || player_id,
      value: Math.round(d.score),
      secondary: Math.round(d.damage),
      game_mode: GAME_MODE_KO[d.game_mode] || d.game_mode,
      map_name: '',
      tier: d.tier || 'C',
      created_at: d.created_at,
      match_count: d.count,
    })),
    hasError: false,
  };
}
