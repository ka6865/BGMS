import { describe, expect, it } from "vitest";
import { isMatchTelemetryExpired } from "@/components/stat/matchExpiryHelper";

describe("Match Expiry Helper", () => {
  it("returns true when playedAt is older than 90 days", () => {
    const now = new Date("2026-08-03T00:00:00.000Z").getTime();
    const oneMillisecondPastExpiry = "2026-05-04T23:59:59.999Z";

    expect(isMatchTelemetryExpired(oneMillisecondPastExpiry, 90, now)).toBe(true);
  });

  it("returns false when playedAt is exactly 90 days old", () => {
    const now = new Date("2026-08-03T00:00:00.000Z").getTime();
    const exactExpiryBoundary = "2026-05-05T00:00:00.000Z";

    expect(isMatchTelemetryExpired(exactExpiryBoundary, 90, now)).toBe(false);
  });
});
