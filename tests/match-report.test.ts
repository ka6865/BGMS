import { describe, expect, it } from "vitest";
import { MatchReportCollector, type MatchReport } from "@/lib/pubg-analysis/matchReport";
import { buildKillTree, describeDeath, fightReplaySeconds, hasMatchFlow, hasMatchOverview } from "@/lib/pubg-analysis/matchReportView";

const START = Date.parse("2026-10-15T15:00:00.000Z");
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();

type Who = { name: string; teamId: number; accountId?: string; x?: number; y?: number; health?: number; isInVehicle?: boolean };
const actor = (who: Who) => ({
  name: who.name,
  teamId: who.teamId,
  accountId: who.accountId ?? `account.${who.name}`,
  health: who.health ?? 100,
  isInVehicle: who.isInVehicle ?? false,
  location: { x: who.x ?? 0, y: who.y ?? 0, z: 0 },
});

const ME: Who = { name: "Me", teamId: 1 };
const MATE: Who = { name: "Mate", teamId: 1 };
const A1: Who = { name: "EnemyA1", teamId: 2 };
const A2: Who = { name: "EnemyA2", teamId: 2 };
const B1: Who = { name: "EnemyB1", teamId: 3 };

const damage = (s: number, attacker: Who, victim: Who, amount = 30, category = "Damage_Gun") => ({
  _T: "LogPlayerTakeDamage", _D: at(s), attacker: actor(attacker), victim: actor(victim), damage: amount,
  damageTypeCategory: category, damageCauserName: "WeapAK47_C",
});
const groggy = (s: number, attacker: Who, victim: Who) => ({ _T: "LogPlayerMakeGroggy", _D: at(s), attacker: actor(attacker), victim: actor(victim) });
const kill = (s: number, killer: Who | null, victim: Who, category = "Damage_Gun", distance = 2_500) => ({
  _T: "LogPlayerKillV2", _D: at(s), victim: actor(victim), killer: killer ? actor(killer) : null,
  killerDamageInfo: { damageTypeCategory: category, damageCauserName: category === "Damage_Gun" ? "WeapAK47_C" : "None", distance },
  finishDamageInfo: { damageTypeCategory: category, damageCauserName: category === "Damage_Gun" ? "WeapAK47_C" : "None", distance },
});
const position = (s: number, who: Who) => ({ _T: "LogPlayerPosition", _D: at(s), character: actor(who) });

function run(events: Record<string, unknown>[], participants: unknown[] = [], rosters: unknown[] = []): MatchReport {
  const collector = new MatchReportCollector({
    lowerNickname: "me",
    myAccountId: "account.Me",
    teamNames: new Set(["me", "mate"]),
    teamAccountIds: new Set(["account.Me", "account.Mate"]),
  });
  for (const event of [{ _T: "LogMatchStart", _D: at(0) }, ...events]) {
    collector.observe(event, Date.parse(String(event._D)));
  }
  return collector.result(participants, rosters);
}

