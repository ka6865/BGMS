import { describe, expect, it } from "vitest";

describe("AdminUserCommandCenter UI Component", () => {
  it("exports AdminUserCommandCenter component", async () => {
    const mod = await import("@/components/admin/AdminUserCommandCenter");
    expect(mod.AdminUserCommandCenter).toBeDefined();
  });
});
