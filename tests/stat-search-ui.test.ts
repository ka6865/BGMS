 import { describe, it, expect } from "vitest";
 import { isMatchTelemetryExpired } from "../components/stat/matchExpiryHelper";
 
 describe("Match Expiry Helper", () => {
   it("returns true when playedAt is older than 90 days", () => {
     const now = new Date("2026-08-03T00:00:00Z").getTime();
     const oldDate = "2026-04-01T00:00:00Z"; // >90 days ago
     expect(isMatchTelemetryExpired(oldDate, 90, now)).toBe(true);
   });
 
   it("returns false when playedAt is within 90 days", () => {
     const now = new Date("2026-08-03T00:00:00Z").getTime();
     const recentDate = "2026-07-15T00:00:00Z"; // ~19 days ago
     expect(isMatchTelemetryExpired(recentDate, 90, now)).toBe(false);
   });
 });
