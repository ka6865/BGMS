import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { buildScopePickShares, GET } from "../app/api/pubg/meta/route";

describe("GET /api/pubg/meta", () => {
  it("does not present example numbers as real data when collection is unavailable", async () => {
    const res = await GET(new NextRequest("http://localhost/api/pubg/meta"));
    const json = await res.json();

    expect(json.weapons).toEqual([]);
    expect(json.status).toBe("not_configured");
  });

  it("exports the minimum burst sample threshold used to withhold sparse comparisons", async () => {
    const routeExports = await import("../app/api/pubg/meta/route");
    expect(routeExports.BURST_COMPARISON_MIN_MATCHES).toBe(20);
  });

  it("uses every analyzed match as the category adoption denominator", () => {
    const shares = buildScopePickShares([
      { played_at: "2026-08-12T01:00:00Z", match_id: "a", platform: "steam", player_id: "one", weapon_category: "LMG", active_pick: true },
      { played_at: "2026-08-12T01:00:00Z", match_id: "b", platform: "steam", player_id: "two", weapon_category: "AR", active_pick: true },
    ], "2026-08-12T00:00:00Z");

    expect(shares.find((share) => share.weapon_category === "LMG" && share.period === "post")).toMatchObject({ player_match_count: 2, weapon_pick_count: 1 });
  });
});
