/**
 * 가중 분위수(표준 누적 가중치 보간).
 *
 * 각 표본 i의 위치를 (누적 가중치 - 자기 가중치 / 2) / 전체 가중치로 잡고, 목표 분위가 두 위치 사이에 있으면
 * 두 값을 선형으로 잇는다. 가중치가 모두 1이면 중점 위치 (i + 0.5) / n 을 쓰는 표준 보간과 같다.
 * 목표 분위가 가장 낮은 위치보다 아래거나 가장 높은 위치보다 위면 끝 값을 쓴다. 가중치가 0 이하이거나
 * 값이 유한하지 않은 표본은 버린다. 같은 입력이면 항상 같은 결과를 낸다(재산출 재현용).
 */

export type WeightedSample = readonly [value: number, weight: number];

export function weightedQuantile(samples: readonly WeightedSample[], percentile: number): number | null {
  const sorted = samples
    .filter(([value, weight]) => Number.isFinite(value) && Number.isFinite(weight) && weight > 0)
    .map(([value, weight]) => [value, weight] as const)
    .sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return null;
  const total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  const positions: number[] = [];
  let cumulative = 0;
  for (const [, weight] of sorted) {
    positions.push((cumulative + weight / 2) / total);
    cumulative += weight;
  }
  const target = Math.min(1, Math.max(0, percentile / 100));
  const last = sorted.length - 1;
  if (target <= positions[0]) return sorted[0][0];
  if (target >= positions[last]) return sorted[last][0];
  for (let index = 0; index < last; index++) {
    const low = positions[index];
    const high = positions[index + 1];
    if (target >= low && target <= high) {
      const ratio = high > low ? (target - low) / (high - low) : 0;
      return sorted[index][0] + ratio * (sorted[index + 1][0] - sorted[index][0]);
    }
  }
  return sorted[last][0];
}

/** 여러 백분위를 한 번에 구한다. 결과는 percentiles 순서와 같다. 표본이 없으면 null 배열이다. */
export function weightedQuantiles(samples: readonly WeightedSample[], percentiles: readonly number[]): Array<number | null> {
  return percentiles.map((percentile) => weightedQuantile(samples, percentile));
}