describe("경기 흐름 판정", () => {
  it("착지 반경 300m·600m 안의 적을 센다", () => {
    const report = run([
      { _T: "LogParachuteLanding", _D: at(60), character: actor({ ...ME, x: 0, y: 0 }) },
      { _T: "LogParachuteLanding", _D: at(61), character: actor({ ...MATE, x: 1_000, y: 0 }) },
      { _T: "LogParachuteLanding", _D: at(62), character: actor({ ...A1, x: 20_000, y: 0 }) },
      { _T: "LogParachuteLanding", _D: at(63), character: actor({ ...A2, x: 50_000, y: 0 }) },
      { _T: "LogParachuteLanding", _D: at(64), character: actor({ ...B1, x: 90_000, y: 0 }) },
    ]);
    expect(report.landing).toEqual({ timeMs: 60_000, enemiesNear: 1, enemiesFar: 2, teamsNear: 1 });
  });

  it("교전을 30초 공백으로 나누고 결과를 판정한다", () => {
    const report = run([
      damage(100, ME, A1), groggy(110, ME, A1), kill(112, ME, A1),
      damage(200, A2, ME), damage(205, ME, A2),
      damage(300, B1, MATE), groggy(305, B1, MATE), damage(306, ME, B1), groggy(310, ME, B1),
      damage(400, B1, ME, 30), groggy(402, B1, ME),
    ]);
    expect(report.fights.map((fight) => [fight.startMs, fight.outcome, fight.openedBy])).toEqual([
      [100_000, "won", "us"],
      [200_000, "brokeOff", "them"],
      [300_000, "traded", "them"],
      [400_000, "lost", "them"],
    ]);
    expect(report.fights[0]).toMatchObject({ opponentTeamIds: [2], dealt: 30, taken: 0, enemyDowns: 1, teamDowns: 0 });
  });

  it("자기장·낙하 피해는 교전으로 묶지 않는다", () => {
    const report = run([
      { ...damage(100, ME, ME, 5, "Damage_BlueZone"), attacker: null },
      damage(150, ME, MATE, 10, "Damage_Gun"),
    ]);
    expect(report.fights).toEqual([]);
    expect(report.heal.damageTaken).toBe(5);
  });

  it("원이 정해질 때 내 위치가 원 밖이면 떨어진 거리를 남긴다", () => {
    const gameState = (s: number, radius: number) => ({
      _T: "LogGameStatePeriodic", _D: at(s), common: { isGame: 2 },
      gameState: { poisonGasWarningPosition: { x: 0, y: 0, z: 0 }, poisonGasWarningRadius: radius },
    });
    const report = run([
      position(90, { ...ME, x: 50_000, y: 0 }),
      gameState(100, 100_000),
      gameState(110, 100_000),
      position(190, { ...ME, x: 80_000, y: 0 }),
      gameState(200, 60_000),
    ]);
    expect(report.circles).toEqual([
      { index: 1, phase: 2, timeMs: 100_000, status: "inside", outsideByM: null },
      { index: 2, phase: 2, timeMs: 200_000, status: "outside", outsideByM: 200 },
    ]);
  });

  it("체력 상승을 회복량으로 더하고 교전 중 치료를 센다", () => {
    const heal = (s: number, health: number) => ({ _T: "LogHeal", _D: at(s), character: actor({ ...ME, health }) });
    const use = (s: number, subCategory: string) => ({ _T: "LogItemUse", _D: at(s), character: actor(ME), item: { itemId: "Item", subCategory } });
    const report = run([
      damage(100, A1, ME, 60), damage(101, ME, A1),
      position(102, { ...ME, health: 40 }),
      use(103, "Heal"), heal(104, 55), heal(105, 75), damage(110, ME, A1),
      use(200, "Boost"), use(201, "Heal"), heal(206, 100),
    ]);
    expect(report.heal).toEqual({ damageTaken: 60, healthRestored: 60, heals: 2, boosts: 1, midFightHeals: 1 });
  });

  it("부활로 생긴 체력은 회복으로 세지 않는다", () => {
    const report = run([
      position(100, { ...ME, health: 0 }),
      { _T: "LogPlayerRevive", _D: at(110), reviver: actor(MATE), victim: actor(ME) },
      position(111, { ...ME, health: 10 }),
    ]);
    expect(report.heal.healthRestored).toBe(0);
  });
});

