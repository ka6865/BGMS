import { describe, expect, it } from "vitest";
import { classifyRole, extractRoleMetrics } from "@/lib/pubg-analysis/roleClassifier";
import { referencePercentile, roleScorePercentile } from "@/lib/pubg-analysis/roleReference";

// ai-summary route의 aggregateMatches 결과 형식을 따른다(측정 불가 값은 "측정 불가" 문자열 또는 null).
// 기본 입력은 아무 지표도 판정할 수 없는 상태다.
const BASE = {
  mLen: 1,
  modeDistribution: { main: "squad" },
  avgReactionLatency: "측정 불가",
  avgBackupLatency: "측정 불가",
  userInitiativeRate: null,
  totalInitiativeAttempts: 0,
  avgDuelWinRate: null,
  totalDuelWins: 0,
  totalDuelLosses: 0,
  userReversalRate: null,
  totalReversalAttempts: 0,
  totalDistanceDamage: { short: 0, mid: 0, long: 0 },
  totalMaxHitDist: null,
  totalTeammateKnocks: 0,
  totalRevCount: 0,
  totalSmokeRescues: 0,
  totalTradeKills: 0,
  avgPressureIndex: null,
  avgPlacementPct: null,
  totalEdgePlay: null,
  goldenTimeAvg: { early: 0, mid1: 0, mid2: 0, late: 0 },
  totalBaitCount: null,
  totalSuppCount: null,
  totalUtilityHits: null,
  totalLethalThrows: null,
  avgTeamDamageShare: null,
  totalFocusFireCount: null,
  killContribFinal: { solo: 0, cleanup: 0, assist: 0 },
  totalRidingShotKnocks: 0,
  totalRidingShotKills: 0,
  totalLeadShotKnocks: 0,
  totalLeadShotKills: 0,
  vehicleCombatMatchCount: 0,
  weaponStatsFinal: {},
  weaponMatchCount: {},
};

const classify = (overrides: Record<string, unknown> = {}, tier = "B") => classifyRole({ ...BASE, ...overrides }, {}, tier);

// 기준 분포 95백분위를 넘는 값(백분위 97.5).
const STRONG_EXECUTOR = { avgDuelWinRate: 95, totalDuelWins: 19, totalDuelLosses: 1, userReversalRate: 50, totalReversalAttempts: 4 };
const STRONG_POINT_MAN = { userInitiativeRate: 80, totalInitiativeAttempts: 10, avgReactionLatency: "0.90s" };
// 기준 분포 중앙값(백분위 50).
const MEDIAN_EXECUTOR = { avgDuelWinRate: 70, totalDuelWins: 7, totalDuelLosses: 3, userReversalRate: 12.5, totalReversalAttempts: 8 };

describe("reference percentile", () => {
  it("interpolates between quantiles and clamps outside the observed range", () => {
    expect(referencePercentile("duelWin", 70)).toBe(50);
    expect(referencePercentile("duelWin", 72)).toBeCloseTo(50 + (2 / 3.684) * 10, 5);
    expect(referencePercentile("duelWin", 10)).toBe(2.5);
    expect(referencePercentile("duelWin", 99)).toBe(97.5);
  });

  it("uses the middle of a tied block such as many zero values", () => {
    // reversal 0은 5·10·20백분위에 걸쳐 있다.
    expect(referencePercentile("reversal", 0)).toBe(10);
    // reactionSec 3초는 90·95백분위에 걸쳐 있다(측정 상한).
    expect(referencePercentile("reactionSec", 3)).toBe(95);
    // 복수자 역할 점수 17.84는 5~30백분위에 걸쳐 있다.
    expect(roleScorePercentile("avenger", 17.84)).toBe(15);
  });
});

