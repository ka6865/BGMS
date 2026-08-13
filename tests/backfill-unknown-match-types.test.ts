import { describe, expect, it } from "vitest";
import { getUnknownMatchTypeBackfillDisposition, parseUnknownMatchTypeBackfillArgs, shouldStopUnknownMatchTypeBackfill } from "../scripts/backfill_unknown_match_types";

describe("unknown match type backfill runner", () => {
  it("defaults to a five-minute, rate-safe daily batch", () => {
    expect(parseUnknownMatchTypeBackfillArgs([])).toEqual({ limit: 300, delayMs: 1_000 });
  });

  it("accepts a smaller manual batch without reducing the request spacing", () => {
    expect(parseUnknownMatchTypeBackfillArgs(["--limit", "20"])).toEqual({ limit: 20, delayMs: 1_000 });
  });

  it("stops immediately when PUBG signals rate limiting", () => {
    expect(shouldStopUnknownMatchTypeBackfill(429)).toBe(true);
    expect(shouldStopUnknownMatchTypeBackfill(500)).toBe(false);
  });

  it("removes permanently unavailable matches from the retry queue", () => {
    expect(getUnknownMatchTypeBackfillDisposition(404, false)).toBe("unavailable");
    expect(getUnknownMatchTypeBackfillDisposition(429, false)).toBe("rate_limited");
    expect(getUnknownMatchTypeBackfillDisposition(500, false)).toBe("retry");
    expect(getUnknownMatchTypeBackfillDisposition(200, true)).toBe("updated");
  });
});
