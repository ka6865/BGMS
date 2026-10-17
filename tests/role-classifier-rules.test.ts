import { describe, expect, it } from "vitest";
import { classifyRole } from "@/lib/pubg-analysis/roleClassifier";

// ai-summary route의 aggregateMatches 결과 형식을 따른다(측정 불가 값은 "측정 불가" 문자열 또는 null).
// 기본 입력은 모든 역할 점수를 최소로 둔다:
// 선봉대 5(근접 거리 미측정 기본점), 저격 유령 10(근접 아님 보정), 나머지 0
const BASE = {
  mLen: 1,
  modeDistribution: { main: "squad" },
  avgReactionLatency: "측정 불가",
  avgMinDistStr: "측정 불가",
  avgIsolationStr: "측정 불가",
  userInitiativeRate: null,
  totalRidingShotKnocks: 0,
  totalRidingShotKills: 0,
  totalLeadShotKnocks: 0,
  totalLeadShotKills: 0,
  totalMaxHitDist: null,
  avgDuelWinRate: null,
  totalReversalWins: 0,
  totalTeamWipes: 0,
  totalTeammateKnocks: 0,
  totalSmokeRescues: 0,
  totalSmokeCount: 0,
  totalRevCount: 0,
  totalTradeKills: 0,
  totalEdgePlay: 0,
  totalBluezoneWaste: 100,
  avgPressureIndex: null,
  avgDeathPhase: null,
  goldenTimeAvg: { early: 0, mid1: 0, mid2: 0, late: 0 },
  totalBaitCount: 0,
  totalSuppCount: 0,
  weaponStatsFinal: {},
  weaponMatchCount: {},
};

const classify = (overrides: Record<string, unknown> = {}, tier = "B") => classifyRole({ ...BASE, ...overrides }, {}, tier);
const scoresOf = (overrides: Record<string, unknown> = {}) => classify(overrides).scores;

describe("role classifier base fixture", () => {
  it("starts from the minimum role scores", () => {
    expect(scoresOf()).toEqual({
      pointMan: 5,
      phantomOverwatch: 10,
      executor: 0,
      shield: 0,
      zoneController: 0,
      dropPredator: 0,
      decoy: 0,
      fieldCommander: 0,
    });
  });
});

describe("point man score", () => {
  it("adds half of the initiative rate", () => {
    expect(scoresOf({ userInitiativeRate: 40 }).pointMan).toBe(5 + 20);
  });

  it.each([
    ["0.5s", 30],
    ["0.25s", 35],
    ["2.0s", 0],
    ["2.5s", 0],
    ["측정 불가", 0],
    ["N/A", 0],
    [null, 0],
    ["fast", 0],
  ])("reaction latency %s adds %s", (avgReactionLatency, points) => {
    expect(scoresOf({ avgReactionLatency }).pointMan).toBe(5 + points);
  });

  it.each([
    ["14.9m", 10 + 15],
    ["15.0m", 5 + 15],
    ["19.9m", 5 + 15],
    ["20.0m", 5],
    ["측정 불가", 5],
  ])("closest distance %s gives %s distance points", (avgMinDistStr, points) => {
    expect(scoresOf({ avgMinDistStr }).pointMan).toBe(points);
  });

  it("adds 8 per riding-shot knock", () => {
    expect(scoresOf({ totalRidingShotKnocks: 2 }).pointMan).toBe(5 + 16);
  });
});

