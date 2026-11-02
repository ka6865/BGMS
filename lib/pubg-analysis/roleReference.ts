/**
 * 칭호(역할) 판정용 기준 분포.
 *
 * 산출: scripts/recalibrate_role_reference.ts (운영 DB 읽기 전용, 계산 5 경기만, 전적 요약 라우트와 같은 경로).
 * 표본: 듀오·스쿼드 계산 5 경기 3경기 이상인 플레이어 중 최근 10경기 안에서 점수 상위 5경기(BEST 5)를 판정 입력으로 쓴다.
 * 가중: 검색 사용자(pubg_player_cache.search_count > 0, 명단 밖)의 티어 구간(A·B·C·D) 비율에 맞춘 가중 분포(B')와
 *       무가중 전체를 함께 본다. 분위수는 lib/pubg-analysis/weightedQuantile.ts의 표준 가중 분위수다.
 *
 * ROLE_REFERENCE_VERSION을 올리면 요약 캐시 hash가 바뀐다. 분포를 다시 산출하면 버전과 아래 기록을 함께 갱신한다.
 * 산출 기록: 2026-11-03, 표본 수·구성은 아래 GENERATED 블록 상단 주석과 리포트를 본다.
 *
 * [상단 꼬리] 백분위 100(최댓값)까지 기록해 p95 초과 값이 모두 97.5로 뭉치지 않게 한다.
 *
 * [선제 타격(initiative)] 계산 5 표본으로 산출했으므로 판정 보류를 풀었다. 선제는 시도 5회 이상일 때만 쓴다.
 * [반격 시간(reactionSec)] 보류 지표다. 전적 요약의 반격 시간은 계산 5에서 측정 불가라 판정에 쓰지 않는다.
 */
export const ROLE_REFERENCE_VERSION = 2;

export const ROLE_REFERENCE_PERCENTILES = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100] as const;

export type RoleMetricKey =
  | "initiative" | "reactionSec" | "duelWin" | "reversal" | "longShare" | "shortShare" | "maxHitDist"
  | "rescueRate" | "tradeRate" | "tradeSec" | "pressure" | "placement" | "edgePerMatch" | "earlyShare"
  | "baitPerMatch" | "supportPerMatch" | "utilityHitsPerMatch" | "lethalPerMatch" | "teamDamageShare"
  | "focusFirePerMatch" | "assistShare";

export type RoleScoreKey =
  | "pointMan" | "phantomOverwatch" | "executor" | "shield" | "avenger" | "zoneController" | "dropPredator"
  | "decoy" | "grenadier" | "brawler" | "mainGun" | "crossfire";

