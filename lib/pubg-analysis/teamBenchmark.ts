// 팀 분석 비교 기준. pubg_team_benchmarks(매일 집계)의 팀 관측 합계를 화면·AI 비교값으로 바꾼다.
export const TEAM_BENCHMARK_MIN_SAMPLE = 300;

export type TeamBenchmarkRow = {
  sample_team_matches: number;
  knocks: number;
  revives: number;
  trade_kills: number;
  trade_latency_total_ms: number;
  smoke_sample_team_matches: number;
  smoke_knocks: number;
  smoke_rescues: number;
  // 잡을 수 있었던 기절 집계. migration 적용 전 행에는 없어 선택 값이다.
  tradeable_sample_team_matches?: number;
  tradeable_knocks?: number;
  tradeable_trade_kills?: number;
};

export type TeamBenchmarkStats = {
  tier: null;
  scope: "team_population";
  teamMode: "duo" | "squad";
  sampleCount: number;
  avgIsolation: null;
  avgTradeLatency: number | null;
  avgReviveRate: number | null;
  avgSmokeRate: number | null;
  avgTeammateKnocks: number | null;
  avgTradeableTradeRate: number | null;
  avgTeamWipes: null;
};

const nonNegative = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
// 매일 집계가 조금 바뀌어도 AI 캐시가 매번 새로 만들어지지 않도록 반올림한다.
const percent = (numerator: number, denominator: number) => Math.round((numerator / denominator) * 1000) / 10;

/**
 * 계산 버전별 집계 행을 합친다. 팀 관측값(기절·소생·트레이드·연막)은 계산 2·3·4에서 산식이 같고,
 * 한 경기는 한 계산 버전에만 속하므로 합계를 더해도 중복이 없다. 값이 하나라도 잘못되면 null이다.
 */
export function sumTeamBenchmarkRows(rows: readonly (TeamBenchmarkRow | null | undefined)[]): TeamBenchmarkRow | null {
  const valid = rows.filter((row): row is TeamBenchmarkRow => Boolean(row));
  if (valid.length === 0) return null;
  const keys = ["sample_team_matches", "knocks", "revives", "trade_kills", "trade_latency_total_ms",
    "smoke_sample_team_matches", "smoke_knocks", "smoke_rescues"] as const;
  const total = {} as TeamBenchmarkRow;
  for (const key of keys) {
    let sum = 0;
    for (const row of valid) {
      const value = nonNegative(row[key]);
      if (value === null) return null;
      sum += value;
    }
    total[key] = sum;
  }
  // 잡을 수 있었던 기절 열이 하나라도 없으면 그 비교값만 비우고 나머지는 그대로 쓴다.
  for (const key of ["tradeable_sample_team_matches", "tradeable_knocks", "tradeable_trade_kills"] as const) {
    const values = valid.map((row) => nonNegative(row[key]));
    if (values.every((value): value is number => value !== null)) total[key] = values.reduce((sum, value) => sum + value, 0);
  }
  return total;
}

// 잡을 수 있었던 기절 대비 복수 성공 비율. 값이 기록된 경기가 표본 기준 미만이면 비교하지 않는다.
function tradeableRate(row: TeamBenchmarkRow): number | null {
  const sample = nonNegative(row.tradeable_sample_team_matches);
  const knocks = nonNegative(row.tradeable_knocks);
  const trades = nonNegative(row.tradeable_trade_kills);
  if (sample === null || sample < TEAM_BENCHMARK_MIN_SAMPLE || !knocks || trades === null || trades > knocks) return null;
  return percent(trades, knocks);
}

export function toTeamBenchmarkStats(row: TeamBenchmarkRow | null | undefined, teamMode: "duo" | "squad"): TeamBenchmarkStats | null {
  const sample = nonNegative(row?.sample_team_matches);
  const knocks = nonNegative(row?.knocks);
  const revives = nonNegative(row?.revives);
  const tradeKills = nonNegative(row?.trade_kills);
  const tradeTotal = nonNegative(row?.trade_latency_total_ms);
  if (!row || sample === null || sample < TEAM_BENCHMARK_MIN_SAMPLE || knocks === null || revives === null
    || tradeKills === null || tradeTotal === null || revives > knocks || tradeKills > knocks) return null;
  const smokeSample = nonNegative(row.smoke_sample_team_matches);
  const smokeKnocks = nonNegative(row.smoke_knocks);
  const smokeRescues = nonNegative(row.smoke_rescues);
  return {
    tier: null,
    scope: "team_population",
    teamMode,
    sampleCount: sample,
    avgIsolation: null,
    avgTradeLatency: tradeKills > 0 ? Math.round(tradeTotal / tradeKills / 100) * 100 : null,
    avgReviveRate: knocks > 0 ? percent(revives, knocks) : null,
    avgSmokeRate: smokeSample !== null && smokeSample >= TEAM_BENCHMARK_MIN_SAMPLE && smokeKnocks && smokeRescues !== null
      && smokeRescues <= smokeKnocks ? percent(smokeRescues, smokeKnocks) : null,
    // 팀 경기당 아군 기절 수. 자기장·낙하 기절도 실제로 쓰러진 횟수라 함께 센다.
    avgTradeableTradeRate: tradeableRate(row),
    avgTeammateKnocks: sample > 0 ? Math.round((knocks / sample) * 10) / 10 : null,
    avgTeamWipes: null,
  };
}

// 팀원 경기당 피해량 비교 평균. benchmark_stats_by_tier_v2(5분 이상 생존한 사람 일반전·경쟁전 경기)의 모든 티어 구간을 표본 수로 가중 평균한다.
// 저장된 tier는 경기 점수 구간이라 나누지 않는다. 피해량은 계산 버전과 무관해 지원 버전을 합친다.
export const SQUAD_DAMAGE_BASELINE_MIN_SAMPLE = 200;

export type DamageBaselineRow = {
  game_mode?: unknown;
  match_type?: unknown;
  avg_damage?: unknown;
  avg_damage_count?: unknown;
};

/**
 * 경기에 나온 모드·경기 유형 조합마다 평균을 내고 가장 낮은 값을 쓴다(낮은 피해량 판정이 보수적이 된다).
 * 한 조합이라도 표본이 기준 미만이면 null이다. 매일 바뀌는 집계로 캐시가 흔들리지 않게 10 단위로 반올림한다.
 * 신뢰 조건(filter·모집단 근거·계산 버전)은 호출부가 isTrustedBenchmarkAggregate로 거른 행만 넘긴다.
 */
export function squadDamageBaseline(
  rows: readonly DamageBaselineRow[],
  combos: readonly { gameMode: string; matchType: string }[],
): number | null {
  if (combos.length === 0) return null;
  const means = combos.map(({ gameMode, matchType }) => {
    let total = 0;
    let count = 0;
    for (const row of rows) {
      if (row.game_mode !== gameMode || row.match_type !== matchType) continue;
      const avg = nonNegative(row.avg_damage);
      const rowCount = nonNegative(row.avg_damage_count);
      if (avg === null || rowCount === null) continue;
      total += avg * rowCount;
      count += rowCount;
    }
    return count >= SQUAD_DAMAGE_BASELINE_MIN_SAMPLE ? total / count : null;
  });
  if (means.some(mean => mean === null)) return null;
  return Math.round(Math.min(...(means as number[])) / 10) * 10;
}
