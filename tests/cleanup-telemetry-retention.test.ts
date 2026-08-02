 import { describe, it, expect } from "vitest";
 import { getTelemetryRetentionDays } from "../scripts/cleanup_telemetry";
 
 describe("Telemetry Cleanup Retention Config", () => {
   it("defaults retention days to 90 if env is unset", () => {
     const retentionDays = getTelemetryRetentionDays({});
     expect(retentionDays).toBe(90);
   });
 
   it("uses process.env value when CLEANUP_RETENTION_DAYS is provided", () => {
     const retentionDays = getTelemetryRetentionDays({ CLEANUP_RETENTION_DAYS: "60" });
     expect(retentionDays).toBe(60);
   });
 
   it("falls back to 90 if provided env value is invalid or zero", () => {
     const retentionDays = getTelemetryRetentionDays({ CLEANUP_RETENTION_DAYS: "invalid" });
     expect(retentionDays).toBe(90);
   });
 });