describe("phantom overwatch score", () => {
  it.each([
    [250, 25],
    [400, 40],
    [800, 40],
  ])("max hit distance %s adds %s up to 40", (totalMaxHitDist, points) => {
    expect(scoresOf({ totalMaxHitDist }).phantomOverwatch).toBe(10 + points);
  });

  it("adds 30% of the initiative rate", () => {
    expect(scoresOf({ userInitiativeRate: 40 }).phantomOverwatch).toBe(10 + 12);
  });

  it.each([
    ["2.0", 20],
    ["3.0", 30],
    ["4.5", 30],
    ["측정 불가", 0],
  ])("isolation %s adds %s up to 30", (avgIsolationStr, points) => {
    expect(scoresOf({ avgIsolationStr }).phantomOverwatch).toBe(10 + points);
  });

  it("swaps the +10 long-range bonus for -10 at close range and never goes negative", () => {
    expect(scoresOf({ avgMinDistStr: "19.9m" }).phantomOverwatch).toBe(0);
    expect(scoresOf({ avgMinDistStr: "19.9m", totalMaxHitDist: 300 }).phantomOverwatch).toBe(20);
  });

  it("adds 8 per lead-shot knock", () => {
    expect(scoresOf({ totalLeadShotKnocks: 1 }).phantomOverwatch).toBe(10 + 8);
  });
});

describe("executor score", () => {
  it("adds 70% of the duel win rate", () => {
    expect(scoresOf({ avgDuelWinRate: 50 }).executor).toBe(35);
  });

  it("scores reversal wins per match up to 30", () => {
    expect(scoresOf({ mLen: 2, totalReversalWins: 2 }).executor).toBe(15);
    expect(scoresOf({ mLen: 2, totalReversalWins: 6 }).executor).toBe(30);
  });

  it("scores team wipes per match up to 20", () => {
    expect(scoresOf({ mLen: 2, totalTeamWipes: 2 }).executor).toBe(15);
    expect(scoresOf({ mLen: 2, totalTeamWipes: 4 }).executor).toBe(20);
  });

  it("adds 5 per riding-shot kill", () => {
    expect(scoresOf({ totalRidingShotKills: 1 }).executor).toBe(5);
  });

  it("treats a missing match count as one match", () => {
    expect(scoresOf({ mLen: 0, totalTeamWipes: 1 }).executor).toBe(15);
  });
});

describe("shield score", () => {
  it("uses at least three knocks per match as the denominator", () => {
    expect(scoresOf({ totalTeammateKnocks: 1, totalRevCount: 1 }).shield).toBeCloseTo(50 / 3, 10);
    expect(scoresOf({ mLen: 2, totalTeammateKnocks: 4, totalRevCount: 3 }).shield).toBe(25);
    expect(scoresOf({ totalTeammateKnocks: 10, totalRevCount: 2, totalTradeKills: 3 }).shield).toBe(25);
  });

  it("caps rescue rate at 50", () => {
    expect(scoresOf({ totalTeammateKnocks: 4, totalRevCount: 4, totalTradeKills: 4 }).shield).toBe(50);
  });

  it("weights successful smoke rescues over smoke attempts and caps them at 50", () => {
    expect(scoresOf({ totalTeammateKnocks: 10, totalSmokeRescues: 5 }).shield).toBe(20);
    expect(scoresOf({ totalTeammateKnocks: 10, totalSmokeCount: 10 }).shield).toBe(10);
    expect(scoresOf({ totalTeammateKnocks: 10, totalSmokeRescues: 20 }).shield).toBe(50);
  });

  it("is zero in solo mode", () => {
    expect(scoresOf({ modeDistribution: { main: "solo" }, totalTeammateKnocks: 3, totalRevCount: 3 }).shield).toBe(0);
  });
});

