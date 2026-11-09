import { describe, expect, it } from 'vitest';
import { buildMayhemPatchNotes, valueLabel } from '@/lib/lol/augments/patchNotes';

const texts = [
  { platform_id: 1, client_patch: '16.21', name: '거인의 결의', display_text: '10중첩마다' },
  { platform_id: 1, client_patch: '16.22', name: '거인의 결의', display_text: '7중첩마다' },
  { platform_id: 2, client_patch: '16.21', name: '구원', display_text: '같음' },
  { platform_id: 2, client_patch: '16.22', name: '구원', display_text: '같음' },
  { platform_id: 3, client_patch: '16.22', name: 'RISE', display_text: '신규 효과' },
  { platform_id: 4, client_patch: '16.21', name: '흡혈병', display_text: '사라짐' },
];
const states = texts.map(t => ({ platform_id: t.platform_id, client_patch: t.client_patch, rarity: 'gold' as const }));
const changes = [
  { client_patch: '16.22', platform_id: 1, change_type: 'changed', summary_ko: '거인의 결의: values' },
  { client_patch: '16.22', platform_id: 2, change_type: 'changed', summary_ko: '구원: values' },
  { client_patch: '16.22', platform_id: 3, change_type: 'added', summary_ko: 'RISE: 신규' },
  { client_patch: '16.22', platform_id: 4, change_type: 'unannounced_absent', summary_ko: '흡혈병: 목록에서 제외' },
  { client_patch: '16.21', platform_id: null, change_type: 'removed', summary_ko: '공식 노트 삭제 목록: 도박꾼' },
  { client_patch: '16.23', platform_id: 3, change_type: 'changed', summary_ko: 'RISE: values' },
];
const notes = [{ client_patch: '16.21', url: 'https://example.test/26-21', published_at: '2026-10-20T18:00:00Z', removed_names: ['도박꾼'] }];

describe('증바람 패치노트', () => {
  it('공개 패치까지만 최신순으로 신규·변경·삭제를 나누고 설명 전후는 실제로 달라진 경우만 담는다', () => {
    const r = buildMayhemPatchNotes({ changes, notes, texts, states, upTo: '16.22' });
    expect(r.map(n => n.displayPatch)).toEqual(['26.22', '26.21']);
    expect(r[0].added).toEqual([expect.objectContaining({ name: 'RISE', lines: [{ before: null, after: '신규 효과' }] })]);
    expect(r[0].changed).toEqual([
      expect.objectContaining({ name: '거인의 결의', fields: ['수치'], lines: [{ before: '10중첩마다', after: '7중첩마다' }] }),
      expect.objectContaining({ name: '구원', lines: [] }),
    ]);
    expect(r[0].removed).toEqual([expect.objectContaining({ name: '흡혈병', rarity: 'gold' })]);
    expect(r[1]).toMatchObject({ notesUrl: 'https://example.test/26-21', removed: [expect.objectContaining({ name: '도박꾼', platformId: null })] });
  });

  it('스냅샷이 있으면 숫자를 채운 툴팁으로 비교하고 해시 이름만 풀린 변경은 뺀다', () => {
    const augment = (id: number, tooltip: string, dataValues: { name: string; values: number[] }[], calcKey = 'Calc') => ({ platformId: id, nameId: `n${id}`, rarity: 'gold' as const, isInternal: false,
      ko: { name: `증강${id}`, description: null, tooltip }, en: { name: `A${id}`, description: null, tooltip: null }, icons: { small: null, large: null }, enabled: true, quest: false, ability: false,
      buildTags: 0, augmentTags: 0, rarityEvidence: { cherry: 'gold' as const, bin: null }, rootSpell: { path: 'p', dataValues, calculations: { [calcKey]: { __type: 'GameCalculation', mFormulaParts: [{ __type: 'NamedDataValueCalculationPart', mDataValue: 'Shield' }] } } } });
    const tooltip = '보호막을 @Calc@ 얻습니다. 쏘인 적: @f1@';
    const snapshots = {
      '16.21': [augment(1, tooltip, [{ name: 'Shield', values: [50] }]), augment(2, tooltip, [{ name: 'Shield', values: [10] }], '{bcf192d4}'), augment(5, '설명', [{ name: 'Hidden', values: [10] }])],
      '16.22': [augment(1, tooltip, [{ name: 'Shield', values: [100] }]), augment(2, tooltip, [{ name: 'Shield', values: [10] }]), augment(5, '설명', [{ name: 'Hidden', values: [12] }])],
    };
    const rows = [1, 2, 5].map(id => ({ client_patch: '16.22', platform_id: id, change_type: 'changed', summary_ko: `증강${id}: values` }));
    const t = [1, 2, 5].flatMap(id => ['16.21', '16.22'].map(p => ({ platform_id: id, client_patch: p, name: `증강${id}`, display_text: '같음' })));
    const [note] = buildMayhemPatchNotes({ changes: rows, notes: [], texts: t, states: [], upTo: '16.22', snapshots });
    expect(note.changed.map(e => e.name)).toEqual(['증강1', '증강5']);
    expect(note.changed[0].lines).toEqual([{ before: '보호막을 50 얻습니다.', after: '보호막을 100 얻습니다.' }]);
    expect(note.changed[1]).toMatchObject({ lines: [], values: [{ name: 'Hidden', label: null, percent: false, before: 10, after: 12 }] });
  });

  it('내부 값 이름은 아는 단어로만 옮기고 비율은 퍼센트로 표시한다', () => {
    expect(valueLabel('UpgradeArmorPenFlat')).toEqual({ label: '업그레이드당 물리 관통력', percent: false });
    expect(valueLabel('UpgradeMagicPenPercent')).toEqual({ label: '업그레이드당 마법 관통력', percent: true });
    expect(valueLabel('QuestRequirement')).toEqual({ label: '퀘스트 목표', percent: false });
    expect(valueLabel('Calc_Mystery')).toEqual({ label: null, percent: false });
  });
});
