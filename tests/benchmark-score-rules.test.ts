import { describe, expect, it } from "vitest";
import {
  calcBenchmarkScoreDetails,
  estimateUserTier,
  getBenchmarkTier,
  getBaseTier,
  getNextTierInfo,
  type MatchTierInput,
} from "@/lib/pubg-analysis/benchmarkScore";

// docs-private/tier_score_rules.md의 산식을 구성 요소별로 고정한다.
// 기본 입력은 모든 가변 점수를 0으로 두어 한 요소만 바꿨을 때의 변화를 그대로 관찰한다.
// 스쿼드 기본값: 전투 5(딜량 순위 최하 구간) + 전술 0 + 생존 5(기절·사망 없음) = 10점
// 솔로 기본값: 전투 5 + 전술 0 + 생존 0 = 5점
const BASE: MatchTierInput = {
  rankPct: 1,
  survivalTime: 1500,
  initiativeRate: 0,
  counterLatencyMs: 3000,
  pressureIndex: 0,
  smokeRate: 0,
  suppCount: 0,
  reviveRate: 0,
  tradeRate: 0,
  teamWipes: 0,
  reversalRate: 0,
  deathPhase: 0,
  suppRate: 0,
  isolationIndex: 0,
  survivalRankPct: 1,
  myKnockCount: 0,
  myDeathCount: 0,
  winPlace: 50,
  teamMode: "squad",
};

const squad = (overrides: Partial<MatchTierInput> = {}) => calcBenchmarkScoreDetails({ ...BASE, ...overrides }, false);
const solo = (overrides: Partial<MatchTierInput> = {}) => calcBenchmarkScoreDetails({ ...BASE, teamMode: "solo", ...overrides }, true);
const squadResult = (overrides: Partial<MatchTierInput> = {}) => getBenchmarkTier({ ...BASE, ...overrides }, false);
const soloResult = (overrides: Partial<MatchTierInput> = {}) => getBenchmarkTier({ ...BASE, teamMode: "solo", ...overrides }, true);

// 임팩트 보정에 영향을 주지 않는 연속 요소만으로 원하는 스쿼드 총점을 만든다.
// 딜량 순위는 구간 점수라 총점이 연속 요소 최대치(72.45)를 넘을 때만 상위 10%(+15점)를 사용한다.
function squadInputWithTotal(total: number): MatchTierInput {
  let remaining = total - 10;
  const input: MatchTierInput = { ...BASE };
  if (remaining > 72.45) {
    input.rankPct = 0.10;
    remaining -= 15;
  }
  const take = (max: number) => {
    const value = Math.min(max, remaining);
    remaining -= value;
    return value;
  };
  input.pressureIndex = take(10) / 2;
  input.initiativeRate = take(10) * 6;
  input.counterLatencyMs = 3000 - take(10) * 200;
  input.survivalRankPct = 1 - take(20) / 20;
  input.suppCount = take(5) * 1.2;
  input.smokeRate = take(5) * 20;
  input.reviveRate = (take(3) / 3) * 100;
  input.tradeRate = take(2) * 50;
  input.suppRate = take(2) * 50;
  input.teamWipes = take(1.5) / 1.5;
  // 역전 승률 80% 이상은 임팩트 CLUTCH 보정을 주므로 79%(3.95점)까지만 사용한다
  input.reversalRate = take(3.95) * 20;
  if (remaining > 1e-9) throw new Error(`total ${total} is not reachable by the helper`);
  return input;
}

describe("benchmark score base fixtures", () => {
  it("starts from the documented minimum components", () => {
    expect(squad()).toEqual({ combat: 5, tactical: 0, survival: 5 });
    expect(solo()).toEqual({ combat: 5, tactical: 0, survival: 0 });
  });

  it.each([12, 37.5, 61.2, 89.9, 90, 96])("helper reaches squad total %s exactly", (total) => {
    expect(getBenchmarkTier(squadInputWithTotal(total), false).score).toBeCloseTo(total, 5);
  });
});

