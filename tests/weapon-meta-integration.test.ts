import { describe, it, expect } from "vitest";
import { calculateWeaponBurstStats, categorizeWeapon } from "../lib/pubg-analysis/weaponMetaBurst";

describe("Weapon Meta Integration Verification", () => {
  it("verifies full pipeline integration readiness with burst density and categorization", () => {
    expect(categorizeWeapon("Item_Weapon_M249_C")).toBe("LMG");
    expect(categorizeWeapon("Item_Weapon_DP28_C")).toBe("LMG");
    expect(categorizeWeapon("Item_Weapon_MG3_C")).toBe("LMG");
    expect(categorizeWeapon("WeapBerylM762_C")).toBe("AR");

    const events = [
      {
        _T: "LogPlayerTakeDamage",
        damageCauserName: "Item_Weapon_M249_C",
        _D: "2026-08-12T10:00:00.000Z",
        attacker: { accountId: "player-1" },
        victim: { accountId: "enemy-1" },
        damage: 35,
      },
      {
        _T: "LogPlayerTakeDamage",
        damageCauserName: "Item_Weapon_M249_C",
        _D: "2026-08-12T10:00:01.200Z",
        attacker: { accountId: "player-1" },
        victim: { accountId: "enemy-1" },
        damage: 40,
      },
    ];

    const result = calculateWeaponBurstStats(events, "player-1");
    expect(result.has("M249")).toBe(true);
    const m249Stat = result.get("M249");
    expect(m249Stat?.category).toBe("LMG");
    expect(m249Stat?.totalDamage).toBe(75);
    expect(m249Stat?.firstSecHits).toBe(1);
    expect(m249Stat?.sustainedHits).toBe(1);
  });
});

 it.each(["BP_Baltic_GasPump_C", "BP_NE_GasPump_C", "BP_Tiger_GasStationB_Gaspump_C", "BP_VK_GasPump_C"])("does not classify environmental %s as UMP", name => {
   expect(categorizeWeapon(name)).toBe("OTHERS");
   expect(categorizeWeapon("WeapUMP_C")).toBe("SMG");
 });


it.each([
  ["WeapM16A4_C", "AR"], ["WeapQBZ95_C", "AR"], ["WeapMk47Mutant_C", "AR"],
  ["WeapM416_C", "AR"], ["WeapAKM_C", "AR"], ["WeapFNFal_C", "DMR"],
  ["WeapWin94_C", "SR"], ["WeapL6_C", "SR"], ["WeapSaiga12_C", "SG"],
  ["WeapBerreta686_C", "SG"], ["WeapWinchester_C", "SG"],
  ["WeapTommyGun_C", "SMG"], ["WeapP90_C", "SMG"], ["WeapMP9_C", "SMG"],
])("classifies known weapon %s as %s", (weapon, category) => {
  expect(categorizeWeapon(weapon)).toBe(category);
});
