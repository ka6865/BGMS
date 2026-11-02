import { describe, expect, it } from "vitest";
import { wilsonLowerBound } from "@/lib/pubg-analysis/roleClassifier";

describe("wilson lower bound for initiative rates", () => {
  it("returns null without trials", () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
  });

  it("pulls a small perfect sample well below 100 and keeps a large one close to 100", () => {
    expect(wilsonLowerBound(5, 5)).toBeCloseTo(56.5, 0);
    expect(wilsonLowerBound(100, 100)).toBeCloseTo(96.3, 0);
    expect(wilsonLowerBound(0, 5)).toBe(0);
  });

  it("increases with successes at a fixed number of trials and stays within 0 to 100", () => {
    const values = [0, 1, 2, 3, 4, 5].map((successes) => wilsonLowerBound(successes, 5) as number);
    for (let index = 1; index < values.length; index++) expect(values[index]).toBeGreaterThan(values[index - 1]);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("clamps impossible counts instead of returning values outside the range", () => {
    expect(wilsonLowerBound(9, 5)).toBe(wilsonLowerBound(5, 5));
    expect(wilsonLowerBound(-2, 5)).toBe(wilsonLowerBound(0, 5));
  });
});