describe("early death guard (survivalTime < 300)", () => {
  it("zeroes score, breakdown and impact below 300 seconds", () => {
    const result = squadResult({ survivalTime: 299, kills: 10, damageDealt: 1000, rankPct: 0.01 });
    expect(result).toEqual({
      tier: null,
      score: 0,
      breakdown: { combat: 0, tactical: 0, survival: 0 },
      impactScore: 0,
      impactGrade: "NORMAL",
      impactBonus: 0,
      impactReasons: [],
      contributionTypes: [],
    });
    expect(squad({ survivalTime: 299 })).toEqual({ combat: 0, tactical: 0, survival: 0 });
  });

  it("scores a match that lasted exactly 300 seconds", () => {
    expect(squadResult({ survivalTime: 300 }).score).toBe(10);
    expect(squad({ survivalTime: 300 })).toEqual({ combat: 5, tactical: 0, survival: 5 });
  });
});

describe("combat score", () => {
  it.each([
    [0.10, 20, 25],
    [0.1001, 15, 18],
    [0.25, 15, 18],
    [0.2501, 10, 12],
    [0.50, 10, 12],
    [0.5001, 5, 5],
  ])("damage rank %s gives squad %s and solo %s points", (rankPct, squadPoints, soloPoints) => {
    expect(squad({ rankPct }).combat).toBe(squadPoints);
    expect(solo({ rankPct }).combat).toBe(soloPoints);
  });

  it("treats a non-finite damage rank as the lowest bracket", () => {
    expect(squad({ rankPct: Number.NaN }).combat).toBe(5);
  });

  it.each([
    [30, 5 + 5, 5 + 7.5],
    [60, 5 + 10, 5 + 15],
    [90, 5 + 10, 5 + 15],
  ])("initiative rate %s%% scales to the 60%% cap", (initiativeRate, squadCombat, soloCombat) => {
    expect(squad({ initiativeRate }).combat).toBe(squadCombat);
    expect(solo({ initiativeRate }).combat).toBe(soloCombat);
  });

  it("uses 45% when there was no initiative opportunity", () => {
    expect(squad({ initiativeRate: -1 }).combat).toBe(5 + 7.5);
    expect(solo({ initiativeRate: -1 }).combat).toBe(Number((5 + 11.25).toFixed(1)));
  });

  it.each([
    [500, 10],
    [1000, 10],
    [2000, 5],
    [2600, 2],
    [3000, 0],
    [4000, 0],
  ])("counter latency %sms gives %s points", (counterLatencyMs, points) => {
    expect(squad({ counterLatencyMs }).combat).toBe(5 + points);
    expect(solo({ counterLatencyMs }).combat).toBe(5 + points);
  });

  it("uses the mode average counter score when no ambush was measured (calculation 4)", () => {
    // 계산 2·3은 5점. 계산 4는 팀 3.3점, 솔로 3.8점(관측 평균).
    expect(squad({ counterLatencyMs: -1 }).combat).toBe(8.3);
    expect(solo({ counterLatencyMs: -1 }).combat).toBe(8.8);
  });

  it("treats a non-finite counter latency as unmeasured", () => {
    expect(squad({ counterLatencyMs: Number.NaN }).combat).toBe(8.3);
  });
});

