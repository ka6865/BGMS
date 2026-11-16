import { describe, expect, it } from 'vitest';
import { getWeaponMasteryCategory, normalizeWeaponMasteryItems } from '@/lib/pubg/weaponMastery';

describe('무기 숙련도 분류', () => {
  it('부분 문자열이 겹치는 무기를 올바르게 분류한다', () => {
    expect(getWeaponMasteryCategory('Item_Weapon_M249_C')).toBe('LMG');
    expect(getWeaponMasteryCategory('Item_Weapon_M24_C')).toBe('SR');
    expect(getWeaponMasteryCategory('Item_Weapon_RPD_C')).toBe('LMG');
    expect(getWeaponMasteryCategory('Item_Weapon_Pan_C')).toBe('근접/특수');
    expect(getWeaponMasteryCategory('Item_Weapon_PanzerFaust100M_C')).toBe('근접/특수');
  });

  it('캐시에 저장된 과거 분류 대신 무기 ID로 다시 분류한다', () => {
    const [item] = normalizeWeaponMasteryItems([{ weaponId: 'Item_Weapon_M249_C', category: 'SR' }]);
    expect(item.category).toBe('LMG');
  });
});
