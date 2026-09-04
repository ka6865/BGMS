import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLAIM_MIGRATION = resolve(
  "supabase/migrations/20260904130000_telemetry_cache_recovery_safety.sql",
);
const FINALIZER_MIGRATION = resolve(
  "supabase/migrations/20260904130000_telemetry_cache_recovery_safety.sql",
);
const ROUTE_SOURCE = resolve("app/api/pubg/match/route.ts");
const REGISTRY_SOURCE = resolve("lib/pubg-analysis/telemetryRegistry.server.ts");
const CANARY_SOURCE = resolve("scripts/run_benchmark_recovery_canary.ts");

describe("release blocker contracts", () => {
  it("recovery claim validates the canonical v61 identity, key shape, and live lease", () => {
    const source = readFileSync(CLAIM_MIGRATION, "utf8");

    expect(source).toContain("p_telemetry_version is distinct from 61");
    expect(source).toContain("p_match_id !~ '^[A-Za-z0-9._-]{1,160}$'");
    expect(source).toContain("p_player_id !~ '^[A-Za-z0-9._:-]{1,200}$'");
    expect(source).toContain("telemetry-map/v61/");
    expect(source).toContain("p_lease_expires_at <= now()");
  });

  it("recovery finalizer rejects expired leases, negative filters, and master races", () => {
    const source = readFileSync(FINALIZER_MIGRATION, "utf8");

    expect(source).toContain("cache.lease_expires_at > now()");
    expect(source).toContain("v_benchmark_filter_version < 0");
    expect(source).toContain("master_guard_mismatch");
    expect(source).toContain("v_existing_master.telemetry_version > v_master.telemetry_version");
    expect(source).toContain("v_existing_master.telemetry_version < v_master.telemetry_version");
    expect(source).not.toMatch(/on conflict \(match_id\)\s+do update[\s\S]*match_master_telemetry/i);
  });

  it("ordinary finalization is monotonic during a mixed-version rollout", () => {
    const source = readFileSync(FINALIZER_MIGRATION, "utf8");

    expect(source).toContain("create or replace function public.finalize_telemetry_cache_write(");
    expect(source).toContain("p_master_version >= v_existing_master.telemetry_version");
    expect(source).toContain("v_incoming_result_version >= v_existing_result_version");
    expect(source).toContain("cache.status = 'ready'");
  });

  it("recovery benchmark CAS carries and validates an exact legacy payload snapshot", () => {
    const migration = readFileSync(FINALIZER_MIGRATION, "utf8");
    const route = readFileSync(ROUTE_SOURCE, "utf8");

    expect(migration).toContain("p_benchmark_guard->'snapshot'");
    expect(migration).toContain("v_previous_benchmark.damage is distinct from v_benchmark_snapshot.damage");
    expect(migration).toContain("v_previous_benchmark.source is distinct from v_benchmark_snapshot.source");
    expect(route).toContain("snapshot,");
    expect(route).toContain("counter_latency_ms");
  });

  it("does not unconditionally delete an ambiguously-owned recovery object", () => {
    const source = readFileSync(ROUTE_SOURCE, "utf8");
    const catchStart = source.indexOf("if (recoveryAuthorized && !recoveryFinalized)");
    expect(catchStart).toBeGreaterThanOrEqual(0);
    const compensation = source.slice(catchStart, catchStart + 2_500);

    expect(compensation).not.toContain("deleteObjectsFromR2");
    expect(compensation).not.toContain("deleteRecoveryObjectIfOwned");
    expect(source).not.toContain("deleteRecoveryObjectIfOwned");
    expect(compensation).toContain("reconciliation");
  });

  it("strict recovery lease release uses the boolean recovery RPC", () => {
    const route = readFileSync(ROUTE_SOURCE, "utf8");
    const registry = readFileSync(REGISTRY_SOURCE, "utf8");

    expect(route).toContain("releaseTelemetryMapCacheRecoveryReservation");
    expect(route).toMatch(/const releaseRecoveryReservationStrict[\s\S]*?releaseTelemetryMapCacheRecoveryReservation\(/);
    expect(registry).toContain('"release_telemetry_cache_recovery_write"');
    expect(registry).toContain("if (data !== true)");
  });

  it("recovery release migration is a service-role-only boolean DELETE guard", () => {
    const migration = readFileSync(CLAIM_MIGRATION, "utf8");

    expect(migration).toMatch(/create or replace function public\.release_telemetry_cache_recovery_write\(/i);
    expect(migration).toMatch(/release_telemetry_cache_recovery_write[\s\S]*returns boolean/i);
    expect(migration).toMatch(/release_telemetry_cache_recovery_write[\s\S]*security invoker/i);
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("p_mode is distinct from 'lite'");
    expect(migration).toContain("p_telemetry_version is distinct from 61");
    expect(migration).toMatch(/delete from public\.telemetry_map_cache_entries[\s\S]*status = 'pending'[\s\S]*lease_token = p_lease_token[\s\S]*returning true into released/i);
    expect(migration).toMatch(/revoke all on function public\.release_telemetry_cache_recovery_write[\s\S]*from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.release_telemetry_cache_recovery_write[\s\S]*to service_role/i);
    expect(migration).not.toMatch(/drop function public\.release_telemetry_cache_write/i);
  });

  it("canary apply has a concrete production read-back verifier", () => {
    const source = readFileSync(CANARY_SOURCE, "utf8");

    expect(source).toContain("readObjectForVerification");
    expect(source).toContain("createBenchmarkRecoveryR2PostconditionVerifier");
    expect(source).not.toContain('process.env.NODE_ENV !== "test"');
  });

  it("forward migration pins both weapon comparison RPCs to an empty search path", () => {
    const migration = readFileSync(FINALIZER_MIGRATION, "utf8");

    expect(migration).toMatch(
      /alter function public\.get_weapon_meta_comparison\(\s*text, timestamptz, integer\s*\) set search_path = ''/i,
    );
    expect(migration).toMatch(
      /alter function public\.get_weapon_meta_comparison\(\s*text, timestamptz, integer, text\s*\) set search_path = ''/i,
    );
  });
});