describe("tactical score", () => {
  it.each([
    [2.5, 5],
    [5, 10],
    [10, 10],
    [-3, 0],
  ])("pressure index %s gives %s points", (pressureIndex, points) => {
    expect(squad({ pressureIndex }).tactical).toBe(points);
    expect(solo({ pressureIndex }).tactical).toBe(points);
  });

  it.each([
    [40, 2],
    [100, 5],
    [150, 5],
  ])("reversal rate %s%% gives %s points", (reversalRate, points) => {
    expect(squad({ reversalRate }).tactical).toBe(points);
    expect(solo({ reversalRate }).tactical).toBe(points);
  });

  it("falls back reversal to the mode average when there was no reversal opportunity (calculation 4)", () => {
    // 계산 2·3은 조기 10%, 정상 50%, 무사망 20분 이상 100%. 계산 4는 생존과 무관하게 팀 13.2%, 솔로 33.0%.
    for (const survivalTime of [599, 1199, 1200]) {
      expect(squad({ reversalRate: -1, survivalTime }).tactical).toBe(0.7);
      expect(solo({ reversalRate: -1, survivalTime }).tactical).toBe(1.7);
    }
    expect(squad({ reversalRate: -1, survivalTime: 1500, myDeathCount: 1, deathPhase: 6 }).tactical).toBe(0.7);
  });

  it("scores squad utility from smoke rescue rate and suppression count", () => {
    expect(squad({ smokeRate: 100 }).tactical).toBe(5);
    expect(squad({ suppCount: 1.2 }).tactical).toBe(1);
    expect(squad({ suppCount: 6 }).tactical).toBe(5);
    expect(squad({ suppCount: 12 }).tactical).toBe(5);
    expect(squad({ smokeRate: 100, suppCount: 6 }).tactical).toBe(10);
    expect(squad({ suppCount: -5 }).tactical).toBe(0);
  });

  it("scores squad team contribution with its documented weights and wipe cap", () => {
    expect(squad({ reviveRate: 100 }).tactical).toBe(3);
    expect(squad({ tradeRate: 100 }).tactical).toBe(2);
    expect(squad({ suppRate: 100 }).tactical).toBe(2);
    expect(squad({ teamWipes: 1 }).tactical).toBe(1.5);
    expect(squad({ teamWipes: 2 }).tactical).toBe(3);
    expect(squad({ teamWipes: 5 }).tactical).toBe(3);
    expect(squad({ reviveRate: 100, tradeRate: 100, suppRate: 100, teamWipes: 5 }).tactical).toBe(10);
  });

  it("treats a non-finite rate as no opportunity", () => {
    // 기회 없음 → 계산 4 평균 소생률 14.5% → 0.435점
    expect(squad({ reviveRate: Number.NaN, survivalTime: 900 }).tactical).toBe(0.4);
    expect(squad({ initiativeRate: Number.NaN }).combat).toBe(5 + 7.5);
  });

  it("caps rates above 100%", () => {
    expect(squad({ reviveRate: 200 }).tactical).toBe(3);
  });

  it("falls back missing team opportunities to the observed average regardless of exit time (calculation 4)", () => {
    const normal = { reviveRate: -1, tradeRate: -1, suppRate: -1, smokeRate: -1, survivalTime: 900 };
    // 소생 14.5%×3 + 트레이드 8.1%×2 + 지원 9.7%×2 + 연막 5.7%×5 = 0.435 + 0.162 + 0.194 + 0.285
    expect(squad(normal).tactical).toBe(1.1);
    expect(squad({ ...normal, survivalTime: 599 }).tactical).toBe(1.1);
    expect(squad({ ...normal, myDeathCount: 1, deathPhase: 3 }).tactical).toBe(1.1);
  });

  it("never scores a missing opportunity above a measured failure plus the average", () => {
    const noOpportunity = squad({ reviveRate: -1, tradeRate: -1, suppRate: -1, smokeRate: -1, reversalRate: -1, counterLatencyMs: -1 });
    const averageObserved = squad({ reviveRate: 14.5, tradeRate: 8.1, suppRate: 9.7, smokeRate: 5.7, reversalRate: 13.2, counterLatencyMs: 2340 });
    expect(noOpportunity.tactical).toBe(averageObserved.tactical);
    expect(noOpportunity.combat).toBe(averageObserved.combat);
  });

  it("does not apply squad-only utility and team points to solo", () => {
    expect(solo({ smokeRate: 100, suppCount: 6, reviveRate: 100, tradeRate: 100, suppRate: 100, teamWipes: 5 }).tactical).toBe(0);
  });

  it.each([
    [3.4, 10],
    [3.5, 10],
    [4, 9],
    [5, 7],
    [6.5, 7],
  ])("isolation index %s leaves squad tactical %s from 10", (isolationIndex, tactical) => {
    expect(squad({ pressureIndex: 5, isolationIndex }).tactical).toBe(tactical);
  });

  it("never lets the isolation penalty make tactical negative and ignores it for solo", () => {
    expect(squad({ isolationIndex: 6 }).tactical).toBe(0);
    expect(solo({ pressureIndex: 5, isolationIndex: 6 }).tactical).toBe(10);
  });
});