describe("zone controller score", () => {
  it("scores edge play per match up to 35", () => {
    expect(scoresOf({ totalEdgePlay: 2 }).zoneController).toBe(16);
    expect(scoresOf({ totalEdgePlay: 5 }).zoneController).toBe(35);
    expect(scoresOf({ mLen: 2, totalEdgePlay: 4, totalBluezoneWaste: 200 }).zoneController).toBe(16);
  });

  it("rewards low blue-zone damage per match up to 10", () => {
    expect(scoresOf({ totalBluezoneWaste: 0 }).zoneController).toBe(10);
    expect(scoresOf({ totalBluezoneWaste: 50 }).zoneController).toBe(5);
    expect(scoresOf({ totalBluezoneWaste: 300 }).zoneController).toBe(0);
    expect(scoresOf({ mLen: 2, totalBluezoneWaste: 100 }).zoneController).toBe(5);
  });

  it("scores pressure up to 40, death phase up to 15 and lead-shot kills", () => {
    expect(scoresOf({ avgPressureIndex: 3 }).zoneController).toBe(24);
    expect(scoresOf({ avgPressureIndex: 6 }).zoneController).toBe(40);
    expect(scoresOf({ avgDeathPhase: 4.5 }).zoneController).toBe(7.5);
    expect(scoresOf({ avgDeathPhase: 9 }).zoneController).toBe(15);
    expect(scoresOf({ totalLeadShotKills: 1 }).zoneController).toBe(5);
  });
});

describe("drop predator score", () => {
  it("scales the early golden-time share by 1.5 up to 100", () => {
    expect(scoresOf({ goldenTimeAvg: { early: 50, mid1: 50, mid2: 0, late: 0 } }).dropPredator).toBe(75);
    expect(scoresOf({ goldenTimeAvg: { early: 20, mid1: 30, mid2: 30, late: 20 } }).dropPredator).toBe(30);
    expect(scoresOf({ goldenTimeAvg: { early: 10, mid1: 0, mid2: 0, late: 0 } }).dropPredator).toBe(100);
    expect(scoresOf({ goldenTimeAvg: undefined }).dropPredator).toBe(0);
  });
});

describe("decoy score", () => {
  it("scores bait per match up to 70 and suppression per match up to 30", () => {
    expect(scoresOf({ mLen: 2, totalBaitCount: 2 }).decoy).toBe(35);
    expect(scoresOf({ mLen: 2, totalBaitCount: 6 }).decoy).toBe(70);
    expect(scoresOf({ mLen: 2, totalSuppCount: 6 }).decoy).toBe(18);
    expect(scoresOf({ mLen: 2, totalSuppCount: 20 }).decoy).toBe(30);
  });
});

describe("field commander and role selection", () => {
  // 선봉대 30, 저격 유령 30, 처형자 35, 방패 30, 통제자 35를 만든다
  const fiveActive = {
    userInitiativeRate: 50,
    totalMaxHitDist: 50,
    avgDuelWinRate: 50,
    totalTeammateKnocks: 3,
    totalRevCount: 1,
    totalTradeKills: 0.8,
    totalEdgePlay: 5,
  };

  it("averages the other seven roles when at least five reach 30", () => {
    const scores = scoresOf(fiveActive);
    expect(scores.pointMan).toBe(30);
    expect(scores.phantomOverwatch).toBe(30);
    expect(scores.executor).toBe(35);
    expect(scores.shield).toBe(30);
    expect(scores.zoneController).toBe(35);
    expect(scores.fieldCommander).toBeCloseTo((30 + 30 + 35 + 30 + 35) / 7, 10);
  });

  it("stays zero when only four roles reach 30", () => {
    expect(scoresOf({ ...fiveActive, totalEdgePlay: 0 }).fieldCommander).toBe(0);
    expect(scoresOf({ ...fiveActive, userInitiativeRate: 49.8 }).fieldCommander).toBe(0);
  });

  it("picks the highest score as the primary role", () => {
    const result = classify({ avgDuelWinRate: 50 });
    expect(result.primaryRole).toBe("executor");
    expect(result.roleLabel).toBe("처형자 (Executor)");
    expect(result.description).toContain("1:1 무력");
  });

  it("adds a secondary role only at 65% of the primary score", () => {
    // 처형자 20 / 저격 유령 13 = 65%
    expect(classify({ avgDuelWinRate: 20 / 0.7, totalLeadShotKnocks: 3 / 8 }).secondaryRole).toBe("phantomOverwatch");
    expect(classify({ avgDuelWinRate: 20 / 0.7, totalLeadShotKnocks: 2.9 / 8 }).secondaryRole).toBeNull();
  });
});