// BEGIN GENERATED ROLE REFERENCE TABLES
// 산출 기록: 2026-11-03(한국 시각), 계산 5 듀오·스쿼드, 최근 14일(12시간 창), 최근 10경기 중 점수 상위 5경기로 판정.
// 표본 640명: 무작위 명단 427명, 엘리트 명단 11명, 검색 사용자(search_count>0, 명단 밖) 71명, 기타 131명.
// 검색 사용자 집합: pubg_player_cache.search_count>0 이고 명단에 없는 플레이어. 표본 안의 search_count>0 전체는 129명이다.
// 가중: B' 가중(검색 사용자의 티어 구간 A·B·C·D 비율에 맞춘 가중치, 유효 표본 452), 표준 가중 분위수 보간(lib/pubg-analysis/weightedQuantile.ts).
// 보류: reactionSec(측정 불가라 쓰이지 않음)과 pointMan 복합(반격 시간 보류로 표본 0)은 이전 값을 유지했다. p99·p100은 p95와 같게 채웠다.
// levels: [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100]
export const ROLE_REFERENCE_QUANTILES: Record<RoleMetricKey, readonly number[]> = {
  initiative: [45, 56, 64, 68.981, 73, 78, 81.238, 84.715, 88, 94, 100, 100, 100],
  duelWin: [25, 38, 50, 57, 63, 69, 73, 78, 81, 87, 91, 96, 100],
  reversal: [0, 0, 0, 0, 9, 14, 17, 22, 29, 38, 45.423, 62.3, 67],
  longShare: [0, 0, 0, 2.692, 6.223, 9.579, 12.419, 15.911, 20.34, 28.272, 32.967, 49.977, 67.183],
  shortShare: [18.187, 25.124, 33.649, 39.789, 46.08, 52.233, 58.066, 63.49, 69.888, 84.357, 93.617, 100, 100],
  maxHitDist: [37.91, 66, 139, 201, 247.282, 289.361, 328, 363.874, 406.282, 477.735, 527, 603.091, 814],
  rescueRate: [0, 0, 0, 11.111, 14.286, 20, 25, 28.571, 35.729, 50, 55.556, 86.178, 116.667],
  tradeRate: [0, 0, 0, 0, 0, 6.25, 9.091, 11.765, 15.385, 20, 30, 40, 66.667],
  tradeSec: [1.46, 3.281, 5.393, 7.97, 9.876, 12.363, 14.033, 15.714, 18.556, 22.633, 24.926, 29.223, 29.91],
  pressure: [0.7, 1.05, 1.73, 2.19, 2.62, 3.07, 3.652, 4.154, 4.88, 5.967, 6.493, 7.488, 9.75],
  placement: [27.251, 35.179, 48.656, 58.7, 65.13, 71.4, 76.4, 81.319, 86.663, 93.3, 97.499, 100, 100],
  edgePerMatch: [0, 0.25, 2.065, 4, 5.796, 7.992, 10.333, 12.767, 15.201, 21.317, 25.617, 31.454, 34.4],
  earlyShare: [0, 0, 0, 2.729, 7.318, 11.855, 18.378, 23.526, 32.176, 46.907, 68.495, 100, 100],
  baitPerMatch: [0, 0, 0, 0.333, 0.333, 0.5, 0.667, 0.8, 1, 1.333, 1.667, 2.4, 3.667],
  supportPerMatch: [0, 0, 0, 0, 0.2, 0.333, 0.333, 0.5, 0.75, 1, 1.639, 2.362, 3],
  utilityHitsPerMatch: [0, 0, 0, 0, 0.2, 0.333, 0.333, 0.6, 0.667, 1, 1.6, 2.585, 3.333],
  lethalPerMatch: [0, 0.25, 0.667, 1, 1.333, 1.667, 2, 2.667, 3.333, 4.4, 5.485, 7.362, 9.8],
  teamDamageShare: [10.7, 15.266, 21.3, 25, 28.7, 33.047, 37.532, 41, 47, 56, 66.449, 95.918, 100],
  focusFirePerMatch: [0, 0, 0.667, 1, 1.75, 2.667, 3.667, 4.667, 6, 8.307, 10.14, 14.8, 29.333],
  assistShare: [0, 0, 14.286, 20.784, 25, 32.664, 38.57, 42.857, 50, 66.667, 75, 100, 100],
  reactionSec: [1.043, 1.245, 1.611, 1.911, 2.061, 2.196, 2.364, 2.543, 2.803, 3, 3, 3, 3],
};
export const ROLE_SCORE_QUANTILES: Record<RoleScoreKey, readonly number[]> = {
  pointMan: [12.13, 19.37, 29.11, 36.41, 42.8, 49.65, 56.32, 63.41, 71.18, 80.07, 85.95, 85.95, 85.95],
  phantomOverwatch: [6.25, 10, 15.726, 29.062, 42.603, 50.756, 59.395, 67.406, 75.024, 84.002, 88.831, 94.047, 99.012],
  executor: [8.75, 14.583, 25, 33.776, 40.39, 48.389, 55.4, 65, 75.435, 86.088, 91.027, 97.518, 100],
  shield: [10, 10, 10, 30, 39.999, 50, 60, 70.001, 79.99, 90, 95, 98.582, 100],
  avenger: [20, 20, 20, 20, 20, 37.747, 51.024, 59.495, 68.517, 79.669, 82.563, 90.635, 96.917],
  zoneController: [7.463, 15.285, 28.439, 37.1, 43.434, 50.955, 56.634, 64.117, 72.14, 82, 88.328, 94.325, 96.33],
  dropPredator: [10, 10, 10, 29.99, 40.003, 49.992, 60, 69.999, 79.951, 89.997, 94.963, 99.5, 99.5],
  decoy: [12.5, 12.5, 27.51, 35.01, 42.006, 50.02, 59.006, 65.01, 72.816, 81.916, 90.002, 97.214, 98.552],
  grenadier: [8.75, 12.5, 18.746, 30, 43.997, 53.251, 64.97, 72.795, 81.386, 90.509, 94.796, 99.019, 100],
  brawler: [4.038, 10.006, 20.014, 30, 40, 50, 60.003, 69.989, 79.984, 89.984, 95.002, 99.5, 99.5],
  mainGun: [2.729, 10.013, 20, 30, 40, 49.998, 60.013, 70, 80, 90, 94.987, 99.157, 100],
  crossfire: [5, 10.775, 22.492, 34.317, 42.181, 50, 56.418, 62.643, 70.415, 81.418, 87.213, 96.075, 97.476],
};
// END GENERATED ROLE REFERENCE TABLES

/** 판정이 쓰는 기준 표 묶음. 기본값은 운영 표이고, 재산출·회귀 비교가 다른 표를 넣을 때만 바꾼다. */
export interface RoleReferenceTables {
  levels: readonly number[];
  metrics: Record<RoleMetricKey, readonly number[]>;
  scores: Record<RoleScoreKey, readonly number[]>;
}

export const DEFAULT_ROLE_REFERENCE_TABLES: RoleReferenceTables = {
  levels: ROLE_REFERENCE_PERCENTILES,
  metrics: ROLE_REFERENCE_QUANTILES,
  scores: ROLE_SCORE_QUANTILES,
};

/**
 * 값이 기준 분포에서 차지하는 백분위(0~100)를 구한다. quantiles는 levels 순서다.
 * 같은 값이 여러 백분위에 걸치면(예: 0이 하위 30%까지) 그 구간의 가운데를 쓴다.
 * 기준 최댓값(마지막 level)을 넘는 값은 100을 돌려준다. 기준이 p95에서 끝나던 구버전은 97.5로 뭉쳤다.
 */
export function percentileFromQuantiles(
  quantiles: readonly number[],
  value: number,
  levels: readonly number[] = ROLE_REFERENCE_PERCENTILES,
): number {
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
