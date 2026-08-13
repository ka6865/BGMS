 import { describe, it, expect } from "vitest";
import { parseSyncScriptArgs, shouldStopSyncAfterStatus } from "../scripts/sync_user_matches";
 
 describe("Sync Script Runner", () => {
   it("parses limit parameter correctly", () => {
     const args = parseSyncScriptArgs(["--limit", "20"]);
     expect(args.limit).toBe(20);
   });
 
  it("defaults limit to 15 if unprovided", () => {
    const args = parseSyncScriptArgs([]);
    expect(args.limit).toBe(15);
  });

  it("stops the background sync immediately after PUBG API rate limiting", () => {
    expect(shouldStopSyncAfterStatus(429)).toBe(true);
  });

  it("continues past an ordinary player lookup miss", () => {
    expect(shouldStopSyncAfterStatus(404)).toBe(false);
  });
});
