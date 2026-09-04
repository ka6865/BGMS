import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const VERIFY_SCRIPT_PATH = resolve(ROOT, "scripts/verify_migrations_local.sh");
const PREREQUISITES_PATH = resolve(ROOT, "tests/fixtures/migration-check/prerequisites.sql");
const SCENARIOS_PATH = resolve(ROOT, "tests/fixtures/migration-check/scenarios.sql");
const RECOVERY_MIGRATION = "20260902171741_telemetry_cache_recovery_claim.sql";
const RECOVERY_FINALIZE_MIGRATION = "20260904005531_telemetry_cache_recovery_finalize.sql";
const DUPLICATE_RECOVERY_MIGRATION = "20260903000000_telemetry_cache_recovery_claim.sql";

describe("local migration verification prerequisites", () => {
  it("requires the remote recovery-claim version and rejects its duplicate timestamp", () => {
    const script = readFileSync(VERIFY_SCRIPT_PATH, "utf8");

    expect(script).toContain(`"${RECOVERY_MIGRATION.slice(0, -4)}"`);
    expect(script).not.toContain(`"${DUPLICATE_RECOVERY_MIGRATION.slice(0, -4)}"`);
    expect(existsSync(resolve(ROOT, "supabase/migrations", RECOVERY_MIGRATION))).toBe(true);
    expect(existsSync(resolve(ROOT, "supabase/migrations", RECOVERY_FINALIZE_MIGRATION))).toBe(true);
    expect(existsSync(resolve(ROOT, "supabase/migrations", DUPLICATE_RECOVERY_MIGRATION))).toBe(false);
  });

  it("keeps the recovery migration scenario self-contained and removes the route-only handshake", () => {
    const prerequisites = readFileSync(PREREQUISITES_PATH, "utf8");
    const scenarios = readFileSync(SCENARIOS_PATH, "utf8");

    expect(prerequisites).toContain("public.telemetry_map_cache_entries");
    expect(prerequisites).toContain("lease_token uuid");
    expect(prerequisites).toContain(
      "grant usage on sequence public.telemetry_map_cache_entries_id_seq to service_role;",
    );
    expect(prerequisites).not.toMatch(/grant all on sequence public\.telemetry_map_cache_entries_id_seq/i);
    expect(scenarios).toContain("claim_telemetry_cache_recovery_write");
    expect(scenarios).toContain("finalize_telemetry_cache_recovery");
    expect(existsSync(resolve(ROOT, "app/api/pubg/recovery-health/route.ts"))).toBe(false);
    expect(existsSync(resolve(ROOT, "tests/pubg-recovery-health.test.ts"))).toBe(false);
  });
});