describe("survival score", () => {
  it.each([
    [0, 20, 30],
    [0.5, 10, 15],
    [1, 0, 0],
    [-1, 20, 30],
    [2, 0, 0],
  ])("survival rank ratio %s gives squad %s and solo %s rank points", (survivalRankPct, squadRank, soloRank) => {
    expect(squad({ survivalRankPct }).survival).toBe(squadRank + 5);
    expect(solo({ survivalRankPct }).survival).toBe(soloRank);
  });

  it("gives the solo top-10 bonus only to place 10 or better", () => {
    expect(solo({ winPlace: 10 }).survival).toBe(5);
    expect(solo({ winPlace: 11 }).survival).toBe(0);
    expect(squad({ winPlace: 1 }).survival).toBe(5);
  });

  it.each([
    [0, 0, 5],
    [2, 1, 2.5],
    [1, 1, 0],
    [0, 1, 0],
    [3, 0, 5],
  ])("squad knock %s times and death %s gives %s groggy points", (myKnockCount, myDeathCount, groggy) => {
    // 4페이즈 이후 사망으로 두어 조기 탈락 폴백이 섞이지 않게 한다
    expect(squad({ myKnockCount, myDeathCount, deathPhase: 6 }).survival).toBe(groggy);
  });
});

describe("tier cutoffs", () => {
  const cutoffs: Array<[string, number, string]> = [
    ["S+", 90, "S"],
    ["S", 82, "A+"],
    ["A+", 75, "A"],
    ["A", 68, "A-"],
    ["A-", 60, "B+"],
    ["B+", 52, "B"],
    ["B", 44, "B-"],
    ["B-", 36, "C+"],
    ["C+", 28, "C"],
    ["C", 20, "C-"],
    ["C-", 12, "D+"],
  ];

  it.each(cutoffs)("match tier %s starts at %s points", (tier, min, below) => {
    expect(getBenchmarkTier(squadInputWithTotal(min), false).tier).toBe(tier);
    expect(getBenchmarkTier(squadInputWithTotal(min - 0.1), false).tier).toBe(below);
  });

  it("lowest reachable match score is 5 (D) and 6 becomes D+", () => {
    // 딜량 최하 구간 5점이 항상 들어가므로 실제 경기는 5점 미만이 될 수 없다
    const lowest = squadResult({ myKnockCount: 1, myDeathCount: 1, deathPhase: 6 });
    expect(lowest.score).toBe(5);
    expect(lowest.tier).toBe("D");
    expect(squadResult({ myKnockCount: 1, myDeathCount: 1, deathPhase: 6, pressureIndex: 0.5 }).tier).toBe("D+");
  });

  it.each([
    [90, "S+"], [89.9, "S"], [82, "S"], [81.9, "A+"], [75, "A+"], [74.9, "A"],
    [68, "A"], [67.9, "A-"], [60, "A-"], [59.9, "B+"], [52, "B+"], [51.9, "B"],
    [44, "B"], [43.9, "B-"], [36, "B-"], [35.9, "C+"], [28, "C+"], [27.9, "C"],
    [20, "C"], [19.9, "C-"], [12, "C-"], [11.9, "D+"], [6, "D+"], [5.9, "D"],
    [3, "D"], [2.9, "D-"], [0, "D-"], [-1, "D-"],
  ])("average score %s estimates %s", (score, tier) => {
    expect(estimateUserTier(score)).toBe(tier);
  });

  it.each([
    ["S+", "S"], ["S", "S"], ["A+", "A"], ["A", "A"], ["A-", "A"], ["B+", "B"], ["B", "B"], ["B-", "B"],
    ["C+", "C"], ["C", "C"], ["C-", "C"], ["D+", "D"], ["D", "D"], ["D-", "D"], [null, "C"], ["", "C"], ["X", "C"],
  ])("maps tier %s to benchmark base tier %s", (tier, base) => {
    expect(getBaseTier(tier)).toBe(base);
  });

  it("reports the next tier and the remaining points", () => {
    expect(getNextTierInfo(90)).toBeNull();
    expect(getNextTierInfo(95)).toBeNull();
    expect(getNextTierInfo(89.9)).toEqual({ tier: "S+", needed: 0.1 });
    expect(getNextTierInfo(70)).toEqual({ tier: "A+", needed: 5 });
    expect(getNextTierInfo(0)).toEqual({ tier: "D", needed: 3 });
    expect(getNextTierInfo(-1)).toEqual({ tier: "D", needed: 4 });
  });
});

