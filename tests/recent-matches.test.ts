import { describe, expect, it } from "vitest";
import { mergeRecentMatchIds, normalizeRecentMatchIds } from "@/lib/pubg/recentMatches";

describe("recent match ID boundary", () => {
  it("canonicalizes shard aliases, drops invalid IDs, and preserves first-seen order", () => {
    expect(normalizeRecentMatchIds([
      "shard:newest",
      "newest",
      " ",
      null,
      "older",
      "shard:older",
    ], 3)).toEqual(["newest", "older"]);
  });

  it("applies the 20-match limit after canonical dedupe so aliases do not consume slots", () => {
    const apiIds = ["shard:first", "first", ...Array.from({ length: 20 }, (_, index) => `api-${index}`)];
    const merged = mergeRecentMatchIds(apiIds, ["cached-after-limit"]);

    expect(merged).toHaveLength(20);
    expect(merged.slice(0, 3)).toEqual(["first", "api-0", "api-1"]);
    expect(merged.at(-1)).toBe("api-18");
    expect(merged).not.toContain("cached-after-limit");
  });
});