describe("role metric extraction", () => {
  it("withholds metrics below their minimum opportunities", () => {
    const metrics = extractRoleMetrics({
      ...BASE,
      avgDuelWinRate: 100, totalDuelWins: 2, totalDuelLosses: 0,
      userInitiativeRate: 100, totalInitiativeAttempts: 2,
      totalTeammateKnocks: 2, totalRevCount: 2,
      totalDistanceDamage: { short: 200, mid: 0, long: 0 },
      killContribFinal: { solo: 1, cleanup: 0, assist: 1 },
    });
    expect(metrics).toMatchObject({ duelWin: null, initiative: null, rescueRate: null, tradeRate: null, shortShare: null, longShare: null, assistShare: null });
  });

  it("converts totals into shares and per-match rates", () => {
    const metrics = extractRoleMetrics({
      ...BASE,
      mLen: 4,
      totalTeammateKnocks: 4, totalRevCount: 1, totalSmokeRescues: 1, totalTradeKills: 1,
      totalDistanceDamage: { short: 300, mid: 100, long: 100 },
      totalEdgePlay: 8, totalUtilityHits: 2, avgBackupLatency: "12.50s",
      goldenTimeAvg: { early: 50, mid1: 25, mid2: 25, late: 0 },
      killContribFinal: { solo: 3, cleanup: 0, assist: 1 },
    });
    expect(metrics).toMatchObject({
      rescueRate: 50, tradeRate: 25, shortShare: 60, longShare: 20, edgePerMatch: 2,
      utilityHitsPerMatch: 0.5, tradeSec: 12.5, earlyShare: 50, assistShare: 25,
    });
  });
});

