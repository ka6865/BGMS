import { describe, it, expect } from "vitest";
import { calculateWeaponBurstStats, categorizeWeapon } from "../lib/pubg-analysis/weaponMetaBurst";

describe("calculateWeaponBurstStats", () => {
  it("categorizes weapons into AR, LMG, DMR, etc.", () => {
    expect(categorizeWeapon("Item_Weapon_M249_C")).toBe("LMG");
    expect(categorizeWeapon("WeapBerylM762_C")).toBe("AR");
    expect(categorizeWeapon("Item_Weapon_HK416_C")).toBe("AR");
    expect(categorizeWeapon("Item_Weapon_DP28_C")).toBe("LMG");
    expect(categorizeWeapon("Item_Weapon_Kar98k_C")).toBe("SR");
    expect(categorizeWeapon("Item_Weapon_S12K_C")).toBe("SG");
    expect(categorizeWeapon("Item_Weapon_Vector_C")).toBe("SMG");
  });

  it("calculates 1.5s gap burst density correctly", () => {
    const events = [
      { _T: "LogPlayerTakeDamage", damageCauserName: "Item_Weapon_M249_C", _D: "2026-08-12T10:00:00.000Z", attacker: { accountId: "acc-1" }, victim: { accountId: "acc-2" }, damage: 20 },
      { _T: "LogPlayerTakeDamage", damageCauserName: "Item_Weapon_M249_C", _D: "2026-08-12T10:00:00.500Z", attacker: { accountId: "acc-1" }, victim: { accountId: "acc-2" }, damage: 20 },
      { _T: "LogPlayerTakeDamage", damageCauserName: "Item_Weapon_M249_C", _D: "2026-08-12T10:00:01.200Z", attacker: { accountId: "acc-1" }, victim: { accountId: "acc-2" }, damage: 20 },
      { _T: "LogPlayerTakeDamage", damageCauserName: "Item_Weapon_M249_C", _D: "2026-08-12T10:00:02.000Z", attacker: { accountId: "acc-1" }, victim: { accountId: "acc-2" }, damage: 20 },
    ];
    const stats = calculateWeaponBurstStats(events, "acc-1");
    expect(stats.get("M249")?.firstSecHits).toBe(2);
    expect(stats.get("M249")?.sustainedHits).toBe(2);
    expect(stats.get("M249")?.category).toBe("LMG");
    expect(stats.get("M249")?.totalDamage).toBe(80);
  });
});