describe("match impact bonus", () => {
  const impact = (overrides: Partial<MatchTierInput>, isSolo = false) =>
    isSolo ? soloResult(overrides) : squadResult(overrides);

  it("adds nothing for a plain match", () => {
    const result = impact({});
    expect(result).toMatchObject({ impactBonus: 0, impactScore: 10, impactReasons: [], contributionTypes: [] });
  });

  it.each([
    [4, 0, null],
    [5, 3, "5킬 이상 교전 기여"],
    [6, 3, "5킬 이상 교전 기여"],
    [7, 5, "7킬 이상 고화력"],
    [9, 5, "7킬 이상 고화력"],
    [10, 8, "10킬 이상 화력 캐리"],
  ])("%s kills add %s firepower", (kills, bonus, reason) => {
    const result = impact({ kills });
    expect(result.impactBonus).toBe(bonus);
    expect(result.impactReasons).toEqual(reason ? [reason] : []);
    expect(result.contributionTypes).toEqual(reason ? ["FIREPOWER"] : []);
  });

  it.each([
    [299, 0, null],
    [300, 2, "300딜 이상 교전 참여"],
    [499, 2, "300딜 이상 교전 참여"],
    [500, 5, "500딜 이상 승리 기여"],
    [800, 8, "800딜 이상 강한 화력"],
    [1000, 12, "1000딜 이상 압도적 화력"],
  ])("%s damage adds %s firepower", (damageDealt, bonus, reason) => {
    const result = impact({ damageDealt });
    expect(result.impactBonus).toBe(bonus);
    expect(result.impactReasons).toEqual(reason ? [reason] : []);
    expect(result.contributionTypes).toEqual(reason ? ["FIREPOWER"] : []);
  });

  it.each([
    [0.03, 7, "딜량 상위 3%"],
    [0.0301, 4, "딜량 상위 10%"],
    [0.10, 4, "딜량 상위 10%"],
    [0.1001, 0, null],
  ])("damage rank %s adds %s firepower", (rankPct, bonus, reason) => {
    const result = impact({ rankPct });
    expect(result.impactBonus).toBe(bonus);
    expect(result.impactReasons).toEqual(reason ? [reason] : []);
    expect(result.contributionTypes).toEqual(reason ? ["FIREPOWER"] : []);
  });

  it.each([
    ["squad", 34.9, 0, null],
    ["squad", 35, 4, "스쿼드 팀 딜 35% 이상"],
    ["squad", 44.9, 4, "스쿼드 팀 딜 35% 이상"],
    ["squad", 45, 7, "스쿼드 팀 딜 45% 이상"],
    ["duo", 54.9, 0, null],
    ["duo", 55, 4, "듀오 팀 딜 55% 이상"],
    ["duo", 64.9, 4, "듀오 팀 딜 55% 이상"],
    ["duo", 65, 7, "듀오 팀 딜 65% 이상"],
  ] as const)("%s team damage share %s adds %s", (teamMode, teamDamageShare, bonus, reason) => {
    const result = impact({ teamMode, teamDamageShare });
    expect(result.impactBonus).toBe(bonus);
    expect(result.impactReasons).toEqual(reason ? [reason] : []);
    expect(result.contributionTypes).toEqual(reason ? ["FIREPOWER"] : []);
  });

  it("does not apply team damage share to solo", () => {
    expect(impact({ teamDamageShare: 90 }, true).impactBonus).toBe(0);
    expect(impact({ teamMode: "solo", teamDamageShare: 90 }).impactBonus).toBe(0);
  });

  it("gives only the weak finisher bonus to team wipes without supporting action", () => {
    expect(impact({ teamWipes: 1 }).impactReasons).toEqual([]);
    const weak = impact({ teamWipes: 2 });
    expect(weak.impactBonus).toBe(1);
    expect(weak.impactReasons).toEqual(["전멸 마무리 기여"]);
    expect(weak.contributionTypes).toEqual(["FINISHER"]);
  });

  it.each([
    ["kills", { kills: 5 }, 3],
    ["damage", { damageDealt: 500 }, 5],
    ["team damage share", { teamDamageShare: 35 }, 4],
    ["trade kill", { tradeKills: 1 }, 3],
    ["revive", { revives: 1 }, 3],
  ] as const)("team wipes supported by %s give the finisher bonus", (_label, support, supportBonus) => {
    const two = impact({ teamWipes: 2, ...support });
    expect(two.impactBonus).toBe(3 + supportBonus);
    expect(two.impactReasons).toContain("적 팀 전멸 결정 기여");
    expect(two.contributionTypes).toContain("FINISHER");
    const four = impact({ teamWipes: 4, ...support });
    expect(four.impactBonus).toBe(6 + supportBonus);
    expect(four.impactReasons).toContain("적 팀 전멸 다수 결정 기여");
  });

  it("does not count a smoke rescue alone as finisher support", () => {
    expect(impact({ teamWipes: 2, smokeRescues: 1 }).impactBonus).toBe(1 + 3);
  });

  it.each([
    ["tradeKills", "트레이드 성공", "SUPPORT"],
    ["revives", "소생 성공", "RECOVERY"],
    ["smokeRescues", "연막 구출 성공", "RECOVERY"],
    ["safeRevivesWithoutSmoke", "연막 없이 안전 소생", "RECOVERY"],
  ] as const)("%s adds a 3 point team role bonus outside solo", (field, reason, type) => {
    const squadImpact = impact({ [field]: 1 });
    expect(squadImpact.impactBonus).toBe(3);
    expect(squadImpact.impactReasons).toEqual([reason]);
    expect(squadImpact.contributionTypes).toEqual([type]);
    expect(impact({ [field]: 1, teamWipes: 4 }, true).impactBonus).toBe(0);
  });

  it("adds the clutch bonus from 80% reversal rate", () => {
    // 역전 승률은 기본 전술 점수에도 반영되므로 impactBonus만 비교한다
    expect(impact({ reversalRate: 79 }).impactBonus).toBe(0);
    const clutch = impact({ reversalRate: 80 });
    expect(clutch.impactBonus).toBe(3);
    expect(clutch.impactReasons).toEqual(["불리한 교전 역전"]);
    expect(clutch.contributionTypes).toEqual(["CLUTCH"]);
  });

  it("adds impact to the tactical score to make impactScore", () => {
    const result = impact({ kills: 10, damageDealt: 1000 });
    expect(result.score).toBe(10);
    expect(result.impactBonus).toBe(20);
    expect(result.impactScore).toBe(30);
  });
});

