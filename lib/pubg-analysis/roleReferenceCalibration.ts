/**
 * 칭호 기준 분포 재산출의 순수 계산부.
 *
 * DB 읽기는 scripts/recalibrate_role_reference.ts가 맡고, 여기서는 이미 모은 플레이어 입력으로
 * 가중치, 지표·역할 점수 분위수, 판정 분포 요약만 계산한다. 같은 입력이면 같은 결과가 나온다.
 */
import { metricPercentilesFor, roleMeanPercentiles, classifyRole, extractRoleMetrics, type RoleKey } from "./roleClassifier";
import {
  percentileFromQuantiles,
  ROLE_REFERENCE_PERCENTILES,
  type RoleMetricKey,
  type RoleReferenceTables,
  type RoleScoreKey,
} from "./roleReference";
import { weightedQuantiles, type WeightedSample } from "./weightedQuantile";

export type CalibrationSource = "elite" | "sampled" | "searched" | "other";
export type TierBand = "A" | "B" | "C" | "D";

/** 판정 입력 한 명. stats는 aggregateMatches(BEST 5) 결과다. */
export interface CalibrationPlayer {
  key: string;
  source: CalibrationSource;
  mainMode: string;
  // 최근 10경기 중 점수 상위 5경기의 티어 평균 점수(라우트의 estimateUserTier 입력과 같은 규칙)
  score: number | null;
  stats: any;
}

export const MIN_CALIBRATION_SAMPLES = 30;
const TIER_BAND_MIN_SCORE = { A: 60, B: 36, C: 12 } as const;
export const TIER_BANDS: readonly TierBand[] = ["A", "B", "C", "D"];

export function tierBandOf(score: number | null): TierBand {
  if (score === null || !Number.isFinite(score)) return "D";
  if (score >= TIER_BAND_MIN_SCORE.A) return "A";
  if (score >= TIER_BAND_MIN_SCORE.B) return "B";
  if (score >= TIER_BAND_MIN_SCORE.C) return "C";
  return "D";
}

/** 판정 입력 객체. 라우트의 roleStatsWithDistribution과 같은 규칙으로 만든다(반격 시간 보류, 주 모드). */
export function roleStatsOf(player: CalibrationPlayer): any {
  return { ...player.stats, avgReactionLatency: "측정 불가", modeDistribution: { main: player.mainMode } };
}

export interface CalibrationWeights {
  // 플레이어 순서와 같은 가중치. 검색 사용자 구간 비율을 맞추지 못하는 구간(표본 0)은 0이다.
  weights: number[];
  targetShare: Record<TierBand, number>;
  sampleShare: Record<TierBand, number>;
  effectiveSampleSize: number;
  searchedCount: number;
}

/**
 * B' 가중: 티어 구간별 가중치 = 검색 사용자의 구간 비율 / 표본의 구간 비율.
 * 검색 사용자 표본이 없으면 가중하지 않고 null을 돌려준다.
 */
export function calibrationWeights(players: readonly CalibrationPlayer[]): CalibrationWeights | null {
  const searched = players.filter((player) => player.source === "searched");
  if (searched.length === 0 || players.length === 0) return null;
  const share = (rows: readonly CalibrationPlayer[]) => {
    const counts: Record<TierBand, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const row of rows) counts[tierBandOf(row.score)]++;
    return Object.fromEntries(TIER_BANDS.map((band) => [band, rows.length > 0 ? counts[band] / rows.length : 0])) as Record<TierBand, number>;
  };
  const targetShare = share(searched);
  const sampleShare = share(players);
  const weights = players.map((player) => {
    const band = tierBandOf(player.score);
    return sampleShare[band] > 0 ? targetShare[band] / sampleShare[band] : 0;
  });
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const squares = weights.reduce((total, weight) => total + weight * weight, 0);
  return {
    weights,
    targetShare,
    sampleShare,
    effectiveSampleSize: squares > 0 ? Math.round((sum * sum) / squares) : 0,
    searchedCount: searched.length,
  };
}