describe("사망 유형", () => {
  it("최근 1분 안에 두 팀과 싸웠으면 써드파티", () => {
    const report = run([damage(100, A1, ME), damage(101, ME, A1), damage(140, B1, ME), kill(145, B1, ME)]);
    expect(report.death).toMatchObject({ type: "thirdParty", teamsInLastMinute: 2, killer: "EnemyB1", distanceM: 25 });
  });

  it("교전 직전 30초에 150m 넘게 움직였으면 이동 중 잡힘", () => {
    const report = run([
      position(70, { ...ME, x: 0 }), position(80, { ...ME, x: 10_000 }), position(95, { ...ME, x: 20_000 }),
      damage(100, A1, ME), kill(103, A1, ME),
    ]);
    expect(report.death).toMatchObject({ type: "rotating", movedBeforeFightM: 200 });
  });

  it("상대가 먼저 쐈고 거의 반격하지 못했으면 기습", () => {
    const report = run([damage(100, A1, ME, 50), damage(101, ME, A1, 20), kill(102, A1, ME)]);
    expect(report.death).toMatchObject({ type: "ambushed", openedBy: "them" });
  });

  it("가까운 생존 팀원이 100m보다 멀면 고립", () => {
    const report = run([
      position(95, { ...MATE, x: 30_000 }), position(96, { ...ME, x: 0 }),
      damage(100, ME, A1, 150), damage(101, A1, ME), kill(102, A1, ME),
    ]);
    expect(report.death).toMatchObject({ type: "isolated", nearestTeammateM: 300 });
  });

  it("자기장 피해로 죽으면 자기장, 기절 뒤 출혈이면 출혈사", () => {
    expect(run([kill(500, null, ME, "Damage_BlueZone")]).death).toMatchObject({ type: "zone", killer: null });
    const bled = run([damage(100, ME, A1, 150), groggy(101, A1, ME), kill(131, null, ME, "Damage_Groggy")]);
    expect(bled.death).toMatchObject({ type: "bledOut", knockedAtMs: 101_000 });
    expect(describeDeath(bled.death!)).toBe("출혈사 · 30초 기절 후");
  });

  it("부활해서 끝까지 살았으면 사망 기록을 지운다", () => {
    const report = run([kill(100, A1, ME), { _T: "LogPlayerRecall", _D: at(200), recalledPlayer: actor(ME) }]);
    expect(report.death).toBeNull();
  });
});

describe("경기 전체", () => {
  const participants = [
    { id: "p1", attributes: { stats: { name: "Me", playerId: "account.Me", kills: 2, damageDealt: 210.4 } } },
    { id: "p2", attributes: { stats: { name: "Mate", playerId: "account.Mate", kills: 1, damageDealt: 90 } } },
    { id: "p3", attributes: { stats: { name: "Bot_1", playerId: "ai.1", kills: 0, damageDealt: 0 } } },
  ];
  const rosters = [
    { id: "r2", attributes: { stats: { rank: 5, teamId: 9 } }, relationships: { participants: { data: [{ id: "p3" }] } } },
    { id: "r1", attributes: { stats: { rank: 1, teamId: 1 } }, relationships: { participants: { data: [{ id: "p1" }, { id: "p2" }] } } },
  ];

  it("팀 순위와 봇 목록을 참가자 정보로 만든다", () => {
    const report = run([], participants, rosters);
    expect(report.teams.map((team) => [team.rank, team.kills, team.damage, team.isMine])).toEqual([[1, 3, 300, true], [5, 0, 0, false]]);
    expect(report.teams[1].players[0]).toEqual({ name: "Bot_1", kills: 0, damage: 0, isBot: true });
    expect(report.bots).toEqual(["Bot_1"]);
  });

  it("킬 트리는 마지막 생존자부터 처치를 따라 내려간다", () => {
    const report = run([kill(100, A1, B1), kill(200, ME, A1), kill(250, ME, A2), kill(300, null, MATE, "Damage_BlueZone")]);
    const tree = buildKillTree(report.kills);
    expect(tree.map((node) => node.name)).toEqual(["Me", "환경 (자기장·사고)"]);
    expect(tree[0].children.map((node) => node.name)).toEqual(["EnemyA1", "EnemyA2"]);
    expect(tree[0].children[0].children.map((node) => node.name)).toEqual(["EnemyB1"]);
    expect(tree[1].children.map((node) => node.name)).toEqual(["Mate"]);
  });

  it("보급 종류를 패키지 이름으로 나눈다", () => {
    const land = (s: number, id: string) => ({ _T: "LogCarePackageLand", _D: at(s), common: { isGame: 3 }, itemPackage: { itemPackageId: id } });
    const report = run([land(10, "Carapackage_RedBox_C"), land(20, "Carepackage_SmallPackage_NoParachute_Bluechip_C"), land(30, "Carapackage_FlareGun_C")]);
    expect(report.carePackages.map((item) => item.kind)).toEqual(["redBox", "blueChip", "flare"]);
  });

  it("빈 리포트는 섹션을 숨긴다", () => {
    expect(hasMatchFlow(undefined)).toBe(false);
    expect(hasMatchOverview(run([]))).toBe(false);
    expect(hasMatchOverview(run([], participants, rosters))).toBe(true);
    expect(fightReplaySeconds(100_000)).toBe(97);
    expect(fightReplaySeconds(1_000)).toBe(0);
  });
});
