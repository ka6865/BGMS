import { describe, expect, it } from "vitest";
import {
  isMatchOlderThan14Days,
  isMatchTelemetryExpired,
} from "@/components/stat/matchExpiryHelper";

describe("Match Expiry Helper", () => {
  const now = new Date("2026-08-10T00:00:00.000Z").getTime();

  it("14일 exact cutoff은 보존하고 1ms 이전만 만료한다", () => {
    expect(isMatchOlderThan14Days("2026-07-27T00:00:00.000Z", now)).toBe(false);
    expect(isMatchOlderThan14Days("2026-07-26T23:59:59.999Z", now)).toBe(true);
  });

  it("90일 exact cutoff은 보존하고 1ms 이전만 만료한다", () => {
    expect(isMatchTelemetryExpired("2026-05-12T00:00:00.000Z", 90, now)).toBe(false);
    expect(isMatchTelemetryExpired("2026-05-11T23:59:59.999Z", 90, now)).toBe(true);
  });
});