/** 가중치 묶음이 없으면 모든 표본을 1로 본다(무가중 전체). */
function sampleWeights(players: readonly CalibrationPlayer[], weights: readonly number[] | null): number[] {
  return weights ? [...weights] : players.map(() => 1);
}

// 표본이 부족한 키는 이전 표를 그대로 쓴다. 이전 표가 없으면 빈 표를 만들지 않고 실패한다.
function requireFallback(values: readonly number[] | undefined, key: string): readonly number[] {
  if (!values) throw new Error(`표본이 부족하고 이전 기준도 없습니다: ${key}`);
  return values;
}

const roundTo = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

export interface CalibrationTableResult<K extends string> {
  // 분위수 배열(levels 순서). 표본이 부족한 키는 fallback 값을 그대로 쓴다.
  quantiles: Record<K, readonly number[]>;
  // 키별 사용 표본 수와 출처(computed | fallback)
  coverage: Record<K, { samples: number; source: "computed" | "fallback" }>;
}

const METRIC_KEYS = [
  "initiative", "duelWin", "reversal", "longShare", "shortShare", "maxHitDist", "rescueRate", "tradeRate", "tradeSec",
  "pressure", "placement", "edgePerMatch", "earlyShare", "baitPerMatch", "supportPerMatch", "utilityHitsPerMatch",
  "lethalPerMatch", "teamDamageShare", "focusFirePerMatch", "assistShare",
] as const satisfies readonly RoleMetricKey[];

const SCORE_KEYS = [
  "pointMan", "phantomOverwatch", "executor", "shield", "avenger", "zoneController", "dropPredator",
  "decoy", "grenadier", "brawler", "mainGun", "crossfire",
] as const satisfies readonly RoleScoreKey[];

/**
 * 지표별 분위수. reactionSec은 보류 지표라 항상 fallback을 쓴다.
 * weights가 null이면 무가중, 있으면 가중 분위수다.
 */
export function buildMetricTables(
  players: readonly CalibrationPlayer[],
  weights: readonly number[] | null,
  fallback: Partial<Record<RoleMetricKey, readonly number[]>>,
  levels: readonly number[] = ROLE_REFERENCE_PERCENTILES,
): CalibrationTableResult<RoleMetricKey> {
  const w = sampleWeights(players, weights);
  const quantiles = {} as Record<RoleMetricKey, readonly number[]>;
  const coverage = {} as Record<RoleMetricKey, { samples: number; source: "computed" | "fallback" }>;
  for (const key of [...METRIC_KEYS, "reactionSec" as const]) {
    const samples: WeightedSample[] = [];
    if (key !== "reactionSec") {
      players.forEach((player, index) => {
        const value = extractRoleMetrics(roleStatsOf(player))[key];
        if (typeof value === "number" && Number.isFinite(value)) samples.push([value, w[index]]);
      });
    }
    const usable = samples.filter(([, weight]) => weight > 0);
    if (key === "reactionSec" || usable.length < MIN_CALIBRATION_SAMPLES) {
      quantiles[key] = requireFallback(fallback[key], key);
      coverage[key] = { samples: usable.length, source: "fallback" };
      continue;
    }
    quantiles[key] = weightedQuantiles(usable, levels).map((value) => roundTo(value!));
    coverage[key] = { samples: usable.length, source: "computed" };
  }
  return { quantiles, coverage };
}

/**
 * 역할 점수 분위수. 각 플레이어의 지표 백분위(metricTables 기준)의 역할별 평균을 표본으로 쓴다.
 * 판정과 같은 규칙으로 기회가 부족한 역할은 빼고, 보류 지표는 pendingReferenceMetrics로 뺀다.
 */
