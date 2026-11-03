import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";

// 내 팀: Me·TB, 적 팀: E1·E2·E3
// 킬 이벤트 모양은 실제 텔레메트리(LogPlayerKillV2)를 따른다: 최상위 damageTypeCategory는 없고
// killerDamageInfo·finishDamageInfo·dBNODamageInfo 안에 피해 종류가 들어 있다.

const baseTime = Date.parse("2026-11-03T10:00:00Z");
const at = (ms: number) => new Date(baseTime + ms).toISOString();

const accountOf = (name: string) => `account.${name.toLowerCase()}`;
const actor = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  accountId: accountOf(name),
  location: { x: 100000, y: 100000, z: 0 },
  ...extra,
});

const ROSTERS: Record<string, string[]> = { "r-me": ["Me", "TB"], "r-e": ["E1", "E2", "E3"] };

function run(events: Array<Record<string, unknown> & { t: number }>) {
  const participants = Object.values(ROSTERS).flat().map(name => ({
    id: `p-${name}`,
    attributes: {
      stats: { name, playerId: accountOf(name), damageDealt: 100, kills: 0, assists: 0, DBNOs: 0, winPlace: 5, timeSurvived: 900 },
      accountId: accountOf(name),
    },
  }));
  const rosters = Object.entries(ROSTERS).map(([id, members]) => ({
    id,
    relationships: { participants: { data: members.map(name => ({ id: `p-${name}` })) } },
  }));
  const engine = new AnalysisEngine(
    "Me",
    "account.me",
    new Set(["me", "tb"]),
    new Set(["account.me", "account.tb"]),
    new Set(),
    new Set(),
    "r-me",
    "lite",
  );
  const telemetry = [
    { _T: "LogMatchStart", _D: at(0) },
    ...events.map(({ t, ...event }) => ({ ...event, _D: at(t) })),
  ];
  const me = participants.find(p => p.attributes.stats.name === "Me")!.attributes.stats;
  const team = participants.filter(p => ["Me", "TB"].includes(p.attributes.stats.name)).map(p => p.attributes.stats);
  return engine.run(
    telemetry,
    { id: "vehicle-kill", createdAt: at(0), gameMode: "squad", mapName: "Neon_Main", matchType: "competitive" },
    rosters, participants, me, team, {},
  );
}

const info = (damageTypeCategory: string, damageCauserName: string) => ({
  damageTypeCategory, damageCauserName, damageReason: "NonSpecific", distance: 0, additionalInfo: [], isThroughPenetrablWall: false,
});
const none = info("Damage_None", "None");
const empty = { damageTypeCategory: "", damageCauserName: "", damageReason: "", distance: 0, additionalInfo: [] };

const kill = (
  t: number,
  victim: string,
  infos: { killer: ReturnType<typeof info> | typeof empty; finish: ReturnType<typeof info>; dbno?: ReturnType<typeof info> },
  killerState: Record<string, unknown> = {},
  victimState: Record<string, unknown> = {},
) => ({
  t,
  _T: "LogPlayerKillV2",
  killer: actor("Me", killerState),
  victim: actor(victim, victimState),
  killerDamageInfo: infos.killer,
  finishDamageInfo: infos.finish,
  dBNODamageInfo: infos.dbno ?? none,
});

const DACIA = "Dacia_A_03_v2_Esports_C";

describe("차량 킬 분류 (LogPlayerKillV2의 피해 정보 기준)", () => {
  it("차로 기절시킨 뒤 출혈로 죽어도 킬을 올린 피해가 차량 충돌이면 로드킬이다", () => {
    const result = run([
      kill(10_000, "E1", {
        killer: info("Damage_VehicleHit", DACIA),
        finish: info("Damage_DBNO", "PlayerFemale_A_C"),
        dbno: info("Damage_VehicleHit", DACIA),
      }, { isInVehicle: true }),
    ]);
    expect(result.roadKills).toBe(1);
    expect(result.ridingShotKills).toBe(0);
    expect(result.leadShotKills).toBe(0);
  });

  it("차량 충돌로 바로 죽인 킬은 로드킬이다", () => {
    const result = run([
      kill(10_000, "E1", { killer: info("Damage_VehicleHit", DACIA), finish: info("Damage_VehicleHit", DACIA) }, { isInVehicle: true }),
    ]);
    expect(result.roadKills).toBe(1);
    expect(result.ridingShotKills).toBe(0);
  });

  it("차에 탄 채 총으로 낸 킬은 라이딩샷이고 로드킬이 아니다", () => {
    const result = run([
      kill(10_000, "E1", { killer: info("Damage_Gun", "WeapM24_C"), finish: info("Damage_Gun", "WeapM24_C") }, { isInVehicle: true }),
    ]);
    expect(result.ridingShotKills).toBe(1);
    expect(result.roadKills).toBe(0);
  });

  it("다른 사람이 차로 기절시키고 내가 총으로 마무리한 킬은 로드킬이 아니다", () => {
    const result = run([
      kill(10_000, "E1", {
        killer: info("Damage_Gun", "WeapM24_C"),
        finish: info("Damage_Gun", "WeapM24_C"),
        dbno: info("Damage_VehicleHit", "BP_PickupTruck_A_03_C"),
      }),
    ]);
    expect(result.roadKills).toBe(0);
    expect(result.ridingShotKills).toBe(0);
  });

  it("차량에 탄 적을 총으로 잡은 킬은 리드샷이다", () => {
    const result = run([
      kill(10_000, "E1", { killer: info("Damage_Gun", "WeapHK416_C"), finish: info("Damage_Gun", "WeapHK416_C") }, {}, { isInVehicle: true }),
    ]);
    expect(result.leadShotKills).toBe(1);
    expect(result.roadKills).toBe(0);
  });

  it("킬을 올린 사람의 피해 정보가 비어 있으면 마지막 피해로 판정한다", () => {
    const result = run([
      kill(10_000, "E1", { killer: empty, finish: info("Damage_VehicleHit", DACIA) }, { isInVehicle: true }),
    ]);
    expect(result.roadKills).toBe(1);
    expect(result.ridingShotKills).toBe(0);
  });

  it("최상위 damageTypeCategory가 있는 이벤트는 그 값을 우선한다", () => {
    const result = run([
      {
        ...kill(10_000, "E1", { killer: info("Damage_Gun", "WeapM24_C"), finish: info("Damage_Gun", "WeapM24_C") }, { isInVehicle: true }),
        damageTypeCategory: "Damage_VehicleHit",
      },
    ]);
    expect(result.roadKills).toBe(1);
  });

  it("기절 이벤트의 차량 충돌은 기존처럼 로드킬 기절로 센다", () => {
    const result = run([
      {
        t: 10_000,
        _T: "LogPlayerMakeGroggy",
        attacker: actor("Me", { isInVehicle: true }),
        victim: actor("E1"),
        damageCauserName: DACIA,
        damageTypeCategory: "Damage_VehicleHit",
      },
    ]);
    expect(result.roadKnocks).toBe(1);
    expect(result.ridingShotKnocks).toBe(0);
  });
});
