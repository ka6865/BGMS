import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("weapon_meta_snapshots migration schema test", () => {
  it("schema migration contains required columns and unique constraint", () => {
    const sql = readFileSync("supabase/migrations/20260812000000_weapon_meta_snapshots.sql", "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.weapon_meta_snapshots");
    expect(sql).toContain("uq_weapon_meta_snapshot UNIQUE (patch_version, snapshot_date, weapon_name)");
    expect(sql).toContain("sustained_hits integer");
  });
});
