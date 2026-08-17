import { describe, it, expect } from "vitest";
import { isSyncEligible } from "../lib/pubg/userSyncHelper";
import { writeRateLimitOutput } from "../scripts/sync_user_matches";
 
 describe("userSyncHelper", () => {
   it("returns true if updated_at is older than 10 days", () => {
     const tenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString();
     expect(isSyncEligible(tenDaysAgo, 10)).toBe(true);
   });
 
   it("returns false if updated_at is within 10 days", () => {
     const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
     expect(isSyncEligible(recent, 10)).toBe(false);
   });
 
  it("returns true if updated_at is null or undefined", () => {
    expect(isSyncEligible(null)).toBe(true);
    expect(isSyncEligible(undefined)).toBe(true);
  });

  it("429 상태를 GitHub step output으로 기록한다", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "bgms-sync-output-"));
    const outputPath = join(directory, "github-output");

    writeRateLimitOutput(true, outputPath);

    await expect(readFile(outputPath, "utf8")).resolves.toBe("rate_limited=true\n");
  });
});
