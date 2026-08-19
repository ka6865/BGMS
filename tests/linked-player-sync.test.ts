import { describe, expect, it } from "vitest";
import {
  buildPlayerRefreshLockKey,
  getLinkedPlayerSyncBackoffMs,
  getLinkedPlayerSyncNextEligibleAt,
} from "@/lib/pubg/linkedPlayerSync";

describe("linked player sync policy", () => {
  it("uses the documented transient-failure backoff schedule", () => {
    expect(getLinkedPlayerSyncBackoffMs(1)).toBe(60 * 60 * 1000);
    expect(getLinkedPlayerSyncBackoffMs(2)).toBe(6 * 60 * 60 * 1000);
    expect(getLinkedPlayerSyncBackoffMs(3)).toBe(24 * 60 * 60 * 1000);
    expect(getLinkedPlayerSyncBackoffMs(99)).toBe(24 * 60 * 60 * 1000);
  });

  it("maps outcomes to the documented next eligible timestamps", () => {
    const nowMs = Date.parse("2026-08-19T00:00:00.000Z");

    expect(getLinkedPlayerSyncNextEligibleAt({ status: "success", consecutiveFailures: 0 }, nowMs))
      .toBe("2026-08-20T00:00:00.000Z");
    expect(getLinkedPlayerSyncNextEligibleAt({ status: "invalid_nickname", consecutiveFailures: 1 }, nowMs))
      .toBe("2026-08-26T00:00:00.000Z");
    expect(getLinkedPlayerSyncNextEligibleAt({ status: "failed", consecutiveFailures: 2 }, nowMs))
      .toBe("2026-08-19T06:00:00.000Z");
    expect(getLinkedPlayerSyncNextEligibleAt({ status: "rate_limited", consecutiveFailures: 1 }, nowMs))
      .toBe("2026-08-19T01:00:00.000Z");
    expect(getLinkedPlayerSyncNextEligibleAt({
      status: "rate_limited",
      rateLimitResetAt: "2026-08-19T02:30:00.000Z",
    }, nowMs)).toBe("2026-08-19T02:30:00.000Z");
  });

  it("builds one season-independent lock key for a player identity", () => {
    expect(buildPlayerRefreshLockKey("STEAM", "Fixture_Player"))
      .toBe("refresh:steam:fixture_player");
    expect(buildPlayerRefreshLockKey(" Kakao ", " Fixture_Player "))
      .toBe("refresh:kakao:fixture_player");
  });
});
