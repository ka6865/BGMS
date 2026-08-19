import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("sync runner type layering", () => {
  it("keeps shared runner contracts in lib instead of importing the script from a library boundary", () => {
    const boundaries = readFileSync(resolve("lib/pubg/syncRunnerBoundaries.ts"), "utf8");
    const sharedTypes = readFileSync(resolve("lib/pubg/syncRunnerTypes.ts"), "utf8");

    expect(boundaries).not.toContain("scripts/sync_user_matches");
    expect(sharedTypes).toContain("export type SyncRunSummary");
    expect(sharedTypes).toContain("export type SyncRunnerDependencies");
  });
});
