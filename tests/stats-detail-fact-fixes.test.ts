import { describe, expect, it } from 'vitest';
import { AnalysisEngine } from '../lib/pubg-analysis/AnalysisEngine';
import { MAP_NAMES, getTranslatedWeaponName, getWeaponDisplayName } from '../lib/pubg-analysis/constants';
import { get2DReplayUnsupportedMessage, resolve2DReplayMapId } from '../lib/replay/mapCapabilities';
import { getMapDisplayName, isBattleRoyaleMapName } from '../lib/stats/mapDisplayName';
import { getWeaponMasteryCategory } from '../lib/pubg/weaponMastery';

describe('S1897(Winchester) 분류', () => {
  it('S1897은 저격이 아니라 샷건으로 분류하고 Win94는 SR을 유지한다', () => {
    expect(getWeaponMasteryCategory('Item_Weapon_Winchester_C')).toBe('샷건');
    expect(getWeaponMasteryCategory('Item_Weapon_Win1894_C')).toBe('SR');
  });
});

describe('전적 상세보기 무기 이름 번역', () => {
  it.each([
    ['WeapThompson_C', '토미건'],
    ['WeapBizonPP19_C', 'PP-19 비존'],
    ['WeapSaiga12_C', 'S12K'],
    ['WeapBerreta686_C', 'S686'],
    ['WeapWinchester_C', 'S1897'],
    ['WeapQBZ95_C', 'QBZ95'],
    ['WeapSawnoff_C', '소드오프'],
    ['WeapM1911_C', 'P1911'],
    ['WeapRhino_C', 'R45'],
    ['WeapNagantM1895_C', 'R1895'],
    ['WeapSickle_C', '낫'],
    ['WeapMacheteProjectile_C', '마체테'],
    ['WeapFlareGun_C', '플레어 건'],
    ['WeapPanzerFaust100M1_C', '판처파우스트'],
    ['PlayerMale_A_C', '맨손'],
    ['Buff_FireDOT_C', '화염 피해'],
    ['BP_FireEffectController_C', '화염병 화염'],
    ['BP_MolotovFireDebuff_C', '화염병 화염 피해'],
    ['Bluezonebomb_EffectActor_C', '블루존 수류탄'],
    ['Buff_DecreaseBreathInApnea_C', '익사'],
    ['TslGameModeBase_BattleRoyaleBP_C', '자기장'],
    ['WeapFamasG2_C', '파마스'],
  ])('%s를 %s로 번역한다', (id, name) => {
    expect(getTranslatedWeaponName(id)).toBe(name);
  });

  it('통계 키로 쓰이는 접두사 없는 ID도 같은 이름으로 번역한다', () => {
    expect(getTranslatedWeaponName('Thompson')).toBe('토미건');
    expect(getTranslatedWeaponName('Winchester')).toBe('S1897');
    expect(getTranslatedWeaponName('PanzerFaust100M1')).toBe('판처파우스트');
  });

  it('번역표에 없는 무기는 내부 접두사와 접미사를 떼고 표시한다', () => {
    expect(getWeaponDisplayName('WeapXyzGun_C')).toBe('XyzGun');
    expect(getWeaponDisplayName('Item_Weapon_Foo_C')).toBe('Foo');
    expect(getWeaponDisplayName('WeapThompson_C')).toBe('토미건');
  });
});

describe('전적 상세보기 맵 이름', () => {
  it('헤이븐과 카라킨이 하나의 표에서 같은 이름으로 나온다', () => {
    expect(MAP_NAMES.Heaven_Main).toBe('헤이븐');
    expect(MAP_NAMES.Summerland_Main).toBe('카라킨');
    expect(getMapDisplayName('Heaven_Main')).toBe('헤이븐');
    expect(isBattleRoyaleMapName('Heaven_Main')).toBe(true);
    expect(Object.values(MAP_NAMES)).not.toContain('칼린도');
  });
});

describe('2D 리플레이 지원 맵 판정', () => {
  it('지원하는 6개 맵은 영문 ID와 한글 이름 모두 해석한다', () => {
    expect(resolve2DReplayMapId('Baltic_Main')).toBe('Erangel');
    expect(resolve2DReplayMapId('에란겔')).toBe('Erangel');
    expect(resolve2DReplayMapId('DihorOtok_Main')).toBe('Vikendi');
    expect(resolve2DReplayMapId('Neon_Main')).toBe('Rondo');
    expect(resolve2DReplayMapId('Kiki_Main')).toBe('Deston');
  });

  it('사녹, 카라킨, 파라모, 헤이븐과 빈 이름은 404 대신 null이다', () => {
    for (const name of ['사녹', 'Savage_Main', '카라킨', 'Summerland_Main', '파라모', 'Chimera_Main', '헤이븐', 'Heaven_Main', '']) {
      expect(resolve2DReplayMapId(name)).toBeNull();
    }
    expect(get2DReplayUnsupportedMessage('사녹')).toBe('사녹 맵은 현재 2D 리플레이를 지원하지 않습니다.');
  });
});

describe('공식 무기 통계 제외 필터', () => {
  const runWithTeammateWeapons = (weapons: string[]) => {
    const engine = new AnalysisEngine(
      'KangHeeSung_',
      'account.main',
      new Set(['kangheesung_', 'miaeq_q']),
      new Set(['account.main', 'account.miaeq']),
      new Set(),
      new Set(),
      'roster-main'
    );
    return engine.run(
      [
        {
          _T: 'LogMatchEnd',
          _D: '2026-08-13T00:20:00.000Z',
          characters: [{ character: { accountId: 'account.miaeq', name: 'MiaeQ_Q' } }],
          allWeaponStats: [
            {
              accountId: 'account.miaeq',
              stats: weapons.map((weapon) => ({
                weapon, damage: 120, dBNODamage: 0, shots: 3, hits: 2, dBNOHits: 0, holdingTime: 5,
              })),
            },
          ],
        },
      ],
      { id: 'pan-filter-match', createdAt: '2026-08-13T00:00:00Z', gameMode: 'squad' },
      [],
      [],
      { name: 'KangHeeSung_', damageDealt: 0, kills: 0 },
      [],
      {}
    );
  };

  it('판처파우스트는 아군 무기 통계에 남고 프라이팬은 계속 제외한다', () => {
    const result = runWithTeammateWeapons(['Item_Weapon_PanzerFaust100M1_C', 'Item_Weapon_Pan_C']);
    const weapons = (result.squadWeaponStats?.MiaeQ_Q || []).map((w: { weapon: string }) => w.weapon);

    expect(weapons).toContain('PanzerFaust100M1');
    expect(weapons).not.toContain('Pan');
  });
});
