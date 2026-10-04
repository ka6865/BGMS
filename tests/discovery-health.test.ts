import { describe, expect, it } from "vitest";
import { discoveryHealthWarnings } from "../lib/pubg/discoveryHealth";
import { discoveryHealthMarkdown } from "../scripts/check_match_discovery_health";

describe("discovery health warnings", () => {
  it("distinguishes an old backlog from a worker that is not progressing", () => {
    expect(discoveryHealthWarnings({ readyCount: 100, oldestReadyAgeMinutes: 1500, minutesSinceLastSaved: 5, expiredLeaseCount: 0 })).toEqual(["backlog_older_than_24h"]);
    expect(discoveryHealthWarnings({ readyCount: 100, oldestReadyAgeMinutes: 60, minutesSinceLastSaved: 180, expiredLeaseCount: 1 })).toEqual(["no_collection_progress_for_2h", "expired_collection_leases"]);
  });
  it("does not warn about idle workers when the queue is empty", () => {
    expect(discoveryHealthWarnings({ readyCount: 0, oldestReadyAgeMinutes: null, minutesSinceLastSaved: null, expiredLeaseCount: 0 })).toEqual([]);
  });
  it("reports only aggregate counts and no account identifiers", () => {
    const text = discoveryHealthMarkdown({ measuredAt: "2026-10-05T00:00:00Z", atomic: false, states: { pending: 5, retry: 0, running: 0, saved: 2, unavailable: 1 }, readyCount: 5, expiredLeaseCount: 0, oldestReadyFirstSeenAt: null, lastSavedAt: null, oldestReadyAgeMinutes: null, minutesSinceLastSaved: null, warnings: [] }, "after");
    expect(text).toContain("수집 후"); expect(text).toContain("| pending | 5 |"); expect(text).not.toContain("account.");
  });
});