describe("win contribution evidence", () => {
  // 기본 고립 지수 0은 실제 관측값이라 위험 관리 근거가 되므로, 근거 수를 정확히 세기 위해 미측정으로 둔다
  const unmeasured = { isolationIndex: undefined };
  const win = (overrides: Partial<MatchTierInput>) => squadResult({ ...unmeasured, winPlace: 1, ...overrides });
  const bonusOf = (overrides: Partial<MatchTierInput>) =>
    win(overrides).impactBonus - squadResult({ ...unmeasured, ...overrides }).impactBonus;

  it("does not reward a win without action evidence", () => {
    expect(bonusOf({})).toBe(0);
    expect(bonusOf({ isolationIndex: 1 })).toBe(0);
  });

  it("counts one action plus one risk-management evidence as two (+4)", () => {
    expect(bonusOf({ kills: 5 })).toBe(4);
    // 사망했고 고립도 미측정이면 위험 관리 근거가 없어 행동 근거 1개뿐이다
    expect(bonusOf({ kills: 5, myDeathCount: 1, deathPhase: 6 })).toBe(0);
    expect(win({ kills: 5 }).contributionTypes).toEqual(["FIREPOWER", "SURVIVAL_CONTROL"]);
    expect(win({ kills: 5 }).impactReasons).toContain("승리 기여 근거 2개");
    expect(win({ kills: 5 }).contributionTypes).toContain("SURVIVAL_CONTROL");
  });

  it("caps risk-management evidence at one", () => {
    expect(bonusOf({ kills: 5, isolationIndex: 1 })).toBe(4);
  });

  it("gives +7 for three and +10 for four or more evidence", () => {
    expect(bonusOf({ kills: 5, damageDealt: 500 })).toBe(7);
    expect(win({ kills: 5, damageDealt: 500 }).contributionTypes).toContain("SURVIVAL_CONTROL");
    expect(win({ kills: 5, damageDealt: 500 }).impactReasons).toContain("명확한 승리 기여");
    expect(bonusOf({ kills: 5, damageDealt: 500, tradeKills: 1 })).toBe(10);
    expect(win({ kills: 5, damageDealt: 500, tradeKills: 1 }).impactReasons).toContain("승리 기여 근거 4개 이상");
    expect(win({ kills: 5, damageDealt: 500, tradeKills: 1 }).contributionTypes).toContain("SURVIVAL_CONTROL");
  });

  it.each([
    ["top 10% damage rank", { rankPct: 0.10 }],
    ["team damage core", { teamDamageShare: 35 }],
    ["supported team wipes", { teamWipes: 2, kills: 5 }],
    ["trade kill", { tradeKills: 1 }],
    ["revive", { revives: 1 }],
    ["smoke rescue", { smokeRescues: 1 }],
    ["safe revive", { safeRevivesWithoutSmoke: 1 }],
  ] as const)("counts %s as action evidence", (_label, evidence) => {
    expect(bonusOf(evidence as Partial<MatchTierInput>)).toBeGreaterThanOrEqual(4);
  });

  it("counts supported team wipes as a separate evidence from their support", () => {
    // 트레이드 1 + 전멸 결정 1 + 무사망 1 = 3
    expect(bonusOf({ teamWipes: 2, tradeKills: 1 })).toBe(7);
    expect(bonusOf({ teamWipes: 1, tradeKills: 1 })).toBe(4);
  });

  it("does not count weak finisher wipes or team actions in solo as evidence", () => {
    expect(bonusOf({ teamWipes: 2 })).toBe(0);
    const soloWin = (overrides: Partial<MatchTierInput>) =>
      soloResult({ winPlace: 1, ...overrides }).impactBonus - soloResult({ winPlace: 2, ...overrides }).impactBonus;
    expect(soloWin({ tradeKills: 1, revives: 1 })).toBe(0);
  });

  it("uses only an observed isolation below 2 as risk evidence after a death", () => {
    const died = { kills: 5, myDeathCount: 1, deathPhase: 6 };
    expect(bonusOf({ ...died, isolationIndex: 1.9 })).toBe(4);
    expect(bonusOf({ ...died, isolationIndex: 0 })).toBe(4);
    expect(bonusOf({ ...died, isolationIndex: 2 })).toBe(0);
    expect(bonusOf({ ...died, isolationIndex: undefined })).toBe(0);
    expect(bonusOf({ ...died, isolationIndex: -1 })).toBe(0);
    expect(bonusOf({ ...died, isolationIndex: Number.NaN })).toBe(0);
    expect(bonusOf({ ...died, isolationIndex: Number.POSITIVE_INFINITY })).toBe(0);
  });

  it("does not give the bonus to second place", () => {
    const second = squadResult({ winPlace: 2, kills: 5, damageDealt: 500, tradeKills: 1 });
    for (const reason of ["승리 기여 근거 4개 이상", "명확한 승리 기여", "승리 기여 근거 2개"]) {
      expect(second.impactReasons).not.toContain(reason);
    }
    expect(second.contributionTypes).not.toContain("SURVIVAL_CONTROL");
  });
});

