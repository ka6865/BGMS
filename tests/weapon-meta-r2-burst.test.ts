import { describe, expect, it } from "vitest";
import { calculateWeaponBurstStats } from "../lib/pubg-analysis/weaponMetaBurst";

describe("R2 weapon-meta burst extraction", () => {
  it("excludes teammate hits, throwables, and hits after a knock", () => {
    const at = (offset: number, extra: Record<string, unknown> = {}) => ({
      _D: new Date(1_000_000 + offset).toISOString(),
      ...extra,
    });
    const events = [
      at(0, { _T: "LogPlayerTakeDamage", attacker: { accountId: "me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 }, damageCauserName: "Item_Weapon_M249_C", damage: 10 }),
      at(1100, { _T: "LogPlayerTakeDamage", attacker: { accountId: "me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 }, damageCauserName: "Item_Weapon_M249_C", damage: 10 }),
      at(1200, { _T: "LogPlayerTakeDamage", attacker: { accountId: "me", teamId: 1 }, victim: { accountId: "ally", teamId: 1 }, damageCauserName: "Item_Weapon_M249_C", damage: 10 }),
      at(1300, { _T: "LogPlayerTakeDamage", attacker: { accountId: "me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 }, damageCauserName: "ProjGrenade", damage: 10 }),
      at(1400, { _T: "LogPlayerMakeGroggy", attacker: { accountId: "me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 } }),
      at(1450, { _T: "LogPlayerTakeDamage", attacker: { accountId: "me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 }, damageCauserName: "Item_Weapon_M249_C", damage: 10 }),
    ];

    const stat = calculateWeaponBurstStats(events, "me").get("M249");
    expect(stat).toMatchObject({ firstSecHits: 1, sustainedHits: 1, sustainedBurstCount: 1 });
    expect(calculateWeaponBurstStats(events, "me").has("ProjGrenade")).toBe(false);
  });
});
