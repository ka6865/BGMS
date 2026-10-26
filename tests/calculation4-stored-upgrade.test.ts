import { describe, expect, it } from "vitest";
import { getBenchmarkTier, type MatchTierInput } from "@/lib/pubg-analysis/benchmarkScore";
import { upgradeStoredResultToCalculation4 } from "@/lib/pubg-analysis/calculation4StoredUpgrade";

// 계산 2·3 산식(계산 4 이전 calcBenchmarkScoreDetails의 기회 없음 분기)으로 저장 점수를 만든다.
// 저장 데이터 보정 결과가 계산 4 산식으로 엔진을 다시 돌린 값과 같은지 비교하기 위한 기준이다.
function calculation3Input(input: MatchTierInput, isSolo: boolean): MatchTierInput {
  const early = input.survivalTime < 600 || (input.myDeathCount > 0 && Math.max(0, input.deathPhase) <= 3);
  const team = early ? 30 : 100;
  const reversal = early ? 10 : input.myDeathCount === 0 && input.survivalTime >= 1200 ? 100 : 50;
  return {
    ...input,
    reviveRate: input.reviveRate < 0 && !isSolo ? team : input.reviveRate,
    tradeRate: input.tradeRate < 0 && !isSolo ? team : input.tradeRate,
    smokeRate: input.smokeRate < 0 && !isSolo ? team : input.smokeRate,
    suppRate: input.suppRate < 0 && !isSolo ? team : input.suppRate,
    reversalRate: input.reversalRate < 0 ? reversal : input.reversalRate,
    // 계산 2·3의 측정 불가 반격 점수 5점은 2000ms와 같다.
    counterLatencyMs: input.counterLatencyMs < 0 ? 2000 : input.counterLatencyMs,
  };
}

function storedResult(input: MatchTierInput, isSolo: boolean, version: 2 | 3 = 3) {
  // 임팩트 보정은 대체값이 아니라 원래 입력(-1 포함)을 본다. 계산 2·3 저장값도 같은 방식이었다.
  const scored = getBenchmarkTier(calculation3Input(input, isSolo), isSolo);
  const impact = getBenchmarkTier(input, isSolo);
  const benchmark = { ...scored, impactBonus: impact.impactBonus, impactReasons: impact.impactReasons,
    contributionTypes: impact.contributionTypes, impactScore: Number((scored.score + impact.impactBonus).toFixed(1)) };
  const knocks = input.reviveRate < 0 ? 0 : 2;
  return {
    calculationVersion: version,
    gameMode: isSolo ? "solo" : "squad",
    deathPhase: input.deathPhase < 0 ? null : input.deathPhase,
    stats: { timeSurvived: input.survivalTime, deathType: input.myDeathCount > 0 ? "byplayer" : "alive" },
    tradeStats: {
      teammateKnocks: isSolo ? 0 : knocks,
      suppRate: input.suppRate < 0 ? null : input.suppRate,
      counterLatencyMs: input.counterLatencyMs < 0 ? null : input.counterLatencyMs,
    },
    duelStats: { reversalRate: input.reversalRate < 0 ? null : input.reversalRate },
    benchmark,
  };
}

const BASE: MatchTierInput = {
  rankPct: 0.3, survivalTime: 1300, initiativeRate: 50, counterLatencyMs: 1500, pressureIndex: 3,
  smokeRate: 20, suppCount: 2, reviveRate: 50, tradeRate: 50, teamWipes: 1, reversalRate: 40, deathPhase: 6,
  suppRate: 30, isolationIndex: 1, survivalRankPct: 0.3, myKnockCount: 1, myDeathCount: 1, winPlace: 8,
  kills: 3, damageDealt: 400, teamDamageShare: 30, teamMode: "squad",
};

