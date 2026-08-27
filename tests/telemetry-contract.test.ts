import { describe, expect, it } from "vitest";
import {
  filterTelemetryEvents,
  projectTelemetryEvent,
} from "@/lib/pubg-analysis/telemetryContract";

describe("telemetry contract", () => {
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
});