describe("role selection", () => {
  it("reports insufficient evidence when no metric can be judged", () => {
    const result = classify();
    expect(result).toMatchObject({ primaryRole: "insufficient", secondaryRole: null, title: "전술 분석 중", evidence: [], badges: [] });
  });

  it("picks the role that stands out against other players and explains it", () => {
    const result = classify(STRONG_EXECUTOR);
    expect(result).toMatchObject({ primaryRole: "executor", secondaryRole: null, title: "결투의 제왕", roleLabel: "처형자 (Executor)" });
    expect(result.scores.executor).toBe(97.5);
    expect(result.scores.pointMan).toBeNull();
    expect(result.evidence).toEqual(["1:1 승률 상위 3%", "역전 승률 상위 3%"]);
  });

  it("does not put the tier into the title", () => {
    expect(classify(STRONG_EXECUTOR, "S+").title).toBe(classify(STRONG_EXECUTOR, "C").title);
    expect(classify(STRONG_EXECUTOR, "S+").overallTier).toBe("S+");
  });

  it("does not apply the composite point-man distribution to initiative alone", () => {
    const result=classify({...STRONG_POINT_MAN,avgReactionLatency:"측정 불가"});
    expect(result.scores.pointMan).toBeNull();
    expect(result.primaryRole).not.toBe("pointMan");
    expect(result.evidence.join(" ")).not.toMatch(/반격/);
  });

  it("describes observed initiative and reply without claiming first fire", () => {
    const result=classify(STRONG_POINT_MAN);
    expect(result.description).toContain('선제 타격');
    expect(result.description).not.toMatch(/먼저 쏘|반사신경/);
    const withheld=classify({...STRONG_EXECUTOR,...STRONG_POINT_MAN,avgReactionLatency:'측정 불가'});
    expect(withheld.scores.pointMan).toBeNull();
    expect(withheld.primaryRole).not.toBe('pointMan');
    expect(withheld.secondaryRole).not.toBe('pointMan');
    expect(withheld.title).not.toMatch(/선봉/);
  });

  it("treats a faster reaction as better", () => {
    expect(classify(STRONG_POINT_MAN).scores.pointMan).toBe(97.5);
    expect(classify({ ...STRONG_POINT_MAN, userInitiativeRate: null, totalInitiativeAttempts: 0 }).scores.pointMan).toBeNull();
    // 지표 백분위 5는 선봉대 역할 점수 분포의 5백분위(12.13)보다 낮다.
    expect(classify({ userInitiativeRate: 0, totalInitiativeAttempts: 10, avgReactionLatency: "3.00s" }).scores.pointMan).toBe(2.5);
  });

  it("uses a combo title only when both roles are strong, regardless of order", () => {
    const combo = classify({ ...STRONG_EXECUTOR, ...STRONG_POINT_MAN });
    expect(combo.title).toBe("선봉의 심판자");
    expect(combo.secondaryRole).not.toBeNull();
    expect(combo.roleLabel).toContain("보조:");

    const single = classify({ ...STRONG_EXECUTOR, userInitiativeRate: 50, totalInitiativeAttempts: 10, avgReactionLatency: "2.196s" });
    expect(single).toMatchObject({ primaryRole: "executor", secondaryRole: null, title: "결투의 제왕" });
  });

  it("falls back to balanced when no role reaches the 70th percentile", () => {
    const result = classify(MEDIAN_EXECUTOR);
    expect(result).toMatchObject({ primaryRole: "balanced", title: "균형형 전술가", secondaryRole: null, evidence: [] });
  });

  it("names a field commander when six roles are strong but none dominates", () => {
    // 각 지표를 기준 분포 80백분위 값으로 맞춘다.
    const result = classify({
      avgDuelWinRate: 82.353, totalDuelWins: 8, totalDuelLosses: 2, userReversalRate: 25, totalReversalAttempts: 4,
      userInitiativeRate: 62.5, totalInitiativeAttempts: 10, avgReactionLatency: "1.611s",
      avgPressureIndex: 4.91, avgPlacementPct: 84.853, totalEdgePlay: 13,
      totalUtilityHits: 1.6, totalLethalThrows: 3.333,
      totalDistanceDamage: { short: 681.95, mid: 318.05, long: 0 },
      avgTeamDamageShare: 46.18,
    });
    expect(result).toMatchObject({ primaryRole: "fieldCommander", title: "육각형 플레이어", secondaryRole: null });
    expect(result.scores.fieldCommander!).toBeGreaterThan(75);
    expect(result.scores.fieldCommander!).toBeLessThan(95);
    expect(result.evidence).toHaveLength(2);
  });

  it("does not judge team-only roles in solo mode", () => {
    const rescues = { totalTeammateKnocks: 6, totalRevCount: 6, totalTradeKills: 3, avgTeamDamageShare: 80 };
    expect(classify(rescues).scores).toMatchObject({ shield: 97.5, mainGun: 97.5 });
    const solo = classify({ ...rescues, modeDistribution: { main: "solo" } });
    expect(solo.scores).toMatchObject({ shield: null, avenger: null, mainGun: null, decoy: null, crossfire: null });
    expect(solo.primaryRole).toBe("insufficient");
  });
});

describe("weakness and badges", () => {
  it("reports the weakest metric only when it is in the bottom 20%", () => {
    expect(classify({ ...STRONG_POINT_MAN, avgDuelWinRate: 30, totalDuelWins: 3, totalDuelLosses: 7 }).weakness)
      .toBe("1:1 승률이(가) 다른 플레이어 대비 하위 3%입니다.");
    expect(classify({ ...STRONG_POINT_MAN, ...MEDIAN_EXECUTOR }).weakness).toBeNull();
  });

  it("adds vehicle and signature weapon badges without replacing the role title", () => {
    const result = classify({
      ...STRONG_EXECUTOR,
      totalRidingShotKnocks: 2, totalLeadShotKills: 1, vehicleCombatMatchCount: 2,
      mLen: 4, weaponStatsFinal: { WeapM416_C: { kills: 4, dbnos: 0 } }, weaponMatchCount: { WeapM416_C: 3 },
    });
    expect(result.title).toBe("결투의 제왕");
    expect(result.badges).toEqual(["차량 교전", "M416 주력"]);
    expect(classify({ ...STRONG_EXECUTOR, totalRidingShotKnocks: 3, vehicleCombatMatchCount: 1 }).badges).toEqual([]);
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
    // 대체 이름은 배지로 쓰지 않는다
    expect(ignored.badges).toEqual([]);
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

