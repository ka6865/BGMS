import { describe, expect, it } from "vitest";
import { buildDailyCombatStory, dailyWeaponName } from "@/lib/learn/dailyCombatStory";
import regression from "./fixtures/learn/daily-regressions.json";

describe("buildDailyCombatStory", () => {
  it("retains the first recorded hit in each direction and each actor-target pair with vehicle state", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const ally = { accountId: "ally", name: "Ally", teamId: 1, isInVehicle: true };
    const enemy = { accountId: "enemy", name: "Enemy", teamId: 2, isInVehicle: false };
    const secondEnemy = { accountId: "enemy-2", name: "Enemy 2", teamId: 2, isInVehicle: true };
    const events = [
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: ally, victim: enemy, damage: 20, damageCauserName: "WeapMutant_C" },
      { _T: "LogPlayerTakeDamage", _D: at(101), attacker: ally, victim: enemy, damage: 15, damageCauserName: "WeapMutant_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(100.5), attacker: ally, victim: enemy, damageCauserName: "WeapMutant_C" },
      { _T: "LogPlayerTakeDamage", _D: at(102), attacker: enemy, victim: ally, damage: 20, damageCauserName: "WeapACE32_C" },
      { _T: "LogPlayerTakeDamage", _D: at(103), attacker: secondEnemy, victim: ally, damage: 20, damageCauserName: "WeapAUG_C" },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ally", new Set(["ally"]), new Map());
    expect(encounters[0].actions.filter(({ kind }) => kind === "first_hit")).toEqual([
      expect.objectContaining({ actor: "Ally", victim: "Enemy", timeSeconds: 100, actorInVehicle: true, victimInVehicle: false }),
      expect.objectContaining({ actor: "Enemy", victim: "Ally", timeSeconds: 102, actorInVehicle: false, victimInVehicle: true }),
      expect.objectContaining({ actor: "Enemy 2", victim: "Ally", timeSeconds: 103, actorInVehicle: true, victimInVehicle: true }),
    ]);
    expect(encounters[0].actions.filter(({ kind }) => kind === "first_hit").map(({ sourceIndices }) => sourceIndices))
      .toEqual([[0], [3], [4]]);
    expect(encounters[0].actions.map(({ timeSeconds }) => timeSeconds)).toEqual([100, 100.5, 102, 103]);
  });

  it("preserves regression timing, event distinctions, teams and source indices", () => {
    const origin = Date.parse("2026-09-23T08:05:55.497Z");
    const events = regression.events.map((event) => ({ ...event }));
    const sourceIndex = (originalIndex: number) => regression.originalSourceIndices.indexOf(originalIndex);
    const { encounters } = buildDailyCombatStory(events, origin, "ranker", new Set(["ranker", "ally"]),
      new Map([["ranker", "Ranker"], ["ally", "Ally"]]));
    const actions = encounters.flatMap((encounter) => encounter.actions);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "first_hit", sourceIndices: [sourceIndex(3565)], actorTeamId: 2, victimTeamId: 11, weapon: "VSS" }),
      expect.objectContaining({ kind: "knock", sourceIndices: [sourceIndex(7110)], timeSeconds: 178.829, weapon: "UMP45" }),
      expect.objectContaining({ kind: "kill", sourceIndices: [sourceIndex(7614)], timeSeconds: 192.217, weapon: "M416" }),
      expect.objectContaining({ kind: "first_hit", sourceIndices: [sourceIndex(25878)], actorTeamId: 4, victimTeamId: 11, weapon: "MG3" }),
    ]));
    expect(actions.find((action) => action.sourceIndices?.[0] === sourceIndex(7110))?.kind).toBe("knock");
    expect(actions.find((action) => action.sourceIndices?.[0] === sourceIndex(7614))?.kind).toBe("kill");
  });
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

  it("keeps opponent-team identity, re-engagement and overlapping cards explicit", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const player = (accountId: string, name: string, teamId: number, x: number) => ({
      accountId, name, teamId, location: { x, y: 100000 }, isInVehicle: false,
    });
    const ranker = player("ranker", "Ranker", 1, 100000);
    const ally = player("ally", "Ally", 1, 100500);
    const opponent15a = player("enemy-15a", "Enemy 15A", 15, 102000);
    const opponent15b = player("enemy-15b", "Enemy 15B", 15, 102500);
    const opponent7 = player("enemy-7", "Enemy 7", 7, 103000);
    const events = [
      { _T: "LogPlayerMakeGroggy", _D: at(100), attacker: ranker, victim: opponent15a, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(185), attacker: ally, victim: opponent15b, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(170), attacker: ranker, victim: opponent7, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(205), attacker: ally, victim: opponent7, damageCauserName: "WeapHK416_C" },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ranker",
      new Set(["ranker", "ally", "other-ally"]), new Map([
        ["ranker", "Ranker"], ["ally", "Ally"], ["other-ally", "Other Ally"],
      ]));

    expect(encounters).toHaveLength(3);
    const first15 = encounters.find((encounter) => encounter.startSeconds === 100)!;
    const second15 = encounters.find((encounter) => encounter.startSeconds === 185)!;
    const team7 = encounters.find((encounter) => encounter.startSeconds === 170)!;
    expect(first15.opponentIdentity).toMatchObject({ key: "team-15", teamId: 15, playerIds: ["enemy-15a", "enemy-15b"] });
    expect(second15.opponentIdentity).toMatchObject({ key: "team-15", teamId: 15, playerIds: ["enemy-15a", "enemy-15b"] });
    expect(second15.reengagement).toEqual({ isReengagement: true, previousEncounterId: first15.id, gapSeconds: 85 });
    expect(first15.reengagement?.isReengagement).toBe(false);
    expect(team7.overlapsWith).toEqual([second15.id]);
    expect(second15.overlapsWith).toEqual([team7.id]);
    expect(second15.involvedAllies).toEqual(["Ally"]);
    expect(second15.allies).toEqual(["Ally"]);
    expect(second15.rosterAllies).toEqual(["Ranker", "Ally", "Other Ally"]);
  });

  it("builds sparse ally-versus-opponent position snapshots around first damage and marks missing observations", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const player = (accountId: string, name: string, teamId: number, x: number) => ({
      accountId, name, teamId, location: { x, y: 100000 }, isInVehicle: false,
    });
    const ranker = player("ranker", "Ranker", 1, 100000);
    const ally = player("ally", "Ally", 1, 101000);
    const enemy = player("enemy", "Enemy", 2, 105000);
    const unobservedEnemy = player("enemy-2", "Enemy 2", 2, 106000);
    const position = (second: number, character: ReturnType<typeof player>) => ({
      _T: "LogPlayerPosition", _D: at(second), character,
    });
    const events = [
      ...[ranker, ally, enemy].flatMap((person, index) => [
        position(70, { ...person, location: { x: person.location.x + index * 100, y: 100000 + index * 100 } }),
        position(100, { ...person, location: { x: person.location.x + index * 200, y: 100000 + index * 200 } }),
        position(130, { ...person, location: { x: person.location.x + index * 300, y: 100000 + index * 300 } }),
      ]),
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: enemy, victim: ally, damage: 20, damageCauserName: "WeapVSS_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(105), attacker: ranker, victim: enemy, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(110), attacker: ally, victim: unobservedEnemy, damageCauserName: "WeapHK416_C" },
    ];

    const { encounters } = buildDailyCombatStory(events, origin, "ranker",
      new Set(["ranker", "ally", "bench"]), new Map([ ["ranker", "Ranker"], ["ally", "Ally"], ["bench", "Bench"] ]));
    expect(encounters).toHaveLength(1);
    expect(encounters[0].snapshots).toHaveLength(3);
    expect(encounters[0].snapshots?.map((snapshot) => snapshot.targetTimeSeconds)).toEqual([70, 100, 130]);
    expect(encounters[0].snapshots?.[0].points.map(({ player, side }) => [player, side]).sort(([a], [b]) => String(a).localeCompare(String(b)))).toEqual([
      ["Ally", "ally"], ["Enemy", "opponent"], ["Ranker", "ally"],
    ]);
    expect(encounters[0].snapshots?.[1].points).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: "Enemy", side: "opponent", sampleTimeSeconds: 100, ageSeconds: 0 }),
    ]));
    expect(encounters[0].snapshots?.[1].missingPlayers).toEqual(expect.arrayContaining(["Enemy 2", "Bench"]));
  });

  it("keeps only nearby observed samples and omits positions farther than 15 seconds", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const ranker = { accountId: "ranker", name: "Ranker", teamId: 1, location: { x: 100000, y: 100000 } };
    const enemy = { accountId: "enemy", name: "Enemy", teamId: 2, location: { x: 105000, y: 100000 } };
    const events = [
      { _T: "LogPlayerPosition", _D: at(90), character: enemy },
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: enemy, victim: ranker, damage: 20, damageCauserName: "WeapVSS_C" },
      { _T: "LogPlayerMakeGroggy", _D: at(100), attacker: ranker, victim: enemy, damageCauserName: "WeapHK416_C" },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ranker", new Set(["ranker"]), new Map());
    expect(encounters[0].snapshots?.[1].points).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: "Enemy", sampleTimeSeconds: 90, ageSeconds: 10 }),
    ]));
    expect(encounters[0].snapshots?.[2].missingPlayers).toEqual(["Ranker", "Enemy"]);
    expect(encounters[0].snapshots?.[2].deadPlayerIds).toEqual([]);
  });

  it("includes the full opponent team, leaves unobserved and already-dead members unlocated", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const player = (accountId: string, name: string, teamId: number, x = 100000) => ({
      accountId, name, teamId, location: { x, y: 100000 },
    });
    const ranker = player("ranker", "Ranker", 1);
    const observed = player("enemy-a", "Enemy A", 2, 110000);
    const unobserved = player("enemy-b", "Enemy B", 2, 120000);
    const deadBefore = player("enemy-c", "Enemy C", 2, 130000);
    const events = [
      { _T: "LogPlayerPosition", _D: at(100), character: ranker },
      { _T: "LogPlayerPosition", _D: at(100), character: observed },
      { _T: "LogPlayerPosition", _D: at(140), character: unobserved },
      { _T: "LogPlayerPosition", _D: at(95), character: deadBefore },
      { _T: "LogPlayerKillV2", _D: at(85), killer: player("other", "Other", 3), victim: deadBefore },
      { _T: "LogPlayerKillV2", _D: at(100), killer: ranker, victim: unobserved },
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: observed, victim: ranker, damage: 20, damageCauserName: "WeapVSS_C" },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ranker", new Set(["ranker"]), new Map());
    const encounter = encounters[0];
    expect(encounter.opponents).toEqual(["Enemy A", "Enemy B", "Enemy C"]);
    expect(encounter.opponentIdentity?.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "enemy-a", name: "Enemy A" }),
      expect.objectContaining({ id: "enemy-b", name: "Enemy B", deathTimeSeconds: 100 }),
      expect.objectContaining({ id: "enemy-c", name: "Enemy C", deathTimeSeconds: 85 }),
    ]));
    expect(encounter.snapshots?.[1].points).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "enemy-a", directlyInvolved: true }),
    ]));
    expect(encounter.snapshots?.[1].missingPlayers).toEqual(expect.arrayContaining(["Enemy B", "Enemy C"]));
    expect(encounter.snapshots?.[1].deadPlayerIds).toEqual(expect.arrayContaining(["enemy-b", "enemy-c"]));
    expect(encounter.snapshots?.[2].points.some(({ playerId }) => playerId === "enemy-b" || playerId === "enemy-c")).toBe(false);
  });

  it("tracks death, return-to-alive evidence, and a later death at each snapshot time", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const ranker = { accountId: "ranker", name: "Ranker", teamId: 1 };
    const enemy = { accountId: "enemy", name: "Enemy", teamId: 2, location: { x: 105000, y: 100000 } };
    const events = [
      { _T: "LogPlayerMakeGroggy", _D: at(50), attacker: ranker, victim: enemy, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerKillV2", _D: at(60), killer: { accountId: "other", name: "Other", teamId: 3 }, victim: enemy },
      { _T: "LogPlayerPosition", _D: at(70), character: { ...enemy, health: 0 } },
      { _T: "LogPlayerCreate", _D: at(85), character: enemy },
      { _T: "LogPlayerPosition", _D: at(99), character: { ...enemy, health: 100 } },
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: enemy, victim: ranker, damage: 20, damageCauserName: "WeapThompson_C" },
      { _T: "LogPlayerKillV2", _D: at(130), killer: ranker, victim: enemy },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ranker", new Set(["ranker"]), new Map());
    const encounter = encounters[0];
    expect(encounter.opponentIdentity?.players).toEqual([
      expect.objectContaining({ id: "enemy", name: "Enemy", deathTimeSeconds: 130, deathKillerTeamId: 1 }),
    ]);
    expect(encounter.actions.find(({ kind }) => kind === "first_hit")?.weapon).toBe("토미건");
    expect(encounter.snapshots?.map(({ deadPlayerIds }) => deadPlayerIds)).toEqual([["enemy"], [], ["enemy"]]);
    expect(encounter.snapshots?.[1].points).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "enemy", sampleTimeSeconds: 99, sourceIndices: [4] }),
    ]));
    expect(encounter.snapshots?.[0].missingPlayers).toContain("Enemy");
    expect(encounter.snapshots?.[2].missingPlayers).toContain("Enemy");
  });

  it("does not clear confirmed death from kill or damage attribution without health proof", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const ranker = { accountId: "ranker", name: "Ranker", teamId: 1 };
    const enemy = { accountId: "enemy", name: "Enemy", teamId: 2, location: { x: 105000, y: 100000 } };
    const events = [
      { _T: "LogPlayerKillV2", _D: at(60), killer: { accountId: "other", name: "Other", teamId: 3 }, victim: enemy },
      { _T: "LogPlayerKillV2", _D: at(70), killer: enemy, victim: { accountId: "third", name: "Third", teamId: 3 } },
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: enemy, victim: ranker, damage: 20 },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ranker", new Set(["ranker"]), new Map());
    expect(encounters[0].snapshots?.map(({ deadPlayerIds, missingPlayers }) => [deadPlayerIds, missingPlayers.includes("Enemy")]))
      .toEqual([[ ["enemy"], true], [["enemy"], true], [["enemy"], true]]);
    expect(encounters[0].opponentIdentity?.players?.[0]).toMatchObject({ deathTimeSeconds: 60 });
  });

  it("reuses the existing Tommy Gun alias for Thompson telemetry IDs", () => {
    expect(dailyWeaponName("WeapThompson_C")).toBe("토미건");
    expect(dailyWeaponName("Item_Weapon_Thompson_C")).toBe("토미건");
  });

  it("preserves confirmed weapon changes across the whole encounter interval", () => {
    const origin = Date.parse("2026-09-23T00:00:00Z");
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const ranker = { accountId: "ranker", name: "Ranker", teamId: 1 };
    const enemy = { accountId: "enemy", name: "Enemy", teamId: 2 };
    const events = [
      { _T: "LogPlayerTakeDamage", _D: at(100), attacker: enemy, victim: ranker, damage: 20, damageCauserName: "WeapVSS_C" },
      { _T: "LogPlayerAttack", _D: at(101), attacker: ranker, weapon: { itemId: "Item_Weapon_HK416_C" } },
      { _T: "LogPlayerAttack", _D: at(102), attacker: ranker, weapon: { itemId: "Item_Weapon_HK416_C" } },
      { _T: "LogPlayerMakeGroggy", _D: at(160), attacker: ranker, victim: enemy, damageCauserName: "WeapHK416_C" },
      { _T: "LogPlayerAttack", _D: at(159), attacker: ranker, weapon: { itemId: "Item_Weapon_BerylM762_C" } },
      { _T: "LogPlayerKillV2", _D: at(200), killer: ranker, victim: enemy, killerDamageInfo: { damageCauserName: "WeapBerylM762_C" } },
    ];
    const { encounters } = buildDailyCombatStory(events, origin, "ranker", new Set(["ranker"]), new Map());
    expect(encounters).toHaveLength(1);
    expect(encounters[0].rankerWeapons).toEqual(["M416", "베릴 M762"]);
    expect(encounters[0].firstRankerShot).toMatchObject({ timeSeconds: 101, weapon: "M416",
      sourceIndices: [1], actorId: "ranker", actorTeamId: 1 });
  });
});
