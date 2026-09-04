import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildTelemetryObjectInventoryArchive,
  fetchAllRowsByRange,
  runTelemetryStorageCleanup,
  type TelemetryCleanupDependencies,
  type TelemetryCleanupRegistryRow,
} from "../scripts/cleanup_telemetry";

function createDependencies(
  overrides: Partial<TelemetryCleanupDependencies> = {},
): TelemetryCleanupDependencies {
  return {
    listMasterRows: vi.fn().mockResolvedValue([]),
    listRegistryRows: vi.fn().mockResolvedValue([]),
    archiveObjectInventory: vi.fn().mockResolvedValue(undefined),
    cleanupExpiredMatches: vi.fn(async (matchIds: string[]) => matchIds),
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("telemetry cleanup registry", () => {
  it("Supabase 1000행 제한을 넘는 조회를 범위별로 끝까지 수집한다", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => ({ id: index + 1 }));
    const ranges: Array<[number, number]> = [];

    const result = await fetchAllRowsByRange(async (from, to) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    }, 500);

    expect(result).toHaveLength(1_001);
    expect(ranges).toEqual([
      [0, 499],
      [500, 999],
      [1_000, 1_499],
    ]);
  });

  it("Supabase가 error 없이 null data를 반환해도 fail-closed한다", async () => {
    await expect(fetchAllRowsByRange(async () => ({
      data: null,
      error: null,
    }))).rejects.toThrow("telemetry-cleanup-page-data-missing");
  });

  it("오래된 매치 분석 DB는 장기 보관하고 R2 삭제도 보류한다", async () => {
    const cleanupExpiredMatches = vi.fn().mockResolvedValue(["m1"]);
    const cutoff = new Date("2026-07-17T00:00:00.000Z");
    const dependencies = createDependencies({
      listMasterRows: vi.fn().mockResolvedValue([
        {
          match_id: "m1",
          storage_path: "master/m1.json",
          telemetry_version: 58,
          created_at: "2026-07-01T00:00:00.000Z",
        },
        {
          match_id: "m2",
          storage_path: "master/m2.json",
          telemetry_version: 60,
          created_at: "2026-07-18T00:00:00.000Z",
        },
      ]),
      cleanupExpiredMatches,
    });

    const result = await runTelemetryStorageCleanup({
      cutoff,
      targetVersion: 59,
    }, dependencies);

    expect(cleanupExpiredMatches).not.toHaveBeenCalled();
    expect(result).toEqual({
      deletedMatchCount: 0,
      archivedObjectCount: 0,
      inventoryManifestCount: 0,
      r2DeletionDeferred: true,
    });
  });

  it("master 없는 만료 registry도 장기 보관 정책에서는 cleanup하지 않는다", async () => {
    const registryRow: TelemetryCleanupRegistryRow = {
      match_id: "registry-only",
      storage_path: "telemetry-map/v60/steam/registry-only/player/lite.json",
      status: "ready",
      lease_expires_at: null,
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    const archiveObjectInventory = vi.fn().mockResolvedValue(undefined);
    const cleanupExpiredMatches = vi.fn().mockResolvedValue(["registry-only"]);

    const result = await runTelemetryStorageCleanup({
      cutoff: new Date("2026-07-17T00:00:00.000Z"),
      targetVersion: 59,
    }, createDependencies({
      listRegistryRows: vi.fn().mockResolvedValue([registryRow]),
      archiveObjectInventory,
      cleanupExpiredMatches,
    }));

    expect(archiveObjectInventory).not.toHaveBeenCalled();
    expect(cleanupExpiredMatches).not.toHaveBeenCalled();
    expect(result).toEqual({
      deletedMatchCount: 0,
      archivedObjectCount: 0,
      inventoryManifestCount: 0,
      r2DeletionDeferred: true,
    });
  });

  it("inventory manifest는 입력 순서와 무관한 결정적 key를 사용한다", () => {
    const rows: TelemetryCleanupRegistryRow[] = [
      {
        match_id: "m2",
        storage_path: "telemetry-map/b.json",
        status: "ready",
        lease_expires_at: null,
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      {
        match_id: "m1",
        storage_path: "telemetry-map/a.json",
        status: "ready",
        lease_expires_at: null,
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ];

    const forward = buildTelemetryObjectInventoryArchive(rows);
    const reversed = buildTelemetryObjectInventoryArchive([...rows].reverse());

    expect(forward).toEqual(reversed);
    expect(forward.storagePath).toMatch(/^telemetry-inventory\/v1\/[a-f0-9]{64}\.json$/);
  });

  it("활성 pending lease는 registry-only cleanup 후보에서 제외한다", async () => {
    const cleanupExpiredMatches = vi.fn().mockResolvedValue([]);
    const archiveObjectInventory = vi.fn().mockResolvedValue(undefined);

    await runTelemetryStorageCleanup({
      cutoff: new Date("2026-07-17T00:00:00.000Z"),
      targetVersion: 59,
    }, createDependencies({
      listRegistryRows: vi.fn().mockResolvedValue([{
        match_id: "writer-active",
        storage_path: "telemetry-map/writer-active.json",
        status: "pending",
        lease_expires_at: "2026-07-18T00:15:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      }]),
      archiveObjectInventory,
      cleanupExpiredMatches,
    }));

    expect(archiveObjectInventory).not.toHaveBeenCalled();
    expect(cleanupExpiredMatches).not.toHaveBeenCalled();
  });

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
    expect(source).not.toMatch(/\.from\(["']global_benchmarks["']\).*\.(delete|upsert)\(/s);
    expect(source).toContain("p_now: now.toISOString()");
  });
});