export function buildScoreTables(
  players: readonly CalibrationPlayer[],
  weights: readonly number[] | null,
  metricTables: RoleReferenceTables,
  fallback: Partial<Record<RoleScoreKey, readonly number[]>>,
  pendingReferenceMetrics: readonly RoleMetricKey[] = ["reactionSec"],
): CalibrationTableResult<RoleScoreKey> {
  const w = sampleWeights(players, weights);
  const means = players.map((player) => roleMeanPercentiles(metricPercentilesFor(roleStatsOf(player), pendingReferenceMetrics, metricTables)));
  const quantiles = {} as Record<RoleScoreKey, readonly number[]>;
  const coverage = {} as Record<RoleScoreKey, { samples: number; source: "computed" | "fallback" }>;
  for (const role of SCORE_KEYS) {
    const samples: WeightedSample[] = [];
    means.forEach((mean, index) => {
      const value = mean[role];
      if (value !== null && w[index] > 0) samples.push([value, w[index]]);
    });
    if (samples.length < MIN_CALIBRATION_SAMPLES) {
      quantiles[role] = requireFallback(fallback[role], role);
      coverage[role] = { samples: samples.length, source: "fallback" };
      continue;
    }
    quantiles[role] = weightedQuantiles(samples, metricTables.levels).map((value) => roundTo(value!));
    coverage[role] = { samples: samples.length, source: "computed" };
  }
  return { quantiles, coverage };
}

export interface RoleDistributionSummary {
  population: string;
  // 판정 표본 수(가중이면 가중 합)
  total: number;
  confirmed: number;
  belowThreshold: number;
  insufficient: number;
  confirmedRate: number;
  // 칭호(화면 제목) 별 확정 비율. 조합 칭호는 조합 이름으로 센다.
  byTitle: Record<string, number>;
  // 대표 역할 키별 확정 비율
  byPrimaryRole: Record<string, number>;
  maxTitleShare: { title: string; share: number } | null;
  maxRoleShare: { role: string; share: number } | null;
  fieldCommander: number;
  // 최고 역할 점수가 2위와 원점수까지 같은 확정·보류자 수(정렬 규칙으로 정해진 동점은 0이어야 한다)
  tiedTop: number;
  // 티어 구간별 확정 비율(해당 구간 가중 합 기준)
  confirmedRateByBand: Record<TierBand, number | null>;
}

export interface EvaluateOptions {
  pendingReferenceMetrics: readonly RoleMetricKey[];
  tables: RoleReferenceTables;
  weights: readonly number[] | null;
  filter?: (player: CalibrationPlayer) => boolean;
  population: string;
}

