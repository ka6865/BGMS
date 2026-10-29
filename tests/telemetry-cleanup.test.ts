import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("telemetry cleanup registry", () => {
  it("마이그레이션이 writer를 행 잠금·cutoff 재검증·순차 삭제로 보호한다", () => {
    const migration = fs.readFileSync(path.resolve(
      "supabase/migrations/20260727000000_telemetry_cache_lock_resilience.sql",
    ), "utf8");

    expect(migration).toContain("cleanup_expired_telemetry_matches");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = ''");
    expect(migration).not.toContain("lock table public.telemetry_map_cache_entries");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("pg_try_advisory_xact_lock");
    expect(migration).toContain("create trigger telemetry_cache_match_lock");
    expect(migration).toContain("order by cache.match_id");
    expect(migration).toContain("cache.updated_at >= p_cutoff");
    expect(migration).toContain("cache.updated_at < p_cutoff");
    expect(migration).toContain("p_now timestamptz");
    expect(migration).toContain(
      "cleanup_expired_telemetry_matches(text[], timestamptz, numeric, timestamptz)",
    );
    expect(migration).toContain("lease_expires_at >= p_now");
    expect(migration).toContain("cache.lease_expires_at < p_now");
    expect(migration).not.toContain("statement_timestamp()");
    expect(migration).toContain("telemetry-cleanup-postcondition-failed");
    expect(migration).toContain("master.match_id is null");
    expect(migration).toContain("not exists");
    expect(migration).toContain("delete from public.match_stats_raw");
    expect(migration).toContain("delete from public.processed_match_telemetry");
    expect(migration).toContain("delete from public.telemetry_map_cache_entries");
    expect(migration).toContain("delete from public.match_master_telemetry");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });

  it("cleanup script는 import 시 실행하지 않고 direct-run guard만 사용한다", () => {
    const source = fs.readFileSync(path.resolve("scripts/cleanup_telemetry.ts"), "utf8");
    expect(source).toContain("pathToFileURL(resolve(process.argv[1])).href === import.meta.url");
    expect(source).toContain("if (isDirectRun)");
    expect(source).not.toMatch(/\nsmartCleanup\(\)\.catch/);
    expect(source).not.toMatch(/process\.exit\(/);
    expect(source).not.toContain("deleteMultipleFromR2");
    expect(source).not.toContain("listR2Files");
    expect(source).not.toMatch(/\.from\(["']global_benchmarks["']\)[\s\S]*\.(delete|upsert)\(/);
    // 장기 보관 정책에서 쓰지 않는 R2 inventory·만료 RPC 경로와 설정을 다시 들이지 않는다.
    expect(source).not.toContain("r2Service");
    expect(source).not.toContain("cleanup_expired_telemetry_matches");
    expect(source).not.toContain("CLEANUP_TARGET_VERSION");
    expect(source).not.toContain("CLEANUP_RETENTION_DAYS");
    expect(source).toContain("compact_pubg_player_cache");
  });
});
