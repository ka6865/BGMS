import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "../lib/pubg-analysis/AnalysisEngine";
import { calculateWeaponBurstStats } from "../lib/pubg-analysis/weaponMetaBurst";

describe("weapon meta burst aggregation", () => {
  it("counts one sustained burst, not one burst for every later hit", () => {
    const events = [0, 1100, 1450].map((offset) => ({
      _T: "LogPlayerTakeDamage",
      _D: new Date(1_000_000 + offset).toISOString(),
      attacker: { accountId: "account.me" },
      victim: { accountId: "account.enemy" },
      damageCauserName: "Item_Weapon_M249_C",
      damage: 10,
    }));

    const stats = calculateWeaponBurstStats(events, "account.me").get("M249");

    expect(stats?.firstSecHits).toBe(1);
    expect(stats?.sustainedHits).toBe(2);
    expect(stats?.sustainedBurstCount).toBe(1);
  });

  it("stores filtered live PvP burst facts on the analyzed weapon", () => {
    const start = 2_000_000;
    const telemetry = [0, 1100, 1450].map((offset) => ({
      _T: "LogPlayerTakeDamage",
      _D: new Date(start + offset).toISOString(),
      attacker: { accountId: "account.me", name: "Me" },
      victim: { accountId: "account.enemy", name: "Enemy" },
      damageCauserName: "Item_Weapon_M249_C",
      damage: 10,
    }));
    telemetry.unshift({ _T: "LogMatchStart", _D: new Date(start).toISOString() } as any);
    const engine = new AnalysisEngine(
      "Me",
      "account.me",
      new Set(["me"]),
      new Set(["account.me"]),
      new Set(),
      new Set(),
      "roster.me",
    );

    const result = engine.run(telemetry, { id: "burst-match", createdAt: new Date(start).toISOString(), gameMode: "squad" }, [], [], { damageDealt: 30 }, [], {});

    expect(result.weaponStats.M249).toMatchObject({
      firstSecHits: 1,
      sustainedHits: 2,
      sustainedBurstCount: 1,
    });
  });
});
