/**
 * 칭호(역할) 판정용 기준 분포.
 *
 * 2026-10-17 운영 DB 읽기 전용 조회로 산출했다. 계산 2·3 분석 결과에서 듀오·스쿼드 경기가 3경기 이상인
 * 플레이어 1,497명의 최근 최대 10경기를 플레이어별로 합산하고, 지표마다 아래 백분위의 값을 구했다.
 * 검색된 플레이어 표본이라 상위권에 치우쳐 있다. 솔로 위주 플레이어는 23명뿐이라 같은 분포를 함께 쓴다.
 *
 * 분포를 다시 산출하면 ROLE_REFERENCE_VERSION을 올린다.
 */
export const ROLE_REFERENCE_VERSION = 1;

export const ROLE_REFERENCE_PERCENTILES = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95] as const;

export type RoleMetricKey =
  | "initiative" | "reactionSec" | "duelWin" | "reversal" | "longShare" | "shortShare" | "maxHitDist"
  | "rescueRate" | "tradeRate" | "tradeSec" | "pressure" | "placement" | "edgePerMatch" | "earlyShare"
  | "baitPerMatch" | "supportPerMatch" | "utilityHitsPerMatch" | "lethalPerMatch" | "teamDamageShare"
  | "focusFirePerMatch" | "assistShare";

// 각 배열은 ROLE_REFERENCE_PERCENTILES 순서의 값이다.
export const ROLE_REFERENCE_QUANTILES: Record<RoleMetricKey, readonly number[]> = {
  initiative: [22.581, 28.571, 36.364, 41.667, 45.455, 50, 54, 58.333, 62.5, 68.836, 75],
  reactionSec: [1.043, 1.245, 1.611, 1.911, 2.061, 2.196, 2.364, 2.543, 2.803, 3, 3],
  duelWin: [33.333, 43.478, 53.846, 60.87, 65.517, 70, 73.684, 78.374, 82.353, 87.5, 91.667],
  reversal: [0, 0, 0, 4.348, 9.091, 12.5, 15.385, 20, 25, 33.333, 40],
  longShare: [0, 0, 1.692, 4.754, 7.516, 10.315, 13.388, 16.805, 21.52, 27.939, 33.912],
  shortShare: [18.633, 24.045, 31.85, 37.317, 43.254, 48.952, 54.19, 59.825, 68.195, 77.985, 85.509],
  maxHitDist: [73.6, 132.4, 206.2, 254.8, 293.4, 330, 366, 407, 452, 516, 572.4],
  rescueRate: [0, 0, 7.143, 11.538, 15.628, 20, 23.529, 28.571, 33.333, 44.444, 53.846],
  tradeRate: [0, 0, 0, 0, 4.167, 6.667, 9.091, 11.765, 14.286, 20, 25],
  tradeSec: [3.641, 5.186, 7.433, 8.943, 10.825, 12.168, 13.472, 14.725, 16.96, 19.812, 23.213],
  pressure: [0.933, 1.354, 1.915, 2.408, 2.871, 3.383, 3.829, 4.349, 4.91, 5.774, 6.362],
  placement: [34.23, 41.857, 50.3, 56.894, 62.245, 67.302, 72.334, 77.778, 84.853, 93.333, 97.619],
  edgePerMatch: [0.08, 0.767, 2.5, 3.98, 5.313, 6.833, 8.667, 10.5, 13, 16.86, 20.683],
  earlyShare: [0, 0, 2.337, 6.805, 10.36, 14.681, 19.643, 25.956, 34.934, 48.194, 60.18],
  baitPerMatch: [0, 0, 0.2, 0.333, 0.333, 0.5, 0.667, 0.7, 1, 1.333, 1.667],
  supportPerMatch: [0, 0, 0, 0.2, 0.3, 0.333, 0.444, 0.667, 0.796, 1, 1.333],
  utilityHitsPerMatch: [0, 0, 0, 0.2, 0.333, 0.5, 0.667, 1, 1.6, 2.667, 4],
  lethalPerMatch: [0.167, 0.333, 0.7, 1, 1.4, 1.75, 2.187, 2.667, 3.333, 4.333, 5.533],
  teamDamageShare: [12.337, 15.888, 21.333, 25.333, 29.333, 32.4, 36, 40.735, 46.18, 56.27, 69.333],
  focusFirePerMatch: [0, 0.167, 0.667, 1.333, 2, 2.778, 3.667, 4.667, 6.218, 8.667, 10.833],
  assistShare: [0, 8.333, 16.667, 22.195, 26.667, 31.25, 36.364, 41.408, 50, 60, 66.667],
};

