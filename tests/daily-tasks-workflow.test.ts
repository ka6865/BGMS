 import { describe, it, expect } from "vitest";
 import { readFileSync } from "fs";
 import { join } from "path";
 
 describe("Daily Tasks Workflow Integration", () => {
   it("includes user match sync step in daily-tasks.yml", () => {
     const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
     const content = readFileSync(yamlPath, "utf-8");
     expect(content).toContain("sync_user_matches");
   });
 });