describe("impact risk penalty", () => {
  // 화력 보정 10점(10킬 8 + 300딜 2)에서 감경을 관찰한다
  const strong = { kills: 10, damageDealt: 300 };

  it("subtracts 8 for an early exit", () => {
    expect(squadResult({ ...strong, survivalTime: 599 }).impactBonus).toBe(2);
    expect(squadResult({ ...strong, survivalTime: 599 }).impactReasons).toContain("조기 사망 리스크 감경");
    expect(squadResult({ ...strong, survivalTime: 600 }).impactBonus).toBe(10);
    expect(squadResult({ ...strong, myDeathCount: 1, deathPhase: 3 }).impactBonus).toBe(2);
    expect(squadResult({ ...strong, myDeathCount: 1, deathPhase: 4 }).impactBonus).toBe(10);
    expect(squadResult({ ...strong, myDeathCount: 0, deathPhase: 0 }).impactBonus).toBe(10);
  });

  it("subtracts 6 only for an observed isolation of 4.5 or more", () => {
    expect(squadResult({ ...strong, isolationIndex: 4.5 }).impactBonus).toBe(4);
    expect(squadResult({ ...strong, isolationIndex: 4.5 }).impactReasons).toContain("고립 리스크 감경");
    expect(squadResult({ ...strong, isolationIndex: 4.49 }).impactBonus).toBe(10);
    expect(squadResult({ ...strong, isolationIndex: Number.POSITIVE_INFINITY }).impactBonus).toBe(10);
  });

  it("never makes the impact bonus negative", () => {
    expect(squadResult({ kills: 5, survivalTime: 599, isolationIndex: 5 }).impactBonus).toBe(0);
  });
});

