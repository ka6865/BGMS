import { describe, expect, it } from "vitest";
import {
  TELEMETRY_EVENT_ALLOWLIST,
  filterTelemetryEvents,
  projectTelemetryEvent,
} from "@/lib/pubg-analysis/telemetryContract";

describe("telemetry contract", () => {
  it("공식 telemetry event allowlist의 순서를 고정한다", () => {
    expect(TELEMETRY_EVENT_ALLOWLIST).toEqual([
      "LogMatchStart",
      "LogMatchEnd",
      "LogGameStatePeriodic",
      "LogPhaseStart",
      "LogPhaseChange",
      "LogPlayerCreate",
      "LogPlayerPosition",
      "LogParachuteLanding",
      "LogPlayerAttack",
      "LogPlayerTakeDamage",
      "LogPlayerMakeGroggy",
      "LogPlayerMakeDBNO",
      "LogPlayerKill",
      "LogPlayerKillV2",
      "LogPlayerRevive",
      "LogPlayerRecall",
      "LogPlayerRecallShip",
      "LogPlayerRedeploy",
      "LogPlayerRedeployBRStart",
      "LogPlayerUseThrowable",
      "LogWeaponFire",
      "LogPlayerUseHeal",
      "LogThrowableUse",
      "LogProjectileHit",
      "LogItemUse",
      "LogHeal",
      "LogVehicleRide",
      "LogVehicleLeave",
      "LogCarePackageSpawn",
      "LogCarePackageLand",
      "LogExplosiveExplode",
    ]);
  });

  it("official arrays, nested location, scalar, alias, and throwable weapon을 보존한다", () => {
    const input = {
      _T: "LogPlayerKillV2",
      _D: "2026-08-27T00:00:01.000Z",
      assists_AccountId: ["account.a", "account.a", "account.b"],
      teamKillers_AccountId: ["account.t"],
      attacker: { accountId: "account.a", loc: { x: 1, y: 2 } },
      itemPackage: { location: { x: 3, y: 4, z: 5 }, itemPackageId: "package-1" },
      weapon: { itemId: "Item_Throwable" },
      damage: 42,
    };

    const projected = projectTelemetryEvent(input);

    expect(projected).toMatchObject({
      _T: "LogPlayerKillV2",
      assists_AccountId: ["account.a", "account.b"],
      assistantAccountIds: ["account.a", "account.b"],
      teamKillers_AccountId: ["account.t"],
      teamKillerAccountIds: ["account.t"],
      attacker: { location: { x: 1, y: 2, z: 0 } },
      itemPackage: { location: { x: 3, y: 4, z: 5 } },
      location: { x: 3, y: 4, z: 5 },
      weapon: { itemId: "Item_Throwable" },
      damage: 42,
    });
    expect(input.attacker).toEqual({ accountId: "account.a", loc: { x: 1, y: 2 } });
  });

  it("입력 순서를 유지하고 lite는 비팀 위치만 한 번 1/10 샘플링한다", () => {
    const positions = Array.from({ length: 20 }, (_, index) => ({
      _T: "LogPlayerPosition",
      _D: "2026-08-27T00:00:00.000Z",
      character: {
        accountId: "enemy-" + index,
        name: "Enemy" + index,
        location: { x: index, y: 0 },
      },
    }));
    const context = {
      mode: "lite" as const,
      teamNames: new Set<string>(),
      teamAccountIds: new Set<string>(),
    };

    expect(filterTelemetryEvents(positions, context)).toHaveLength(2);
    expect(filterTelemetryEvents(positions, { ...context, mode: "full" })).toHaveLength(20);
    expect(filterTelemetryEvents([
      { _T: "LogMatchEnd" },
      { _T: "LogMatchStart" },
    ], { ...context, mode: "full" }).map((event) => event._T)).toEqual([
      "LogMatchEnd",
      "LogMatchStart",
    ]);
  });

  it("unknown event와 unconsumed LogWeaponFireCount를 보존하지 않는다", () => {
    expect(projectTelemetryEvent({ _T: "LogWeaponFireCount" })).toBeNull();
    expect(projectTelemetryEvent({ _T: "LogFutureEvent" })).toBeNull();
    expect(projectTelemetryEvent({ _T: "LogWeaponFire" })).not.toBeNull();
    expect(projectTelemetryEvent({ _T: "LogExplosiveExplode" })).not.toBeNull();
  });

  it("redeploy/match-end characters와 recalledPlayers의 wrapper/direct actor를 정규화한다", () => {
    const redeploy = projectTelemetryEvent({
      _T: "LogPlayerRedeployBRStart",
      characters: [
        {
          character: {
            name: "Wrapped",
            accountId: "account.wrapped",
            location: { x: 1, y: 2 },
          },
          reason: "bluezone",
        },
        {
          name: "Direct",
          playerId: "player.direct",
          loc: { x: 3, y: 4, z: 5 },
        },
      ],
    });
    expect(redeploy?.characters).toEqual([
      {
        character: {
          name: "Wrapped",
          accountId: "account.wrapped",
          location: { x: 1, y: 2, z: 0 },
        },
        reason: "bluezone",
      },
      {
        name: "Direct",
        playerId: "player.direct",
        location: { x: 3, y: 4, z: 5 },
      },
    ]);

    const matchEnd = projectTelemetryEvent({
      _T: "LogMatchEnd",
      characters: [{ characterName: "Ended", loc: { x: 6, y: 7 } }],
    });
    expect(matchEnd?.characters).toEqual([
      { characterName: "Ended", location: { x: 6, y: 7, z: 0 } },
    ]);

    const matchStart = projectTelemetryEvent({
      _T: "LogMatchStart",
      characters: [{ name: "Do not persist", location: { x: 8, y: 9 } }],
    });
    expect(matchStart).not.toHaveProperty("characters");

    const recall = projectTelemetryEvent({
      _T: "LogPlayerRecall",
      recalledPlayers: [
        {
          character: { name: "RecallWrapped", loc: { x: 10, y: 11 } },
          reason: "bluechip",
        },
        { name: "RecallDirect", location: { x: 12, y: 13, z: 14 } },
      ],
    });
    expect(recall?.recalledPlayers).toEqual([
      {
        character: { name: "RecallWrapped", location: { x: 10, y: 11, z: 0 } },
        reason: "bluechip",
      },
      { name: "RecallDirect", location: { x: 12, y: 13, z: 14 } },
    ]);
  });

  it("actor location은 location을 우선하고 유효하지 않은 좌표는 생략한다", () => {
    const projected = projectTelemetryEvent({
      _T: "LogPlayerTakeDamage",
      attacker: {
        location: { x: 1, y: 2 },
        loc: { x: 101, y: 102, z: 103 },
      },
      victim: {
        location: { x: "invalid", y: 4 },
        loc: { x: 201, y: 202 },
      },
      maker: { location: { x: 3 }, loc: { y: 4 } },
    });

    expect(projected).toMatchObject({
      attacker: { location: { x: 1, y: 2, z: 0 } },
      victim: {},
    });
    expect(projected?.victim).not.toHaveProperty("location");
    expect(projected?.maker).not.toHaveProperty("location");
  });

  it("itemPackage의 ID/location alias만 보존하고 items 전체는 제외한다", () => {
    const projected = projectTelemetryEvent({
      _T: "LogCarePackageLand",
      location: { x: 900, y: 901, z: 902 },
      itemPackage: {
        itemPackageId: "package-42",
        location: { x: 40, y: 41 },
        items: [{ itemId: "Item_Secret", stackCount: 99 }],
      },
    });

    expect(projected).toMatchObject({
      itemPackage: {
        itemPackageId: "package-42",
        location: { x: 40, y: 41, z: 0 },
      },
      location: { x: 40, y: 41, z: 0 },
    });
    expect(projected?.itemPackage).not.toHaveProperty("items");
  });

  it("공식 account 배열이 alias보다 우선하고 두 배열을 순서 보존 dedupe한다", () => {
    const aliasOnly = projectTelemetryEvent({
      _T: "LogPlayerKillV2",
      assistantAccountIds: ["alias.a", "alias.a", "alias.b"],
      teamKillerAccountIds: ["alias.t", "alias.t"],
    });
    expect(aliasOnly).toMatchObject({
      assists_AccountId: ["alias.a", "alias.b"],
      assistantAccountIds: ["alias.a", "alias.b"],
      teamKillers_AccountId: ["alias.t"],
      teamKillerAccountIds: ["alias.t"],
    });

    const officialWins = projectTelemetryEvent({
      _T: "LogPlayerKillV2",
      assists_AccountId: ["official.a", "official.a", "official.b"],
      assistantAccountIds: ["legacy.should.not.win"],
      teamKillers_AccountId: ["official.t", "official.t"],
      teamKillerAccountIds: ["legacy.team.should.not.win"],
    });
    expect(officialWins).toMatchObject({
      assists_AccountId: ["official.a", "official.b"],
      assistantAccountIds: ["official.a", "official.b"],
      teamKillers_AccountId: ["official.t"],
      teamKillerAccountIds: ["official.t"],
    });
  });

  it("lite는 팀 account/name 위치를 모두 보존하고 enemy ordinal을 호출별로 재시작한다", () => {
    const enemies = Array.from({ length: 20 }, (_, index) => ({
      _T: "LogPlayerPosition",
      character: index === 0
        ? { location: { x: index, y: index } }
        : {
          accountId: `enemy-${index}`,
          name: `Enemy${index}`,
          location: { x: index, y: index },
        },
    }));
    const events = [
      {
        _T: "LogPlayerPosition",
        character: { accountId: "account.team", location: { x: 100, y: 100 } },
      },
      {
        _T: "LogPlayerPosition",
        character: { name: "  TeAm MaTe  ", location: { x: 101, y: 101 } },
      },
      ...enemies,
    ];
    const context = {
      mode: "lite" as const,
      teamNames: new Set(["team mate", ""]),
      teamAccountIds: new Set(["account.team", ""]),
    };

    const first = filterTelemetryEvents(events, context);
    const second = filterTelemetryEvents(events, context);
    const names = (filtered: typeof first) => filtered.map((event) => {
      const actor = event.character as Record<string, unknown> | undefined;
      return actor?.accountId ?? actor?.name ?? actor?.location;
    });

    expect(names(first)).toEqual([
      "account.team",
      "  TeAm MaTe  ",
      "enemy-9",
      "enemy-19",
    ]);
    expect(second).toEqual(first);
    expect(first).toHaveLength(4);
  });

  it("common/Common과 actor/item/vehicle/scalar를 깊이 복사해 입력을 mutate하지 않는다", () => {
    const input = {
      _T: "LogPlayerAttack",
      _D: "2026-08-27T00:00:01.000Z",
      common: { isGame: true },
      Common: { IsGame: false },
      attacker: {
        name: "Player",
        accountId: "account.player",
        teamId: 1,
        location: { x: 1, y: 2, z: 3 },
        viewDir: { x: 1, y: 0, z: 0 },
        heldItems: [{ itemId: "Item_Rifle", attachedItems: [{ itemId: "Item_Scope" }] }],
        vehicle: { vehicleId: "vehicle.inner", velocity: { x: 10, y: 11, z: 12 } },
      },
      item: {
        itemId: "Item_Rifle",
        name: "Rifle",
        stackCount: 2,
        category: "Weapon",
        subCategory: "Rifle",
        attachedItems: [{ itemId: "Item_Scope" }],
      },
      vehicle: {
        vehicleId: "vehicle.top",
        vehicleType: "Car",
        vehicleUniqueId: "unique-1",
        healthPercent: 0.8,
        velocity: { x: 20, y: 21, z: 22 },
        seatIndex: 1,
        isWheelsInAir: false,
        isInWaterVolume: false,
        isEngineOn: true,
      },
      attackId: "attack-1",
      fireWeaponStackCount: 3,
      attackType: "Weapon",
      dBNOId: "dbno-1",
      damage: 42,
      damageReason: "Body",
      damageTypeCategory: "Damage_Gun",
      damageCauserName: "Item_Rifle",
      distance: 100,
      phase: 3,
      elapsedTime: 12.5,
      isThroughPenetrableWall: true,
      isAttackerInVehicle: true,
      isSuicide: false,
      reviveType: "none",
      weaponId: "Item_Rifle",
      victimWeapon: "Item_Pistol",
      victimWeaponAdditionalInfo: { ammo: 5 },
      killerDamageInfo: { damage: 10 },
      finishDamageInfo: { damage: 20 },
      dBNODamageInfo: { damage: 30 },
      isGame: true,
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const projected = projectTelemetryEvent(input);

    expect(projected).toMatchObject({
      common: { isGame: true },
      Common: { IsGame: false },
      attacker: {
        name: "Player",
        accountId: "account.player",
        location: { x: 1, y: 2, z: 3 },
        viewDir: { x: 1, y: 0, z: 0 },
        heldItems: [{ itemId: "Item_Rifle", attachedItems: [{ itemId: "Item_Scope" }] }],
        vehicle: { vehicleId: "vehicle.inner", velocity: { x: 10, y: 11, z: 12 } },
      },
      item: { itemId: "Item_Rifle", attachedItems: [{ itemId: "Item_Scope" }] },
      vehicle: { vehicleId: "vehicle.top", velocity: { x: 20, y: 21, z: 22 } },
      attackId: "attack-1",
      fireWeaponStackCount: 3,
      attackType: "Weapon",
      dBNOId: "dbno-1",
      damage: 42,
      distance: 100,
      phase: 3,
      elapsedTime: 12.5,
      isThroughPenetrableWall: true,
      isAttackerInVehicle: true,
      isSuicide: false,
      weaponId: "Item_Rifle",
      victimWeaponAdditionalInfo: { ammo: 5 },
      killerDamageInfo: { damage: 10 },
    });

    const mutable = projected as Record<string, any>;
    mutable.common.isGame = false;
    mutable.attacker.location.x = 999;
    mutable.attacker.viewDir.x = 999;
    mutable.attacker.heldItems[0].attachedItems[0].itemId = "changed";
    mutable.item.attachedItems[0].itemId = "changed";
    mutable.vehicle.velocity.x = 999;
    mutable.killerDamageInfo.damage = 999;
    expect(input).toEqual(snapshot);
  });
});
