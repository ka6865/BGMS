import { describe, it, expect } from "vitest";
import { GET } from "../app/api/pubg/meta/route";

describe("GET /api/pubg/meta", () => {
  it("does not present example numbers as real data when collection is unavailable", async () => {
    const res = await GET();
    const json = await res.json();

    expect(json.weapons).toEqual([]);
    expect(json.status).toBe("not_configured");
  });

  it("exports the minimum burst sample threshold used to withhold sparse comparisons", async () => {
    const routeExports = await import("../app/api/pubg/meta/route");
    expect(routeExports.BURST_COMPARISON_MIN_MATCHES).toBe(20);
  });
});
