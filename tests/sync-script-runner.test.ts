 import { describe, it, expect } from "vitest";
 import { parseSyncScriptArgs } from "../scripts/sync_user_matches";
 
 describe("Sync Script Runner", () => {
   it("parses limit parameter correctly", () => {
     const args = parseSyncScriptArgs(["--limit", "20"]);
     expect(args.limit).toBe(20);
   });
 
   it("defaults limit to 15 if unprovided", () => {
     const args = parseSyncScriptArgs([]);
     expect(args.limit).toBe(15);
   });
 });
