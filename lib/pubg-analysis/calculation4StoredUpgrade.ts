import {
  CALCULATION_4_OPPORTUNITY_DEFAULTS,
  getImpactGrade,
  tierFromBenchmarkScore,
  type BenchmarkResult,
} from "./benchmarkScore";

/**
 * 계산 2·3으로 저장된 경기 결과를 텔레메트리 없이 계산 4로 올린다.
 *
 * 계산 3→4는 기회 없음 대체값만 바꾸므로, 저장된 영역별 점수(combat·tactical·survival)에
 * "그 경기에서 실제로 들어간 계산 2·3 대체값"과 계산 4 대체값의 차이를 더하면 된다.
 * 기회 여부는 엔진이 점수 입력에 넘긴 값과 같은 저장 필드로 판정한다(AnalysisEngine.ts getBenchmarkTier 호출부).
 *
 * - 소생·트레이드·연막: tradeStats.teammateKnocks가 0이면 기회 없음
 * - 지원사격: tradeStats.suppRate가 null이면 기회 없음
 * - 역전: duelStats.reversalRate가 null이면 기회 없음
 * - 반격 속도: tradeStats.counterLatencyMs가 null이면 측정 불가
 *
 * 저장 점수는 영역별로 소수 첫째 자리에서 반올림돼 있어, 엔진을 다시 돌린 값과 영역당 최대 0.1점 차이가 날 수 있다.
 * 전술 점수가 이미 0(고립 감점에 걸림)이고 대체값 차이가 양수면 원래 값을 복원할 수 없어 올리지 않는다.
 */

export type Calculation4UpgradeSkipReason =
  | "unsupported_version"
  | "missing_benchmark"
  | "missing_fields"
  | "tactical_floor_unknown";

export type Calculation4UpgradeResult =
  | { ok: true; benchmark: BenchmarkResult; delta: number; reasons: Calculation4OpportunityReason[] }
  | { ok: false; reason: Calculation4UpgradeSkipReason };

export type Calculation4OpportunityReason = "no_teammate_knock" | "no_support" | "no_reversal" | "no_counter_latency";

// 계산 2·3의 대체값(benchmarkScore.ts 계산 3 시점 calcBenchmarkScoreDetails). 차이 계산에만 쓴다.
function previousFallbacks(survivalTime: number, dead: boolean, deathPhase: number) {
  const early = survivalTime < 600 || (dead && deathPhase <= 3);
  return {
    teamRate: early ? 30 : 100,
    reversal: early ? 10 : !dead && survivalTime >= 1200 ? 100 : 50,
    counterLatencyScore: 5,
  };
}

const round1 = (value: number) => Number(value.toFixed(1));
const clampScore = (value: number) => round1(Math.max(0, Math.min(100, value)));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function upgradeStoredResultToCalculation4(fullResult: unknown): Calculation4UpgradeResult {
  const result = readRecord(fullResult);
  if (!result || (result.calculationVersion !== 2 && result.calculationVersion !== 3)) {
    return { ok: false, reason: "unsupported_version" };
  }
  const benchmark = readRecord(result.benchmark);
  const breakdown = readRecord(benchmark?.breakdown);
  if (!benchmark || !breakdown || !finite(benchmark.score)) return { ok: false, reason: "missing_benchmark" };

  const stats = readRecord(result.stats);
  const tradeStats = readRecord(result.tradeStats);
  const duelStats = readRecord(result.duelStats);
  const survivalTime = stats?.timeSurvived;
  if (!stats || !tradeStats || !duelStats || !finite(survivalTime)) return { ok: false, reason: "missing_fields" };

  // 300초 미만 경기는 계산 2·3·4 모두 점수 0이다.
  if (survivalTime < 300 || benchmark.score === 0) {
    return { ok: true, benchmark: benchmark as unknown as BenchmarkResult, delta: 0, reasons: [] };
  }
  if (!finite(breakdown.combat) || !finite(breakdown.tactical) || !finite(breakdown.survival)
    || !finite(benchmark.impactBonus)) return { ok: false, reason: "missing_benchmark" };

  const isSolo = String(result.gameMode ?? "").includes("solo");
  const dead = stats.deathType !== "alive";
  const deathPhase = finite(result.deathPhase) ? Math.max(0, result.deathPhase) : 0;
  const before = previousFallbacks(survivalTime, dead, deathPhase);
  const after = CALCULATION_4_OPPORTUNITY_DEFAULTS[isSolo ? "solo" : "team"];
  const reasons: Calculation4OpportunityReason[] = [];
  let combatDelta = 0;
  let tacticalDelta = 0;

  if (!isSolo) {
    const knocks = tradeStats.teammateKnocks;
    if (!finite(knocks)) return { ok: false, reason: "missing_fields" };
    if (knocks === 0) {
      tacticalDelta += ((after.reviveRate - before.teamRate) * 3 + (after.tradeRate - before.teamRate) * 2
        + (after.smokeRate - before.teamRate) * 5) / 100;
      reasons.push("no_teammate_knock");
    }
    if (tradeStats.suppRate === null || tradeStats.suppRate === undefined) {
      tacticalDelta += ((after.suppRate - before.teamRate) * 2) / 100;
      reasons.push("no_support");
    } else if (!finite(tradeStats.suppRate)) return { ok: false, reason: "missing_fields" };
  }
  if (duelStats.reversalRate === null || duelStats.reversalRate === undefined) {
    tacticalDelta += ((after.reversalRate - before.reversal) * 5) / 100;
    reasons.push("no_reversal");
  } else if (!finite(duelStats.reversalRate)) return { ok: false, reason: "missing_fields" };
  if (tradeStats.counterLatencyMs === null || tradeStats.counterLatencyMs === undefined) {
    combatDelta += after.counterLatencyScore - before.counterLatencyScore;
    reasons.push("no_counter_latency");
  } else if (!finite(tradeStats.counterLatencyMs)) return { ok: false, reason: "missing_fields" };

  // 전술 점수가 0이면 고립 감점 전 원래 값을 알 수 없다. 내려가는 차이는 여전히 0이고, 올라가는 차이는 복원할 수 없다.
  if (breakdown.tactical === 0 && tacticalDelta > 0) return { ok: false, reason: "tactical_floor_unknown" };

  const combat = clampScore(breakdown.combat + combatDelta);
  const tactical = clampScore(breakdown.tactical === 0 ? 0 : breakdown.tactical + tacticalDelta);
  const survival = clampScore(breakdown.survival);
  const score = clampScore(combat + tactical + survival);
  const impactBonus = benchmark.impactBonus;
  const impactScore = round1(score + impactBonus);
  const upgraded: BenchmarkResult = {
    ...(benchmark as unknown as BenchmarkResult),
    tier: tierFromBenchmarkScore(score),
    score,
    breakdown: { combat, tactical, survival },
    impactScore,
    impactGrade: getImpactGrade(impactScore),
  };
  return { ok: true, benchmark: upgraded, delta: round1(score - benchmark.score), reasons };
}
