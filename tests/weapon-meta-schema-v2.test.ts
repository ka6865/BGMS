import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("weapon meta sample schema", () => {
  it("keeps a patch comparison inside its own pre/post version pair", () => {
    const sql = readFileSync("supabase/migrations/20260812115756_scope_weapon_meta_comparison_to_patch_version.sql", "utf8");

    expect(sql).toContain("s.patch_version = case p.period");
  });
});
