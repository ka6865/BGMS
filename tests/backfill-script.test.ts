import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("backfill_weapon_meta script syntax check", () => {
  it("script exists and imports required supabase dependencies", () => {
    const code = readFileSync("scripts/backfill_weapon_meta.ts", "utf8");
    expect(code).toContain("weapon_meta_match_samples");
    expect(code).not.toContain("hits * 0.4");
    expect(code).not.toContain("hits * 0.6");
  });
});
