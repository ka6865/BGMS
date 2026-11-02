// 스쿼드 지표의 표본 기준. 펀치라인 재료 선정, AI 리포트 블록, 근거 후처리가 같은 상수를 함께 쓴다.
// 표본이 기준보다 적은 지표는 수치를 비교하거나 평가하지 않는다.

// 백업 속도는 트레이드(복수) 기록이 이 값 이상일 때만 평가한다. 한두 번의 우연으로 팀 특성을 말하지 않게 한다.
export const SQUAD_MIN_TRADE_KILLS = 3;
// 구조율·연막 기록은 아군 기절이 이 값 이상일 때만 비율로 평가한다.
export const SQUAD_MIN_KNOCKS = 5;

type SampleStats = Record<string, unknown> | null | undefined;

function finiteCount(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 백업 속도 수치를 평가에 쓸 수 있는지 본다. 복수 표본이 기준 미만이거나 기록이 없으면 false다. */
export function isSquadTradeLatencyEvaluable(stats: SampleStats): boolean {
  const latency = finiteCount(stats?.avgTradeLatency);
  const tradeKills = finiteCount(stats?.totalTradeKills);
  return latency !== null && tradeKills !== null && tradeKills >= SQUAD_MIN_TRADE_KILLS;
}

/** 아군 기절 대비 소생률을 평가에 쓸 수 있는지 본다. 기절 표본이 기준 미만이면 false다. */
export function isSquadReviveRateEvaluable(stats: SampleStats): boolean {
  const revives = finiteCount(stats?.totalRevives);
  const knocks = finiteCount(stats?.totalTeammateKnocks);
  return revives !== null && knocks !== null && knocks >= SQUAD_MIN_KNOCKS && revives <= knocks;
}
