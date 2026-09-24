import { describe, expect, it } from "vitest";
import { buildDailyCombatStory } from "@/lib/learn/dailyCombatStory";

describe("buildDailyCombatStory", () => {
  it("keeps weapon pickup, confirmed fire, teams and loot source separate", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const player = (accountId: string, name: string, teamId: number, x: number) => ({
      accountId, name, teamId, location: { x, y: 100000 }, isInVehicle: false,
    });
    const ranker = player("ranker", "Ranker", 1, 100000);
    const ally = player("ally", "Ally", 1, 100500);
    const enemy = player("enemy", "Enemy", 2, 101000);
    const events = [
      { _T: "LogParachuteLanding", _D: at(60), character: ranker },
      { _T: "LogParachuteLanding", _D: at(61), character: enemy },
      { _T: "LogItemPickup", _D: at(75), character: ranker, item: { category: "Weapon", itemId: "Item_Weapon_UMP_C" } },
      { _T: "LogItemPickup", _D: at(80), character: ranker, item: { category: "Weapon", itemId: "Item_Weapon_HK416_C" } },
      { _T: "LogPlayerTakeDamage", _D: at(90), attacker: enemy, victim: ally, damage: 20, damageCauserName: "WeapVSS_C" },
      { _T: "LogPlayerAttack", _D: at(95), attacker: ranker, weapon: { itemId: "Item_Weapon_HK416_C" } },
      { _T: "LogPlayerMakeGroggy", _D: at(100), attacker: ranker, victim: enemy, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerKillV2", _D: at(105), killer: ranker, victim: enemy, killerDamageInfo: { damageCauserName: "WeapHK416_C" } },
      { _T: "LogItemPickupFromLootBox", _D: at(110), character: ally,
        creatorAccountId: "enemy", item: { category: "Weapon", itemId: "Item_Weapon_MG3_C" } },
      { _T: "LogItemPickupFromCarepackage", _D: at(115), character: ranker,
        item: { category: "Weapon", itemId: "Item_Weapon_Groza_C" } },
    ];
    const { encounters, weaponFinds } = buildDailyCombatStory(events, origin, "ranker",
      new Set(["ranker", "ally"]), new Map([["enemy", "Enemy"]]));
    expect(encounters).toHaveLength(1);
    expect(encounters[0]).toMatchObject({ opponents: ["Enemy"], allies: ["Ally", "Ranker"],
      teamKills: 1, rankerWeapons: ["M416"], firstRankerShot: { timeSeconds: 95, weapon: "M416" } });
    expect(encounters[0].actions[0]).toMatchObject({ kind: "first_hit", actor: "Enemy",
      victim: "Ally", distanceMeters: 5 });
    expect(weaponFinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: "Ranker", weapon: "UMP45", source: "ground" }),
      expect.objectContaining({ player: "Ally", weapon: "MG3", source: "lootbox", owner: "Enemy" }),
      expect.objectContaining({ player: "Ranker", weapon: "그로자", source: "carepackage" }),
    ]));
  });
});