describe("upgradeStoredResultToCalculation4", () => {
  it("leaves a match with every opportunity measured unchanged except the version", () => {
    const result = upgradeStoredResultToCalculation4(storedResult(BASE, false));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.benchmark.score).toBe(getBenchmarkTier(BASE, false).score);
  });

  it.each([
    ["no teammate knock, normal exit", { reviveRate: -1, tradeRate: -1, smokeRate: -1 }, false],
    ["no teammate knock, early exit", { reviveRate: -1, tradeRate: -1, smokeRate: -1, survivalTime: 500 }, false],
    ["no support opportunity", { suppRate: -1 }, false],
    ["no reversal, clean long survival", { reversalRate: -1, myDeathCount: 0, myKnockCount: 0, winPlace: 1 }, false],
    ["no reversal, early death", { reversalRate: -1, survivalTime: 550 }, false],
    ["no ambush", { counterLatencyMs: -1 }, false],
    ["everything missing", { reviveRate: -1, tradeRate: -1, smokeRate: -1, suppRate: -1, reversalRate: -1, counterLatencyMs: -1 }, false],
    ["solo no reversal and no ambush", { reversalRate: -1, counterLatencyMs: -1, teamMode: "solo" as const }, true],
  ])("matches a calculation 4 engine rerun: %s", (_label, overrides, isSolo) => {
    const input = { ...BASE, ...overrides } as MatchTierInput;
    const result = upgradeStoredResultToCalculation4(storedResult(input, isSolo));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rerun = getBenchmarkTier(input, isSolo);
    // 저장 점수는 영역별로 반올림돼 있어 영역당 0.1점까지 차이가 날 수 있다.
    expect(Math.abs(result.benchmark.score - rerun.score)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(result.benchmark.breakdown.tactical - rerun.breakdown.tactical)).toBeLessThanOrEqual(0.1);
    expect(result.benchmark.breakdown.combat).toBeCloseTo(rerun.breakdown.combat, 5);
    expect(result.benchmark.breakdown.survival).toBe(rerun.breakdown.survival);
    expect(result.benchmark.impactBonus).toBe(rerun.impactBonus);
    expect(result.benchmark.impactReasons).toEqual(rerun.impactReasons);
  });

  it("matches engine reruns within rounding across many random matches", () => {
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
    let compared = 0;
    for (let i = 0; i < 3000; i++) {
      const isSolo = random() < 0.2;
      const noKnock = random() < 0.4;
      const dead = random() < 0.8;
      const input: MatchTierInput = {
        ...BASE,
        teamMode: isSolo ? "solo" : "squad",
        survivalTime: 300 + random() * 1700,
        rankPct: random(), pressureIndex: random() * 8, initiativeRate: pick([-1, random() * 100]),
        counterLatencyMs: pick([-1, random() * 3000, 3000]),
        reviveRate: noKnock ? -1 : random() * 100, tradeRate: noKnock ? -1 : random() * 100, smokeRate: noKnock ? -1 : random() * 60,
        suppRate: pick([-1, random() * 100]), reversalRate: pick([-1, random() * 100]), deathPhase: pick([-1, 2, 5, 8]),
        myDeathCount: dead ? 1 : 0, myKnockCount: pick([0, 1, 3]), isolationIndex: pick([0, 1, 4, 5.5]),
        survivalRankPct: random(), winPlace: Math.ceil(random() * 25),
      };
      const result = upgradeStoredResultToCalculation4(storedResult(input, isSolo));
      if (!result.ok) {
        expect(result.reason).toBe("tactical_floor_unknown");
        continue;
      }
      compared++;
      expect(Math.abs(result.benchmark.score - getBenchmarkTier(input, isSolo).score)).toBeLessThanOrEqual(0.15);
    }
    expect(compared).toBeGreaterThan(2900);
  });

  it("keeps a short match at zero and only accepts calculation 2 or 3", () => {
    const short = { ...BASE, survivalTime: 200 };
    const result = upgradeStoredResultToCalculation4(storedResult(short, false, 2));
    expect(result).toMatchObject({ ok: true, delta: 0 });
    expect(upgradeStoredResultToCalculation4({ ...storedResult(BASE, false), calculationVersion: 4 }))
      .toEqual({ ok: false, reason: "unsupported_version" });
    expect(upgradeStoredResultToCalculation4({ ...storedResult(BASE, false), calculationVersion: null }))
      .toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("refuses rows whose opportunity fields are missing instead of guessing", () => {
    const stored = storedResult(BASE, false);
    expect(upgradeStoredResultToCalculation4({ ...stored, duelStats: undefined })).toEqual({ ok: false, reason: "missing_fields" });
    expect(upgradeStoredResultToCalculation4({ ...stored, tradeStats: { ...stored.tradeStats, teammateKnocks: undefined } }))
      .toEqual({ ok: false, reason: "missing_fields" });
    expect(upgradeStoredResultToCalculation4({ ...stored, benchmark: { ...stored.benchmark, breakdown: undefined } }))
      .toEqual({ ok: false, reason: "missing_benchmark" });
  });

  it("recomputes tier and impact grade from the new score", () => {
    // 팀원 기절이 없던 정상 탈락 경기: 계산 3에서 받던 소생·트레이드·연막 만점이 사라진다.
    const input = { ...BASE, reviveRate: -1, tradeRate: -1, smokeRate: -1 };
    const stored = storedResult(input, false);
    const result = upgradeStoredResultToCalculation4(stored);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta).toBeLessThan(0);
    expect(result.reasons).toEqual(["no_teammate_knock"]);
    const rerun = getBenchmarkTier(input, false);
    expect(result.benchmark.tier).toBe(rerun.tier);
    expect(result.benchmark.impactGrade).toBe(rerun.impactGrade);
  });
});
