 import { describe, it, expect } from "vitest";
 import { isSyncEligible } from "../lib/pubg/userSyncHelper";
 
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
 });
