import { describe, expect, it } from "vitest";
import { buildStatsCompareUrl, buildStatsWeaponsUrl } from "@/lib/stats/statsPageModel";

describe("stats search navigation", () => {
  it("preserves platform in comparison navigation and encodes the nickname", () => {
    expect(buildStatsCompareUrl("Fixture Player", "kakao"))
      .toBe("/stats/battle?nick1=Fixture%20Player&platform1=kakao");
  });

  it("builds the platform-scoped weapons page URL", () => {
    expect(buildStatsWeaponsUrl("Fixture Player", "steam"))
      .toBe("/stats/steam/Fixture%20Player/weapons");
  });
});
