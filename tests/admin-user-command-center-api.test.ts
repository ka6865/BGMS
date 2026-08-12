import { describe, expect, it } from "vitest";

describe("GET /api/admin/users command center extension", () => {
  it("exports GET function", async () => {
    const route = await import("@/app/api/admin/users/route");
    expect(route.GET).toBeDefined();
  });
});