describe("impact grade", () => {
  // 점수와 무관한 보정만 더해 등급 경계를 맞춘다
  const plus20 = { kills: 10, damageDealt: 1000 };
  // 10킬 8 + 800딜 8 + 팀 딜 45% 7 + 트레이드·소생·연막 구출·안전 소생 각 3
  const plus35 = { kills: 10, damageDealt: 800, teamDamageShare: 45, tradeKills: 1, revives: 1, smokeRescues: 1, safeRevivesWithoutSmoke: 1 };
  // 96점 이상은 딜량 상위 10%(+4)가 함께 들어가므로 10킬 8 + 1000딜 12 + 팀 딜 45% 7 + 트레이드 3을 더해 +34
  const topRankPlus30 = { kills: 10, damageDealt: 1000, teamDamageShare: 45, tradeKills: 1 };

  it.each([
    [75, {}, "GOOD"],
    [74.9, {}, "NORMAL"],
    [75, plus20, "CARRY"],
    [74.9, plus20, "GOOD"],
    [75, plus35, "HARD_CARRY"],
    [74.9, plus35, "CARRY"],
    [96, topRankPlus30, "LEGEND"],
    [95.9, topRankPlus30, "HARD_CARRY"],
  ] as const)("score %s with extra impact reaches %s", (score, extra, grade) => {
    const input = { ...squadInputWithTotal(score), ...extra };
    const result = getBenchmarkTier(input, false);
    expect(result.score).toBeCloseTo(score, 5);
    expect(result.impactGrade).toBe(grade);
  });
});
