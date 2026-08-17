 import { describe, it, expect } from "vitest";
 import { readFileSync } from "fs";
 import { join } from "path";
 
 describe("Daily Tasks Workflow Integration", () => {
  it("includes user match sync step in daily-tasks.yml", () => {
     const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
     const content = readFileSync(yamlPath, "utf-8");
    expect(content).toContain("sync_user_matches");
  });

  it("runs the benchmark scraper before the lower-priority user match sync", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content.indexOf("- name: Run Smart Scraper")).toBeLessThan(
      content.indexOf("- name: Run User Matches Sync"),
    );
  });

  it("runs match type backfill in a separate job after all normal maintenance", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content).toContain("match-type-backfill:");
    expect(content).toContain("needs: [board-write-quota-cleanup, maintenance]");
    expect(content).toContain("backfill_unknown_match_types.ts --limit 300");
  });

  it("runs the backfill when the database health gate passes even if another maintenance step fails", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content).toContain("outputs:");
    expect(content).toContain("database_health: ${{ steps.database_health.outcome }}");
    expect(content).toContain(
      "needs.maintenance.outputs.database_health == 'success'",
    );
    expect(content).not.toContain(
      "needs.board-write-quota-cleanup.result == 'success' && needs.maintenance.outputs.database_health == 'success'",
    );
    expect(content).toContain("MATCH_TYPE_BACKFILL_RESULT");
  });

  it("stops the lower-priority hotdrop step after sync detects a PUBG API rate limit", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content).toContain("id: sync_user_matches");
    expect(content).toContain("pubg_rate_limited: ${{ steps.sync_user_matches.outputs.rate_limited }}");
    expect(content).toContain("Skip Hotdrop After PUBG API Rate Limit");
    expect(content).toContain("steps.sync_user_matches.outputs.rate_limited == 'true'");
    expect(content).toContain("steps.sync_user_matches.outputs.rate_limited != 'true'");
  });
});