describe("signature weapon", () => {
  const weaponOf = (weaponStatsFinal: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    classify({ weaponStatsFinal, ...extra });

  it("falls back to fists without weapon stats and to tactician when every weapon is ignored", () => {
    expect(weaponOf({}).signatureWeapon).toBe("주먹");
    expect(weaponOf({}).signatureWeaponStats).toEqual({ kills: 0, dbnos: 0, consistency: 0, isReliable: false });
    const ignored = weaponOf({ WeapSmokeBomb_C: { kills: 5 }, None: { kills: 9 } });
    expect(ignored.signatureWeapon).toBe("전술가");
    expect(ignored.signatureWeaponStats).toEqual({ kills: 0, dbnos: 0, consistency: 0, isReliable: false });
    // 대체 이름은 특수 무기 칭호로 쓰지 않는다
    expect(classify({ avgDuelWinRate: 50, weaponStatsFinal: { None: { kills: 9 } } }).title).toBe("성장하는 역전의 귀재");
  });

  it("orders three weapons by kills x2 plus knocks", () => {
    const result = weaponOf({
      WeapAKM_C: { kills: 1, dbnos: 4 },
      WeapM416_C: { kills: 3, dbnos: 1 },
      WeapK2_C: { kills: 2, dbnos: 2 },
    });
    expect(result.signatureWeapon).toBe("M416");
    expect(weaponOf({ WeapAKM_C: { dbnos: 7 }, WeapM416_C: { kills: 3 } }).signatureWeapon).toBe("AKM");
  });

  it("defaults missing kill and knock counts to zero", () => {
    expect(weaponOf({ WeapM416_C: { kills: 1 } }).signatureWeaponStats).toMatchObject({ kills: 1, dbnos: 0 });
    expect(weaponOf({ WeapM416_C: { dbnos: 1 } }).signatureWeaponStats).toMatchObject({ kills: 0, dbnos: 1 });
  });

  it("ranks weapons by kills x2 plus knocks and maps the display name", () => {
    const result = weaponOf({ WeapAKM_C: { kills: 2, dbnos: 3 }, WeapM416_C: { kills: 4, dbnos: 0 } });
    expect(result.signatureWeapon).toBe("M416");
    expect(result.signatureWeaponStats).toMatchObject({ kills: 4, dbnos: 0 });
    expect(weaponOf({ WeapAKM_C: { kills: 2, dbnos: 5 }, WeapM416_C: { kills: 4, dbnos: 0 } }).signatureWeapon).toBe("AKM");
  });

  it("strips the item prefix for unmapped weapons", () => {
    expect(weaponOf({ Item_Weapon_Newgun_C: { kills: 1 } }).signatureWeapon).toBe("Newgun");
  });

  it.each([
    ["BP_Custom_C"], ["SomeVehicle"], ["Uaz_A_01_C"], ["Dacia_A_01_v2_C"], ["Coupe_RB"], ["Mirado_A"],
    ["Pony_Coupe"], ["Porter_C"], ["Zima_C"], ["BRDM_C"], ["Motorcycle_C"], ["Motorbike_C"], ["PickupTruck_A_01_C"],
    ["다시아"], ["uaz"], ["쿠페 RB"], ["오토바이"], ["지마"], ["포터"], ["포니 쿠페"], ["미라도"], ["툭툭"], ["로니"],
    ["픽업트럭"], ["brdm"], ["보급 트럭"], ["아쿠아레일"], ["보트"], ["차량"],
  ])("labels vehicle kills by %s as roadkill hunter", (id) => {
    expect(weaponOf({ [id]: { kills: 1 } }).signatureWeapon).toBe("고라니 사냥꾼");
  });

  it.each([
    ["ProjX_C"], ["Grenade_Shell"], ["Molotov_Fire"], ["custom_grenade"], ["custom_molotov"], ["WeapC4_C"],
    ["custom_smokebomb"], ["custom_flashbang"],
  ])("labels throwable kills by %s as demolition expert", (id) => {
    expect(weaponOf({ [id]: { kills: 1 } }).signatureWeapon).toBe("폭파 전문가");
  });

  it("labels unknown weapon kills as the dark assassin", () => {
    expect(weaponOf({ Unknown: { kills: 1 } }).signatureWeapon).toBe("어둠의 암살자");
  });

  it("measures consistency from used matches and requires score 6 and 50% for reliability", () => {
    const stats = (kills: number, dbnos: number, used: number | undefined, mLen: number) =>
      weaponOf({ WeapM416_C: { kills, dbnos } }, { mLen, weaponMatchCount: used === undefined ? {} : { WeapM416_C: used } }).signatureWeaponStats;
    expect(stats(3, 0, 5, 10)).toEqual({ kills: 3, dbnos: 0, consistency: 50, isReliable: true });
    expect(stats(2, 1, 5, 10)).toMatchObject({ isReliable: false });
    expect(stats(2, 2, 5, 10)).toMatchObject({ isReliable: true });
    expect(stats(0, 6, 5, 10)).toMatchObject({ isReliable: true });
    expect(stats(3, 0, 4, 10)).toEqual({ kills: 3, dbnos: 0, consistency: 40, isReliable: false });
    expect(stats(3, 0, undefined, 4)).toMatchObject({ consistency: 25 });
  });
});

describe("title", () => {
  it("uses the tier prefix and tier-indexed role title", () => {
    expect(classify({ avgDuelWinRate: 50 }, "S").title).toBe("전설의 심판자");
    expect(classify({ avgDuelWinRate: 50 }, "A").title).toBe("숙련된 결투의 제왕");
    expect(classify({ avgDuelWinRate: 50 }, "B").title).toBe("성장하는 역전의 귀재");
    expect(classify({ avgDuelWinRate: 50 }, "C").title).toBe("잠재된 역전의 귀재");
  });

  it("maps detailed 13-step tiers to their base tier", () => {
    for (const tier of ["S+", "S"]) expect(classify({ avgDuelWinRate: 50 }, tier).title).toBe("전설의 심판자");
    for (const tier of ["A+", "A", "A-"]) expect(classify({ avgDuelWinRate: 50 }, tier).title).toBe("숙련된 결투의 제왕");
    for (const tier of ["B+", "B", "B-"]) expect(classify({ avgDuelWinRate: 50 }, tier).title).toBe("성장하는 역전의 귀재");
    for (const tier of ["C+", "C-", "D+", "D-"]) expect(classify({ avgDuelWinRate: 50 }, tier).title).toBe("잠재된 역전의 귀재");
    expect(classify({ avgDuelWinRate: 50 }, "S+").overallTier).toBe("S+");
  });

  it("uses a combo title for a known primary and secondary pair", () => {
    // 통제자 35 > 처형자 35 * 0.65 이상
    const result = classify({ totalEdgePlay: 5, avgDuelWinRate: 40 }, "A");
    expect(result.primaryRole).toBe("zoneController");
    expect(result.secondaryRole).toBe("executor");
    expect(result.title).toBe("숙련된 전장의 사신");
  });

  it.each([
    [{ vehicleCombatMatchCount: 5 }, "성장하는 차량 전술 교전 마스터"],
    [{ totalRidingShotKnocks: 1, totalRidingShotKills: 1, totalLeadShotKills: 1 }, "성장하는 아스팔트의 지배자"],
    [{ totalRidingShotKnocks: 1, totalRidingShotKills: 1 }, "성장하는 도로 위의 저승사자"],
    [{ totalLeadShotKnocks: 1, totalLeadShotKills: 1 }, "성장하는 고속도로 저격수"],
  ])("prefers vehicle combat titles %o", (vehicle, title) => {
    expect(classify(vehicle).title).toBe(title);
  });

  it("uses a special weapon name or a reliable signature weapon in the title", () => {
    expect(classify({ avgDuelWinRate: 50, weaponStatsFinal: { Unknown: { kills: 1 } } }).title).toBe("어둠의 암살자, 역전의 귀재");
    expect(classify({ avgDuelWinRate: 50, weaponStatsFinal: { Uaz_A_01_C: { kills: 1 } } }).title).toBe("고라니 사냥꾼, 역전의 귀재");
    expect(classify({ avgDuelWinRate: 50, weaponStatsFinal: { ProjGrenade_C: { kills: 1 } } }).title).toBe("폭파 전문가, 역전의 귀재");
    expect(classify({ avgDuelWinRate: 50, weaponStatsFinal: { WeapM416_C: { kills: 3 } }, weaponMatchCount: { WeapM416_C: 1 } }).title)
      .toBe("성장하는 역전의 귀재 (M416)");
    expect(classify({ avgDuelWinRate: 50, weaponStatsFinal: { WeapM416_C: { kills: 2 } }, weaponMatchCount: { WeapM416_C: 1 } }).title)
      .toBe("성장하는 역전의 귀재");
  });
});

describe("role text", () => {
  // 각 역할이 단독 1순위가 되는 입력(2순위는 65% 미만)
  const primaryInputs: Array<[string, Record<string, unknown>]> = [
    ["pointMan", { userInitiativeRate: 100, avgMinDistStr: "10m" }],
    ["phantomOverwatch", { totalMaxHitDist: 400 }],
    ["executor", { avgDuelWinRate: 50 }],
    ["shield", { totalTeammateKnocks: 3, totalRevCount: 3 }],
    ["zoneController", { totalEdgePlay: 5 }],
    ["dropPredator", { goldenTimeAvg: { early: 10, mid1: 0, mid2: 0, late: 0 } }],
    ["decoy", { totalBaitCount: 2 }],
  ];
  const expected: Record<string, { label: string; titles: [string, string, string]; description: string }> = {
    pointMan: { label: "선봉대 (Point Man)", titles: ["총구의 시계추", "첫 총성의 화신", "돌격의 화신"], description: "첫 총성" },
    phantomOverwatch: { label: "저격 유령 (Phantom Overwatch)", titles: ["전장의 망령", "침묵의 감시자", "보이지 않는 손"], description: "외곽" },
    executor: { label: "처형자 (Executor)", titles: ["심판자", "결투의 제왕", "역전의 귀재"], description: "1:1 무력" },
    shield: { label: "팀의 방패 (Shield)", titles: ["전우의 수호신", "마지막 방패", "연막의 천사"], description: "연막" },
    zoneController: { label: "전장 통제자 (Zone Controller)", titles: ["구역의 지배자", "자기장의 주인", "압박의 화신"], description: "자기장 경계선" },
    dropPredator: { label: "핫드랍 약탈자 (Drop Predator)", titles: ["착지의 악마", "핫존의 포식자", "혼돈의 사냥꾼"], description: "핫드랍" },
    decoy: { label: "미끼 전술가 (Decoy)", titles: ["고의적 피탄자", "희생의 전략가", "미끼의 달인"], description: "미끼" },
  };

  it.each(primaryInputs)("%s has its label, description and tier titles", (role, input) => {
    const { label, titles, description } = expected[role];
    const s = classify(input, "S");
    expect(s.primaryRole).toBe(role);
    expect(s.secondaryRole).toBeNull();
    expect(s.roleLabel).toBe(label);
    expect(s.description).toContain(description);
    expect(s.title).toBe(`전설의 ${titles[0]}`);
    expect(classify(input, "A").title).toBe(`숙련된 ${titles[1]}`);
    expect(classify(input, "C").title).toBe(`잠재된 ${titles[2]}`);
  });

  it("keeps every role description distinct", () => {
    const descriptions = primaryInputs.map(([, input]) => classify(input).description);
    expect(new Set(descriptions).size).toBe(primaryInputs.length);
  });

  it.each([
    [{ totalEdgePlay: 5, userInitiativeRate: 40 }, "zoneController", "pointMan", "돌격하는 지배자"],
    [{ avgDuelWinRate: 50, userInitiativeRate: 40 }, "executor", "pointMan", "선봉의 심판자"],
    [{ totalTeammateKnocks: 3, totalRevCount: 3, totalBaitCount: 1 }, "shield", "decoy", "고의적 수호신"],
    [{ totalMaxHitDist: 400, avgDuelWinRate: 50 }, "phantomOverwatch", "executor", "그림자 처형자"],
    [{ goldenTimeAvg: { early: 10, mid1: 0, mid2: 0, late: 0 }, userInitiativeRate: 90, avgMinDistStr: "10m" }, "dropPredator", "pointMan", "착지의 선봉대"],
  ] as const)("combo %#: %s + %s", (input, primary, secondary, combo) => {
    const result = classify(input as Record<string, unknown>, "A");
    expect(result.primaryRole).toBe(primary);
    expect(result.secondaryRole).toBe(secondary);
    expect(result.title).toBe(`숙련된 ${combo}`);
  });
});

describe("weakness", () => {
  it("flags a zone controller below 45% duel win rate", () => {
    expect(classify({ totalEdgePlay: 5, avgDuelWinRate: 44 }).weakness).toContain("1:1 교전 결정력");
    expect(classify({ totalEdgePlay: 5, avgDuelWinRate: 45 }).weakness).toBeNull();
  });

  it("flags an executor whose revive rate is below 30% of teammate knocks", () => {
    const executor = { avgDuelWinRate: 90 };
    expect(classify({ ...executor, totalTeammateKnocks: 10, totalRevCount: 2 }).weakness).toContain("팀원 케어");
    expect(classify({ ...executor, totalTeammateKnocks: 10, totalRevCount: 3 }).weakness).toBeNull();
    expect(classify({ ...executor, totalTeammateKnocks: 0 }).weakness).toBeNull();
  });

  it("flags a drop predator dying before phase 4", () => {
    const drop = { goldenTimeAvg: { early: 10, mid1: 0, mid2: 0, late: 0 } };
    expect(classify({ ...drop, avgDeathPhase: 3.9 }).weakness).toContain("생존 단계");
    expect(classify({ ...drop, avgDeathPhase: 4 }).weakness).toBeNull();
  });

  it("flags a shield below 200 average damage", () => {
    const shield = { totalTeammateKnocks: 3, totalRevCount: 3 };
    expect(classify({ ...shield, avgDamage: 199 }).weakness).toContain("화력");
    expect(classify({ ...shield, avgDamage: 200 }).weakness).toBeNull();
  });

  it("flags a point man whose isolation is above 2.0", () => {
    const pointMan = { userInitiativeRate: 100, avgMinDistStr: "10m" };
    expect(classify({ ...pointMan, avgIsolationStr: "2.1" }).weakness).toContain("고립");
    expect(classify({ ...pointMan, avgIsolationStr: "2.0" }).weakness).toBeNull();
  });

  it("flags a phantom whose trade rate is below 20% of teammate knocks", () => {
    const phantom = { totalMaxHitDist: 400 };
    expect(classify({ ...phantom, totalTeammateKnocks: 10, totalTradeKills: 1 }).weakness).toContain("백업 속도");
    expect(classify({ ...phantom, totalTeammateKnocks: 10, totalTradeKills: 2 }).weakness).toBeNull();
  });

  it("has no weakness rule for decoy", () => {
    expect(classify({ mLen: 1, totalBaitCount: 2 }).weakness).toBeNull();
  });
});
