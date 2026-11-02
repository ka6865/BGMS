import { describe, expect, it } from "vitest";
import { weightedQuantile, weightedQuantiles } from "@/lib/pubg-analysis/weightedQuantile";

describe("weighted quantile", () => {
  it("returns null when no positive finite weight sample exists", () => {
    expect(weightedQuantile([], 50)).toBeNull();
    expect(weightedQuantile([[1, 0], [2, -1], [Number.NaN, 1]], 50)).toBeNull();
  });

  it("matches the midpoint interpolation for equal weights", () => {
    // n=4 표본의 중점 위치는 (i + 0.5) / 4 이다. 중앙값은 2와 3의 가운데다.
    const samples = [[1, 1], [2, 1], [3, 1], [4, 1]] as const;
    expect(weightedQuantile(samples, 50)).toBeCloseTo(2.5, 10);
    expect(weightedQuantile(samples, 12.5)).toBeCloseTo(1, 10);
    expect(weightedQuantile(samples, 0)).toBe(1);
    expect(weightedQuantile(samples, 100)).toBe(4);
  });

  it("gives a heavier sample proportionally more pull on the quantile", () => {
    const light = weightedQuantile([[10, 1], [20, 1]], 50);
    const heavy = weightedQuantile([[10, 1], [20, 3]], 50);
    expect(light).toBeCloseTo(15, 10);
    expect(heavy).toBeGreaterThan(light!);
    // 위치는 10이 0.125, 20이 0.625다. 중앙 0.5는 두 위치 사이 75% 지점이라 17.5다.
    expect(heavy).toBeCloseTo(17.5, 10);
  });

  it("is monotone in the percentile and ignores zero-weight samples", () => {
    const samples = [[5, 2], [1, 0], [3, 1], [9, 4]] as const;
    const levels = [5, 25, 50, 75, 95, 99, 100];
    const values = weightedQuantiles(samples, levels) as number[];
    for (let index = 1; index < values.length; index++) expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    expect(values[0]).toBe(3);
    expect(values[values.length - 1]).toBe(9);
  });

  it("is reproducible regardless of input order", () => {
    const a = [[3, 1], [1, 2], [2, 1.5]] as const;
    const b = [[2, 1.5], [3, 1], [1, 2]] as const;
    expect(weightedQuantiles(a, [10, 50, 90])).toEqual(weightedQuantiles(b, [10, 50, 90]));
  });
});
