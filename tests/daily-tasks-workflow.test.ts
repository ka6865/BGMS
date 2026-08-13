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
});
