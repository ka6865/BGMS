 import { describe, it, expect } from "vitest";
 import { readFileSync } from "fs";
 import { join } from "path";
 
 describe("pubg_player_matches Migration Schema", () => {
   it("should contain correct DDL for pubg_player_matches and index", () => {
     const migrationPath = join(process.cwd(), "supabase/migrations/20260803100000_pubg_player_matches.sql");
     const sql = readFileSync(migrationPath, "utf-8");
     expect(sql).toContain("CREATE TABLE IF NOT EXISTS pubg_player_matches");
     expect(sql).toContain("player_id VARCHAR(64) NOT NULL");
     expect(sql).toContain("PRIMARY KEY (player_id, platform, match_id)");
     expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_pubg_player_matches_pagination");
   });
 });