// 역할 점수(지표 백분위 평균)의 분포. 지표 수가 다른 역할도 같은 비율로 강하다고 판정하도록
// 한 번 더 백분위로 바꾼다. 같은 플레이어 집단에서 산출했다.
export type RoleScoreKey =
  | "pointMan" | "phantomOverwatch" | "executor" | "shield" | "avenger" | "zoneController" | "dropPredator"
  | "decoy" | "grenadier" | "brawler" | "mainGun" | "crossfire";

export const ROLE_SCORE_QUANTILES: Record<RoleScoreKey, readonly number[]> = {
  pointMan: [12.13, 19.37, 29.11, 36.41, 42.8, 49.65, 56.32, 63.41, 71.18, 80.07, 85.95],
  phantomOverwatch: [6.74, 9.33, 20.04, 33.76, 43.1, 51.59, 58.92, 67.38, 75.88, 83.99, 89.79],
  executor: [10.71, 14.94, 25.91, 34.28, 42.42, 48.98, 56.27, 64.35, 75.36, 85.88, 92.07],
  shield: [7.77, 7.77, 19.94, 30.08, 40.09, 51.53, 60.06, 70.46, 78.01, 90, 94.89],
  avenger: [17.84, 17.84, 17.84, 17.84, 31.05, 45.19, 54.24, 62.11, 68.49, 76.05, 82.28],
  zoneController: [11.53, 17.95, 26.96, 35.26, 42.3, 50.26, 58.1, 65.55, 73.04, 81.04, 86.31],
  dropPredator: [8.76, 8.76, 20.03, 30.02, 40.02, 50.02, 60.01, 70.01, 80.01, 90, 95],
  decoy: [9.24, 15.9, 26.25, 36.85, 41.46, 50.45, 56.03, 66.4, 74.81, 83.94, 89.01],
  grenadier: [7.83, 11.66, 23.94, 31.47, 40, 48.96, 58.49, 68.14, 77.96, 87.48, 93.1],
  brawler: [5.03, 10.03, 20.03, 30.02, 40.02, 50.02, 60.01, 70.01, 80.01, 90, 95],
  mainGun: [5.06, 10.19, 19.98, 29.94, 39.99, 50, 59.77, 70.01, 80.03, 90.03, 95.01],
  crossfire: [4.71, 13.03, 24.56, 34.02, 42.46, 50.32, 57.3, 64.56, 73.06, 82.88, 88.68],
};

/** 후보의 누락/잘못된 분포를 운영 기본값으로 채우지 않는다. */
export type RoleReference = {
  metrics: Partial<Record<RoleMetricKey, readonly number[]>>;
  roles: Partial<Record<RoleScoreKey, readonly number[]>>;
};

function validQuantiles(values: readonly number[] | undefined): values is readonly number[] {
  return Array.isArray(values) && values.length === ROLE_REFERENCE_PERCENTILES.length
    && values.every((value,index)=>Number.isFinite(value) && (index===0 || value>=values[index-1]));
}

export function referencePercentile(key: RoleMetricKey, value: number, reference?: RoleReference): number | null {
  const quantiles=reference ? reference.metrics[key] : ROLE_REFERENCE_QUANTILES[key];
  return validQuantiles(quantiles) && Number.isFinite(value) ? percentileFromQuantiles(quantiles,value) : null;
}

export function roleScorePercentile(role: RoleScoreKey, rawScore: number, reference?: RoleReference): number | null {
  const quantiles=reference ? reference.roles[role] : ROLE_SCORE_QUANTILES[role];
  return validQuantiles(quantiles) && Number.isFinite(rawScore) ? percentileFromQuantiles(quantiles,rawScore) : null;
}

/**
 * 값이 기준 분포에서 차지하는 백분위(0~100)를 구한다. quantiles는 ROLE_REFERENCE_PERCENTILES 순서다.
 * 같은 값이 여러 백분위에 걸치면(예: 0이 하위 30%까지) 그 구간의 가운데를 쓴다.
 */
function percentileFromQuantiles(quantiles: readonly number[], value: number): number {
  const levels = ROLE_REFERENCE_PERCENTILES;
  const last = quantiles.length - 1;
  const firstEqual = quantiles.findIndex((q) => q === value);
  if (firstEqual >= 0) {
    let lastEqual = firstEqual;
    while (lastEqual < last && quantiles[lastEqual + 1] === value) lastEqual++;
    const lower = firstEqual === 0 ? 0 : levels[firstEqual];
    const upper = lastEqual === last ? 100 : levels[lastEqual];
    return (lower + upper) / 2;
  }
  if (value < quantiles[0]) return levels[0] / 2;
  if (value > quantiles[last]) return (levels[last] + 100) / 2;
  for (let index = 0; index < last; index++) {
    const low = quantiles[index];
    const high = quantiles[index + 1];
    if (value > low && value < high) {
      return levels[index] + ((value - low) / (high - low)) * (levels[index + 1] - levels[index]);
    }
  }
  return 50;
}
