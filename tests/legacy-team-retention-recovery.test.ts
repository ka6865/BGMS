import { describe, expect, it } from 'vitest';
import {
  recoverLegacyTeamPerformance,
  type LegacyTeamRecoveryInput,
} from '../lib/pubg-analysis/legacyTeamRetentionRecovery';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';

import { legacyTeamRecoveryInput as input, matchId, playedAt, basicA, basicB, fullA, officialTeam } from './fixtures/legacy-team-retention';

describe('legacy same-team performance recovery', () => {
  it('requires a verified raw artifact hash', () => {
    const value = input();
    delete (value.eventSource as any).artifactSha256;
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
    value.eventSource.artifactSha256 = 'bad';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });

  it('keeps official measured zeroes and omits unobserved derived zeroes', () => {
    const recovered = recoverLegacyTeamPerformance(input())!;
    expect(recovered.compact.stats).toMatchObject({ assists: 0, processedDamageDealt: null, kills: 3, damageDealt: 400.9 });
    expect(recovered.compact.itemUseStats?.throwCount).toBeNull();
    expect(recovered.compact.duelStats?.totalDuels).toBeNull();
    expect(recovered.compact.badges).toEqual([]);
    expect(recovered.compact).not.toHaveProperty('myRank');
    expect(recovered.compact.retentionRecoveryEvidence).toMatchObject({ rawArtifactSha256: 'a'.repeat(64) });
  });
  it('rebuilds the target from official team stats and proposes only verified basic metadata', () => {
    const recovered = recoverLegacyTeamPerformance(input());
    expect(recovered).not.toBeNull();
    expect(recovered!.expectedBasic).toMatchObject({ account_id: 'account.target', player_id: 'target',
      match_type: 'official', kills: 3, damage: 400, win_place: 2 });
    expect(recovered!.fullResult.stats).toMatchObject({ name: 'Target', playerId: 'account.target',
      kills: 3, damageDealt: 400.9, winPlace: 2, timeSurvived: 1200 });
    expect(recovered!.fullResult).toMatchObject({ retentionRecoverySource: 'legacy-team-events',
      v: RESULT_VERSION, calculationVersion: ANALYSIS_CALCULATION_VERSION,
      benchmark: null, isValidBenchmark: false, platform: 'steam', player_id: 'target' });
    expect(recovered!.fullResult.retentionRecoveryContext).toMatchObject({ completeness: 'partial',
      officialStatsScope: 'target-observed-team-only', unavailable: expect.arrayContaining(['LogPlayerAttack']) });
    expect(recovered!.fullResult).not.toHaveProperty('myRank');
    expect(recovered!.fullResult).not.toHaveProperty('matchInfo');
    expect(recovered!.compact).toMatchObject({ performanceHistorical: true, benchmark: null,
      isValidBenchmark: false, retentionRecoveryContext: 'partial-legacy-team-events',
      stats: { name: 'Target', playerId: 'account.target' } });
    expect(recovered!.writeCandidate).toMatchObject({ identity: { platform: 'steam', match_id: matchId,
      player_id: 'target', account_id: 'account.target' }, calculation_version: ANALYSIS_CALCULATION_VERSION,
      result_version: RESULT_VERSION, summary_version: 1 });
    expect(recovered!.writeCandidate.source_checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered!.evidence).toMatchObject({ observedPlayers: 4, officialPlayers: 4,
      observedTeams: 2, officialTeams: 2, rawArtifactSha256: 'a'.repeat(64),
      cohortEvidence: 'LogPlayerCreate exact official lobby counts' });
    expect(recovered!.evidence.sourceFullResultSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds the real nickname-bearing legacy filename to the source or target', () => {
    const value = input();
    value.eventSource.legacyKey = `${matchId}_target_v72_analyze.json`;
    value.eventSource.requestedLegacyKey = value.eventSource.legacyKey;
    expect(recoverLegacyTeamPerformance(value)).not.toBeNull();
    value.eventSource.legacyKey = `${matchId}_unrelated_v72_analyze.json`;
    value.eventSource.requestedLegacyKey = value.eventSource.legacyKey;
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });

  it('uses matching observed maps instead of the legacy derived erangel default', () => {
    const value = input({ sourceBasic: { ...basicA, map_name: 'Desert_Main' }, targetBasic: { ...basicB, map_name: 'Desert_Main' } });
    const source = value.sourceFullResult as any;
    source.mapName = '미라마'; source.matchInfo.mapId = 'erangel';
    expect(recoverLegacyTeamPerformance(value)?.fullResult).toMatchObject({ mapName: '미라마', mapId: 'Desert_Main' });
    source.matchInfo.map = '에란겔';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
    delete source.matchInfo.map; source.matchInfo.mapId = 'Baltic_Main';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
    source.matchInfo.mapId = 'unrecognized-map';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });

  it('accepts only the exact unlinked 0/0/99 placeholder as an observed-basic replacement', () => {
    const placeholder = { ...basicB, account_id: null, kills: 0, damage: 0, win_place: 99 };
    expect(recoverLegacyTeamPerformance(input({ targetBasic: placeholder }))?.expectedBasic)
      .toMatchObject({ kills: 3, damage: 400, win_place: 2, account_id: 'account.target' });
    expect(recoverLegacyTeamPerformance(input({ targetBasic: { ...placeholder, account_id: 'account.wrong' } })))
      .toBeNull();
    expect(recoverLegacyTeamPerformance(input({ targetBasic: { ...placeholder, kills: 1 } }))).toBeNull();
  });

  it('recovers metadata only for a wholly unlinked unknown 0/0/99 placeholder', () => {
    const value = input({ targetBasic: { ...basicB, played_at: '2026-09-02T00:00:00Z',
      game_mode: 'unknown', map_name: 'unknown', match_type: 'unavailable', kills: 0, damage: 0, win_place: 99 } });
    expect(recoverLegacyTeamPerformance(value)?.expectedBasic).toMatchObject({ played_at: playedAt,
      game_mode: 'squad', map_name: 'Baltic_Main', match_type: 'official', kills: 3, damage: 400, win_place: 2 });
    value.targetBasic.map_name = 'Desert_Main';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
    value.targetBasic.map_name = 'unknown'; value.targetBasic.kills = 1;
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });
  it('keeps a known matching match type while repairing unknown placeholder metadata', () => {
    const value = input({ targetBasic: { ...basicB, played_at: '2026-09-02T00:00:00Z',
      game_mode: 'unknown', map_name: 'unknown', match_type: 'official', kills: 0, damage: 0, win_place: 99 } });
    expect(recoverLegacyTeamPerformance(value)?.expectedBasic).toMatchObject({ played_at: playedAt,
      game_mode: 'squad', map_name: 'Baltic_Main', match_type: 'official', kills: 3, damage: 400, win_place: 2 });
    value.targetBasic.match_type = 'competitive';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });

  it('counts validated ai.* lobby participants and ignores uncontracted matchInfo.type', () => {
    const value = input();
    (value.sourceFullResult as any).matchInfo.type = 'legacy-extension';
    expect(recoverLegacyTeamPerformance(value)?.evidence).toMatchObject({ observedPlayers: 4, officialPlayers: 4 });
  });

  it('uses owner-intersection only to remove excess LogPlayerCreate records', () => {
    const value = input();
    (value.eventSource.events as any[])[5].allWeaponStats = [
      { accountId: 'account.alpha' }, { accountId: 'account.target' },
      { accountId: 'account.enemy1' }, { accountId: 'ai.bot2' },
    ];
    (value.eventSource.events as any[]).splice(5, 0, { _T: 'LogPlayerCreate',
      _D: '2026-08-31T23:59:59.000Z', character: { accountId: 'account.quit', name: 'Quitter', teamId: 7 } });
    expect(recoverLegacyTeamPerformance(value)?.evidence).toMatchObject({ observedPlayers: 4, officialPlayers: 4,
      cohortEvidence: 'LogPlayerCreate ∩ LogMatchEnd.allWeaponStats.accountId' });
  });

  it('uses the complete finished-player list to exclude pre-match quitters', () => {
    const value = input();
    const events = value.eventSource.events as any[];
    const finished = events.filter(e => e._T === 'LogPlayerCreate').map(e => ({ character: { ...e.character } }));
    events[5].characters = finished;
    events.splice(5, 0, { _T: 'LogPlayerCreate', character: { accountId: 'account.quit', name: 'Quitter', teamId: 13 } });
    expect(recoverLegacyTeamPerformance(value)?.evidence).toMatchObject({ observedPlayers: 4, officialPlayers: 4,
      observedTeams: 2, officialTeams: 2, cohortEvidence: 'LogMatchEnd.characters exact official lobby counts' });
    finished[0].character.accountId = 'account.foreign';
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });

  it('rejects an incomplete or contradictory finished-player list', () => {
    const value = input(); const events = value.eventSource.events as any[];
    const finished = events.filter(e => e._T === 'LogPlayerCreate').map(e => ({ ...e.character }));
    events[5].characters = finished.slice(0, 3);
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
    events[5].characters = finished; finished[0].teamId = 999;
    expect(recoverLegacyTeamPerformance(value)).toBeNull();
  });

  it('allows source-A nickname verification and backfills unknown target match type', () => {
    const value = input({ targetBasic: { ...basicB, match_type: 'unavailable' },
      eventSource: { ...input().eventSource, verification: 'verified-nickname', verifiedNickname: 'alpha' } });
    expect(recoverLegacyTeamPerformance(value)?.expectedBasic.match_type).toBe('official');
    expect(recoverLegacyTeamPerformance(input({ targetBasic: { ...basicB, match_type: 'unknown' } }))?.expectedBasic.match_type)
      .toBe('official');
    const wrongNickname = { ...value, eventSource: { ...value.eventSource, verifiedNickname: 'target' } };
    expect(recoverLegacyTeamPerformance(wrongNickname)).toBeNull();
  });

  it.each([
    ['wrong source scope', { sourceIdentity: { matchId, platform: 'kakao', playerId: 'alpha' } }],
    ['wrong source nickname', { sourceIdentity: { matchId, platform: 'steam', playerId: 'other' } }],
    ['wrong source root platform', { sourceFullResult: { ...fullA, platform: 'kakao' } }],
    ['wrong source root nickname', { sourceFullResult: { ...fullA, player_id: 'other' } }],
    ['contradictory official basic stats', { sourceFullResult: { ...fullA, stats: { ...fullA.stats, kills: 8 } } }],
    ['contradictory source basic damage', { sourceBasic: { ...basicA, damage: 251 } }],
    ['missing official teammate stat', { sourceFullResult: { ...fullA, team: [officialTeam[0], { ...officialTeam[1], timeSurvived: undefined }] } }],
    ['already analyzed target', { targetHasPersonalAnalysis: true }],
    ['known different match type', { targetBasic: { ...basicB, match_type: 'competitive' } }],
    ['target date mismatch', { targetBasic: { ...basicB, played_at: '2026-09-02T00:00:00.000Z' } }],
    ['target map mismatch', { targetBasic: { ...basicB, map_name: 'Desert_Main' } }],
    ['target mode mismatch', { targetBasic: { ...basicB, game_mode: 'solo' } }],
    ['array-valued match type', { sourceFullResult: { ...fullA, matchInfo: { ...fullA.matchInfo, matchType: ['official'] } } }],
    ['unverified requested key', { eventSource: { ...input().eventSource, requestedLegacyKey: `${matchId}_v61_analyze.json` } }],
  ] as const)('rejects %s', (_label, override) => {
    expect(recoverLegacyTeamPerformance(input(override as Partial<LegacyTeamRecoveryInput>))).toBeNull();
  });

  it.each([
    ['missing owner cohort', (i: LegacyTeamRecoveryInput) => {
      const e = i.eventSource.events as any[];
      e.splice(5, 0, { _T: 'LogPlayerCreate', character: { accountId: 'account.quit', name: 'Quitter', teamId: 7 } });
      e[6].allWeaponStats = e[6].allWeaponStats.slice(1);
    }],
    ['mixed observed team', (i: LegacyTeamRecoveryInput) => { (i.eventSource.events as any[])[2].character.teamId = 8; }],
    ['missing match-end lobby evidence after char-count mismatch', (i: LegacyTeamRecoveryInput) => {
      const e = i.eventSource.events as any[];
      e.splice(5, 0, { _T: 'LogPlayerCreate', character: { accountId: 'account.quit', name: 'Quitter', teamId: 7 } });
      delete e[6].allWeaponStats;
    }],
    ['missing lobby rank is withheld', (i: LegacyTeamRecoveryInput) => { (i.sourceFullResult as any).matchInfo.rankPct = undefined; }],
    ['missing start timestamp', (i: LegacyTeamRecoveryInput) => { (i.eventSource.events as any[])[0]._D = undefined; }],
    ['unavailable source match type', (i: LegacyTeamRecoveryInput) => { (i.sourceFullResult as any).matchType = 'unavailable'; }],
  ])('protects incomplete or contradictory evidence: %s', (_label, mutate) => {
    const value = input();
    mutate(value);
    const result = recoverLegacyTeamPerformance(value);
    if (_label === 'missing lobby rank is withheld') {
      expect(result).not.toBeNull();
      expect(result!.fullResult.matchInfo).toBeUndefined();
      expect(result!.compact).not.toHaveProperty('matchInfo');
    } else {
      expect(result).toBeNull();
    }
  });
});
