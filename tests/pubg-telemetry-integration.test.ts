import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";
import { filterTelemetryEvents } from "@/lib/pubg-analysis/telemetryContract";

const teamNames = new Set(["player"]);
const teamAccountIds = new Set(["account.player"]);

function runFixture(rawEvents: readonly unknown[], mode: "lite" | "full") {
  const engine = new AnalysisEngine(
    "Player",
    "account.player",
    teamNames,
    teamAccountIds,
    new Set(),
    new Set(),
    "roster-1",
    mode,
  );
  return engine.run(
    filterTelemetryEvents(rawEvents, { mode, teamNames, teamAccountIds }),
    {
      id: "match-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      mapName: "Baltic_Main",
      gameMode: "squad",
    },
    [],
    [],
    { name: "Player", playerId: "account.player", damageDealt: 0, kills: 0, timeSurvived: 600 },
    [],
    {},
  );
}

describe("route and handler telemetry boundary", () => {
  it("AnalysisEngine은 matchType 누락을 Official로 합성하지 않는다", () => {
    expect(runFixture([], "full").matchType).toBe("");
  });

  it("두 route가 공용 filter를 사용한다", () => {
    const matchRoute = fs.readFileSync("app/api/pubg/match/route.ts", "utf8");
    const telemetryRoute = fs.readFileSync("app/api/pubg/telemetry/route.ts", "utf8");
    expect(matchRoute).toContain("filterTelemetryEvents");
    expect(telemetryRoute).toContain("filterTelemetryEvents");
    expect(telemetryRoute).toMatch(/new AnalysisEngine\([\s\S]*?teamNames,[\s\S]*?teamAccountIds,/);
    expect(telemetryRoute).toContain("myRoster?.id || \"\"");
    expect(matchRoute).not.toContain("let posCount = 0");
    expect(matchRoute).not.toContain("const keepFields");
  });

  it("lite 적 위치는 두 번째 sampling 없이 2개, full은 20개다", () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      _T: "LogPlayerPosition",
      _D: "2026-08-27T00:00:00.000Z",
      character: {
        accountId: "enemy-" + index,
        name: "Enemy" + index,
        location: { x: index, y: 1 },
      },
    }));
    expect(runFixture(events, "lite").mapData?.events.filter((event: any) => event.type === "position")).toHaveLength(2);
    expect(runFixture(events, "full").mapData?.events.filter((event: any) => event.type === "position")).toHaveLength(20);
  });

  it("redeploy characters, official arrays, nested care package와 vehicle event를 소비한다", () => {
    const result = runFixture([
      {
        _T: "LogPlayerRedeployBRStart",
        _D: "2026-08-27T00:00:01.000Z",
        characters: [{
          character: {
            name: "Player",
            accountId: "account.player",
            location: { x: 1, y: 2 },
          },
        }],
      },
      {
        _T: "LogPlayerKillV2",
        _D: "2026-08-27T00:00:02.000Z",
        killer: {
          name: "Player",
          accountId: "account.player",
          location: { x: 4, y: 5 },
        },
        victim: {
          name: "Enemy",
          accountId: "account.enemy",
          location: { x: 8, y: 9 },
        },
        assists_AccountId: ["account.assist"],
        teamKillers_AccountId: ["account.player"],
      },
      {
        _T: "LogCarePackageLand",
        _D: "2026-08-27T00:00:03.000Z",
        itemPackage: { location: { x: 400, y: 500, z: 10 } },
      },
      {
        _T: "LogVehicleRide",
        _D: "2026-08-27T00:00:04.000Z",
        character: {
          name: "Player",
          accountId: "account.player",
          location: { x: 10, y: 20 },
        },
        vehicle: { vehicleId: "vehicle-1" },
      },
    ], "full");

    expect(result.mapData?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "carepackage_land", x: 4, y: 5 }),
      expect.objectContaining({ type: "ride" }),
      expect.objectContaining({
        type: "kill",
        assistants: [expect.objectContaining({ accountId: "account.assist" })],
      }),
    ]));
  });

  it("recalledPlayers wrapper/direct actor를 recall timeline과 map create로 소비한다", () => {
    const result = runFixture([
      {
        _T: "LogPlayerKillV2",
        _D: "2026-08-27T00:00:01.000Z",
        killer: {
          name: "Enemy",
          accountId: "account.enemy",
          location: { x: 8, y: 9 },
        },
        victim: {
          name: "Player",
          accountId: "account.player",
          location: { x: 1, y: 2 },
        },
      },
      {
        _T: "LogPlayerRecall",
        _D: "2026-08-27T00:00:02.000Z",
        recalledPlayers: [{
          character: {
            name: "Player",
            accountId: "account.player",
            location: { x: 3, y: 4 },
          },
        }],
      },
    ], "full");

    expect(result.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RECALL", victim: "Player" }),
    ]));
    expect(result.mapData?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "create", name: "Player", x: 0.03, y: 0.04 }),
    ]));
  });

  it("enemy team-kill은 우리 팀 판정이나 squad 통계로 승격하지 않고 map 사실만 표시한다", () => {
    const result = runFixture([
      {
        _T: "LogPlayerKillV2",
        _D: "2026-08-27T00:00:01.000Z",
        killer: {
          name: "EnemyA",
          accountId: "account.enemy-a",
          location: { x: 20, y: 30 },
        },
        victim: {
          name: "EnemyB",
          accountId: "account.enemy-b",
          location: { x: 40, y: 50 },
        },
        weaponId: "Item_Weapon_AK47_C",
        teamKillers_AccountId: ["account.enemy-a"],
      },
    ], "full");

    const mapKill = result.mapData?.events.find((event: any) => event.type === "kill");
    expect(mapKill).toEqual(expect.objectContaining({
      isTeamAttacker: false,
      isTeamKill: true,
    }));
    expect(result.timeline).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TEAM_KILL" }),
    ]));
    expect(result.squadWeaponStats).toEqual({});
  });

  it("LogExplosiveExplode의 projected item/id로 smoke와 flash map event를 보존한다", () => {
    const result = runFixture([
      {
        _T: "LogExplosiveExplode",
        _D: "2026-08-27T00:00:01.000Z",
        explosiveItem: { itemId: "Item_SmokeGrenade" },
        explosiveId: "SmokeGrenade",
        location: { x: 100, y: 200 },
      },
      {
        _T: "LogExplosiveExplode",
        _D: "2026-08-27T00:00:02.000Z",
        explosiveItem: { itemId: "Item_FlashBang" },
        explosiveId: "FlashBang",
        location: { x: 300, y: 400 },
      },
    ], "full");

    expect(result.mapData?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "smoke", weapon: "item_smokegrenade", isRealExplosion: true }),
      expect.objectContaining({ type: "flash", weapon: "item_flashbang", isRealExplosion: true }),
    ]));
  });
});
