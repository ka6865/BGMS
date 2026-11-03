import { tierFromBenchmarkScore } from "./benchmarkScore";
import { isSquadReviveRateEvaluable, isSquadTradeLatencyEvaluable, SQUAD_MIN_KNOCKS } from "./squadEvidenceSamples";
import { SQUAD_AI_MIN_MATCH_COUNT } from "./squadAiContract";

// 팀 점수는 다른 팀과의 순위가 아니라 고정 기준값으로 환산한다.
// 같은 플레이는 다른 사람의 성적과 상관없이 같은 점수를 받는다. 기준값은 전체 팀 평균을 한 번 참고해 정했다.
export const SQUAD_SCORE_VERSION = 1;

export type SquadScoreKey = "backupSpeed" | "survivalCare" | "smokeRescue" | "damageBalance" | "placement";

export const SQUAD_SCORE_AXES: ReadonlyArray<{ key: SquadScoreKey; label: string; weight: number }> = [
  { key: "survivalCare", label: "소생률", weight: 0.3 },
  { key: "backupSpeed", label: "백업 속도", weight: 0.2 },
  { key: "smokeRescue", label: "연막 구출", weight: 0.1 },
  // 한 명이 화력을 많이 가져가는 캐리 구조는 나쁜 플레이가 아니므로 비중을 낮게 둔다.
  { key: "damageBalance", label: "딜 균형", weight: 0.1 },
  { key: "placement", label: "순위 성과", weight: 0.3 },
];

// 등급을 내려면 측정된 축이 이 값 이상이어야 한다.
export const SQUAD_GRADE_MIN_AXES = 3;

const REVIVE_RATE_FULL = 0.6; // 소생률 60%를 100점으로 본다
const SMOKE_RATE_FULL = 0.25; // 아군 기절 대비 연막 구출 25%를 100점으로 본다
const TRADE_FAST_MS = 5_000; // 백업 속도 5초 이하를 100점으로 본다
const TRADE_WINDOW_MS = 30_000; // 복수 인정 시간 30초가 0점
const BALANCE_ZERO_OFFSET = 25; // 균등 분배보다 25%p 더 가져가면 0점
// 최종 순위별 점수. 위에서부터 처음 맞는 줄을 쓴다.
const PLACEMENT_POINTS: ReadonlyArray<[number, number]> = [[1, 100], [3, 80], [5, 60], [10, 35], [15, 15]];

export type SquadScores = Record<SquadScoreKey, number | null>;

export type SquadScoreInput = {
  stats: Record<string, unknown> | null | undefined;
  smokeRescues: number | null;
  knocks: number | null;
  damageShares: ReadonlyArray<number | null | undefined>;
  placements: ReadonlyArray<number | null | undefined>;
  matchCount: number;
};

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function placementPoints(place: number): number {
  return (PLACEMENT_POINTS.find(([max]) => place <= max)?.[1]) ?? 0;
}

export function computeSquadScores(input: SquadScoreInput): SquadScores {
  const { stats } = input;
  const scores: SquadScores = { survivalCare: null, backupSpeed: null, smokeRescue: null, damageBalance: null, placement: null };
  if (input.matchCount < SQUAD_AI_MIN_MATCH_COUNT) return scores;

  const knocks = input.knocks;
  const revives = Number(stats?.totalRevives);
  if (isSquadReviveRateEvaluable(stats) && finite(knocks) && knocks > 0) {
    scores.survivalCare = clampScore((revives / knocks / REVIVE_RATE_FULL) * 100);
  }

  const latency = Number(stats?.avgTradeLatency);
  if (isSquadTradeLatencyEvaluable(stats) && finite(latency)) {
    scores.backupSpeed = clampScore(((TRADE_WINDOW_MS - latency) / (TRADE_WINDOW_MS - TRADE_FAST_MS)) * 100);
  }

  if (finite(input.smokeRescues) && finite(knocks) && knocks >= SQUAD_MIN_KNOCKS) {
    scores.smokeRescue = clampScore((input.smokeRescues / knocks / SMOKE_RATE_FULL) * 100);
  }

  const shares = input.damageShares.filter((share): share is number => finite(share) && share >= 0 && share <= 100);
  if (shares.length >= 2 && shares.length === input.damageShares.length) {
    const even = 100 / shares.length;
    const zero = Math.min(100, even + BALANCE_ZERO_OFFSET);
    scores.damageBalance = clampScore(((zero - Math.max(...shares)) / (zero - even)) * 100);
  }

  const places = input.placements.filter((place): place is number => finite(place) && place >= 1);
  if (places.length >= SQUAD_AI_MIN_MATCH_COUNT) {
    scores.placement = clampScore(places.reduce((sum, place) => sum + placementPoints(place), 0) / places.length);
  }
  return scores;
}

export type SquadGradeResult = {
  grade: string | null;
  score: number | null;
  measuredAxes: number;
  totalAxes: number;
};

/** 측정된 축의 가중 평균을 개인 티어와 같은 경계표로 등급화한다. 측정 축이 모자라면 등급을 내지 않는다. */
export function computeSquadGrade(scores: SquadScores): SquadGradeResult {
  const measured = SQUAD_SCORE_AXES.filter(({ key }) => finite(scores[key]));
  const base = { measuredAxes: measured.length, totalAxes: SQUAD_SCORE_AXES.length };
  if (measured.length < SQUAD_GRADE_MIN_AXES) return { grade: null, score: null, ...base };
  const weight = measured.reduce((sum, { weight: w }) => sum + w, 0);
  const score = Math.round((measured.reduce((sum, { key, weight: w }) => sum + (scores[key] as number) * w, 0) / weight) * 10) / 10;
  return { grade: tierFromBenchmarkScore(score), score, ...base };
}
