import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("legacy-copy Node CLI startup", () => {
  it("loads in plain Node and rejects missing options without server-only or credentials", () => {
    const result = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/verify_legacy_match_copies.ts")], {
      encoding: "utf8", timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toEqual({ errorCode: "live-copy-options-invalid" });
  });
});