/** 표본 전체를 classifyRole로 판정하고 분포를 요약한다. 가중치가 있으면 판정 비율을 가중 합으로 계산한다. */
export function evaluateRoleReference(players: readonly CalibrationPlayer[], options: EvaluateOptions): RoleDistributionSummary {
  const rows = players
    .map((player, index) => ({ player, weight: options.weights ? options.weights[index] : 1 }))
    .filter(({ player, weight }) => weight > 0 && (!options.filter || options.filter(player)));
  let total = 0, confirmed = 0, belowThreshold = 0, insufficient = 0, fieldCommander = 0, tiedTop = 0;
  const byTitle: Record<string, number> = {};
  const byPrimaryRole: Record<string, number> = {};
  const bandTotal: Record<TierBand, number> = { A: 0, B: 0, C: 0, D: 0 };
  const bandConfirmed: Record<TierBand, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const { player, weight } of rows) {
    const info = classifyRole(roleStatsOf(player), null, "C", {
      pendingReferenceMetrics: options.pendingReferenceMetrics,
      referenceTables: options.tables,
    });
    const band = tierBandOf(player.score);
    total += weight;
    bandTotal[band] += weight;
    if (info.verdict.kind === "confirmed") {
      confirmed += weight;
      bandConfirmed[band] += weight;
      byTitle[info.title] = (byTitle[info.title] ?? 0) + weight;
      const key = String(info.primaryRole);
      byPrimaryRole[key] = (byPrimaryRole[key] ?? 0) + weight;
      if (info.primaryRole === "fieldCommander") fieldCommander += weight;
    } else if (info.verdict.kind === "below_threshold") belowThreshold += weight;
    else insufficient += weight;
    if (info.verdict.kind !== "insufficient" && isTiedTop(options.tables, player, options.pendingReferenceMetrics)) tiedTop += weight;
  }
  const share = (count: number) => (total > 0 ? roundTo(count / total, 4) : 0);
  const topOf = (map: Record<string, number>) => {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return entries.length > 0 ? { name: entries[0][0], share: share(entries[0][1]) } : null;
  };
  const titleTop = topOf(byTitle);
  const roleTop = topOf(byPrimaryRole);
  return {
    population: options.population,
    total: roundTo(total, 2),
    confirmed: roundTo(confirmed, 2),
    belowThreshold: roundTo(belowThreshold, 2),
    insufficient: roundTo(insufficient, 2),
    confirmedRate: share(confirmed),
    byTitle: Object.fromEntries(Object.entries(byTitle).map(([title, count]) => [title, share(count)])),
    byPrimaryRole: Object.fromEntries(Object.entries(byPrimaryRole).map(([role, count]) => [role, share(count)])),
    maxTitleShare: titleTop ? { title: titleTop.name, share: titleTop.share } : null,
    maxRoleShare: roleTop ? { role: roleTop.name, share: roleTop.share } : null,
    fieldCommander: share(fieldCommander),
    tiedTop: roundTo(tiedTop, 2),
    confirmedRateByBand: Object.fromEntries(
      TIER_BANDS.map((band) => [band, bandTotal[band] > 0 ? roundTo(bandConfirmed[band] / bandTotal[band], 4) : null]),
    ) as Record<TierBand, number | null>,
  };
}

/** 판정 순서의 1위와 2위가 역할 점수·지표 평균까지 같은지 본다(정렬 규칙이 깨는 진짜 동점). */
function isTiedTop(
  tables: RoleReferenceTables,
  player: CalibrationPlayer,
  pendingReferenceMetrics: readonly RoleMetricKey[],
): boolean {
  const means = roleMeanPercentiles(metricPercentilesFor(roleStatsOf(player), pendingReferenceMetrics, tables));
  const ranked = (Object.entries(means) as Array<[RoleKey, number | null]>)
    .filter((entry): entry is [RoleKey, number] => entry[1] !== null)
    .map(([role, mean]) => ({ role, mean, score: percentileFromQuantiles(tables.scores[role as RoleScoreKey], mean, tables.levels) }))
    .sort((a, b) => b.score - a.score || b.mean - a.mean);
  return ranked.length >= 2 && ranked[0].score === ranked[1].score && ranked[0].mean === ranked[1].mean;
}

/** 검색 사용자 지표 중앙값이 기준 표에서 몇 백분위인지. 표가 바뀌어도 의미가 같은지 확인하는 데 쓴다. */
export function searchedMedianPercentiles(
  players: readonly CalibrationPlayer[],
  tables: RoleReferenceTables,
): Record<string, { median: number; percentile: number; samples: number }> {
  const searched = players.filter((player) => player.source === "searched");
  const result: Record<string, { median: number; percentile: number; samples: number }> = {};
  for (const key of METRIC_KEYS) {
    const values = searched
      .map((player) => extractRoleMetrics(roleStatsOf(player))[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .sort((a, b) => a - b);
    if (values.length < 20) continue;
    const mid = Math.floor((values.length - 1) / 2);
    const median = values.length % 2 === 1 ? values[mid] : (values[mid] + values[mid + 1]) / 2;
    result[key] = {
      median: roundTo(median, 3),
      percentile: roundTo(percentileFromQuantiles(tables.metrics[key], median, tables.levels), 1),
      samples: values.length,
    };
  }
  return result;
}
