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
  return total;
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
    avgTeamWipes: null,
  };
}
