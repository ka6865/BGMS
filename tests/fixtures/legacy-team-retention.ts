import type { LegacyTeamRecoveryInput } from '../../lib/pubg-analysis/legacyTeamRetentionRecovery';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../../lib/pubg-analysis/constants';

export const matchId = '123e4567-e89b-42d3-a456-426614174000';
export const playedAt = '2026-09-01T00:00:00.000Z';
export const basicA = {
  account_id: 'account.alpha', player_id: 'alpha', platform: 'steam', match_id: matchId,
  played_at: playedAt, game_mode: 'squad', map_name: 'Baltic_Main', kills: 2, damage: 250,
  win_place: 4, match_type: 'official',
};
export const basicB = {
  account_id: null as string | null, player_id: 'target', platform: 'steam', match_id: matchId,
  played_at: playedAt, game_mode: 'squad', map_name: 'Baltic_Main', kills: 3, damage: 400,
  win_place: 2, match_type: 'official',
};
export const officialTeam = [
  { name: 'Alpha', playerId: 'account.alpha', kills: 2, damageDealt: 250.5, winPlace: 4, timeSurvived: 900,
    assists: 1, DBNOs: 1, headshotKills: 1, longestKill: 120, heals: 2, boosts: 1, deathType: 'byplayer',
    walkDistance: 1000, rideDistance: 0, swimDistance: 0, revives: 0 },
  { name: 'Target', playerId: 'account.target', kills: 3, damageDealt: 400.9, winPlace: 2, timeSurvived: 1200,
    assists: 0, DBNOs: 2, headshotKills: 1, longestKill: 80, heals: 4, boosts: 2, deathType: 'byplayer',
    walkDistance: 1800, rideDistance: 0, swimDistance: 0, revives: 1 },
];
export const fullA = {
  matchId, platform: 'steam', player_id: 'alpha', v: RESULT_VERSION, calculationVersion: ANALYSIS_CALCULATION_VERSION,
  createdAt: playedAt, mapName: '에란겔', gameMode: 'squad', matchType: 'official',
  stats: { ...officialTeam[0] }, team: officialTeam, totalPlayers: 4, totalTeams: 2,
  matchInfo: { date: playedAt, mapId: 'Baltic_Main', mode: 'squad', matchType: 'official', duration: 1200, rankPct: 0.2 },
};
const events = [
  { _T: 'LogMatchStart', _D: playedAt },
  { _T: 'LogPlayerCreate', _D: '2026-09-01T00:00:01.000Z', character: { accountId: 'account.alpha', name: 'Alpha', teamId: 7 } },
  { _T: 'LogPlayerCreate', _D: '2026-09-01T00:00:02.000Z', character: { accountId: 'account.target', name: 'Target', teamId: 7 } },
  { _T: 'LogPlayerCreate', _D: '2026-09-01T00:00:03.000Z', character: { accountId: 'account.enemy1', name: 'EnemyOne', teamId: 9 } },
  { _T: 'LogPlayerCreate', _D: '2026-09-01T00:00:04.000Z', character: { accountId: 'ai.bot2', name: 'EnemyTwo', teamId: 9 } },
  { _T: 'LogMatchEnd', _D: '2026-09-01T00:20:00.000Z', allWeaponStats: [
    { accountId: 'account.alpha', stats: [] }, { accountId: 'account.target', stats: [] },
  ] },
];
export function legacyTeamRecoveryInput(overrides: Partial<LegacyTeamRecoveryInput> = {}): LegacyTeamRecoveryInput {
  return {
    targetBasic: { ...basicB },
    targetHasPersonalAnalysis: false,
    sourceBasic: { ...basicA },
    sourceIdentity: { matchId, platform: 'steam', playerId: 'alpha' },
    sourceFullResult: structuredClone(fullA),
    eventSource: {
      matchId, platform: 'steam', legacyKey: `${matchId}_alpha_v62_analyze.json`,
      requestedLegacyKey: `${matchId}_alpha_v62_analyze.json`, verification: 'parent-exact-key',
      artifactSha256: 'a'.repeat(64), events: structuredClone(events),
    },
    ...overrides,
  };
}
