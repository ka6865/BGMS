import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSafeMatchRecord,
  classifySafeBackfillStatus,
  parseSafeBackfillArgs,
  runSafeUnknownMatchTypeBackfill,
  SAFE_UNKNOWN_MATCH_TYPE_BACKFILL_ORDER,
  shouldStopSafeBackfill,
  type SafeBackfillArgs,
} from "../scripts/backfill_unknown_match_types_safe";

const baseArgs: SafeBackfillArgs = {
  apply: true,
  limit: 10,
  delayMs: 0,
  maxRuntimeMinutes: 10,
  maxRequests: 10,
  timeoutMs: 1_000,
  lockFile: path.join(os.tmpdir(), "bgms-safe-backfill-test.lock"),
  logFile: path.join(os.tmpdir(), "bgms-safe-backfill-test.log"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe unknown match type backfill", () => {
  it("defaults to apply-off, slow requests, and bounded runtime", () => {
    expect(parseSafeBackfillArgs([])).toEqual({
      apply: false,
      limit: 1_000,
      delayMs: 10_000,
      maxRuntimeMinutes: 720,
      maxRequests: 1_000,
      timeoutMs: 5_000,
      lockFile: path.join(os.tmpdir(), "bgms-match-type-backfill-safe.lock"),
      logFile: path.join(os.tmpdir(), "bgms-match-type-backfill-safe.log"),
    });
  });

  it("accepts explicit slow-run bounds while capping unsafe values", () => {
    expect(parseSafeBackfillArgs([
      "--apply",
      "--limit", "9000",
      "--delay-ms", "2500",
      "--max-runtime-minutes", "2000",
      "--max-requests", "9000",
      "--timeout-ms", "90000",
      "--lock-file", "/tmp/custom.lock",
      "--log-file", "/tmp/custom.log",
    ])).toEqual({
      apply: true,
      limit: 5_000,
      delayMs: 2_500,
      maxRuntimeMinutes: 1_440,
      maxRequests: 5_000,
      timeoutMs: 60_000,
      lockFile: "/tmp/custom.lock",
      logFile: "/tmp/custom.log",
    });
  });

  it("allows zero delay for a one-record smoke run", () => {
    expect(parseSafeBackfillArgs(["--delay-ms", "0"]).delayMs).toBe(0);
  });

  it("keeps newest-first ordering and stops on quota/server failures", () => {
    expect(SAFE_UNKNOWN_MATCH_TYPE_BACKFILL_ORDER).toEqual({ column: "played_at", ascending: false });
    expect(classifySafeBackfillStatus(404)).toBe("unavailable");
    expect(classifySafeBackfillStatus(429)).toBe("rate_limited");
    expect(classifySafeBackfillStatus(403)).toBe("request_error");
    expect(classifySafeBackfillStatus(503)).toBe("server_error");
    expect(classifySafeBackfillStatus(0)).toBe("request_error");
    expect(shouldStopSafeBackfill("rate_limited")).toBe(true);
    expect(shouldStopSafeBackfill("server_error")).toBe(true);
    expect(shouldStopSafeBackfill("unresolved")).toBe(false);
  });

  it("builds a canonical record from the API participant", () => {
    expect(buildSafeMatchRecord(
      { match_id: "m-1", player_id: "Player One", platform: "STEAM" },
      { createdAt: "2026-08-14T00:00:00Z", gameMode: "squad-fpp", mapName: "Erangel", matchType: "Competitive" },
      { kills: 3, damageDealt: 321.8, winPlace: 4 },
    )).toEqual({
      player_id: "player one",
      platform: "steam",
      match_id: "m-1",
      played_at: "2026-08-14T00:00:00Z",
      game_mode: "squad-fpp",
      map_name: "Erangel",
      kills: 3,
      damage: 321,
      win_place: 4,
      match_type: "competitive",
    });
  });

  it("dry-runs without making a PUBG request or writing a row", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("PUBG_API_KEY", "pubg-key");
    const fetchImpl = vi.fn();
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ match_id: "m-1", player_id: "player", platform: "steam", played_at: "2026-08-14T00:00:00Z" }],
        error: null,
      }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) } as never;
    const summary = await runSafeUnknownMatchTypeBackfill(
      { ...baseArgs, apply: false, lockFile: path.join(os.tmpdir(), "bgms-safe-backfill-dry-run.lock") },
      { supabase, fetchImpl, pid: 999_999 },
    );
    expect(summary).toMatchObject({ dryRun: true, candidates: 1, requests: 0, stoppedReason: "dry_run" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith("match_type", "unknown");
  });

  it("rechecks ownership before updating and writes only while still unknown", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("PUBG_API_KEY", "pubg-key");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { attributes: { createdAt: "2026-08-14T00:00:00Z", gameMode: "squad-fpp", mapName: "Erangel", matchType: "official" } },
      included: [{ type: "participant", attributes: { stats: { name: "player", kills: 1, damageDealt: 100, winPlace: 10 } } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const candidateQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ match_id: "m-1", player_id: "player", platform: "steam" }], error: null }),
    };
    const recheckQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { match_type: "unknown" }, error: null }),
    };
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { match_id: "m-1" }, error: null }),
    };
    const supabase = {
      from: vi.fn()
        .mockReturnValueOnce(candidateQuery)
        .mockReturnValueOnce(recheckQuery)
        .mockReturnValueOnce(updateQuery),
    } as never;
    const summary = await runSafeUnknownMatchTypeBackfill(
      { ...baseArgs, lockFile: path.join(os.tmpdir(), "bgms-safe-backfill-apply.lock") },
      { supabase, fetchImpl, pid: 999_999 },
    );
    expect(summary).toMatchObject({ dryRun: false, candidates: 1, requests: 1, updated: 1, stoppedReason: null });
    expect(updateQuery.update).toHaveBeenCalledWith({ match_type: "official" });
  });

  it("refuses a second process while a live lock owner exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("PUBG_API_KEY", "pubg-key");
    const fs = await import("node:fs");
    const lockFile = path.join(os.tmpdir(), "bgms-safe-backfill-live.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
    await expect(runSafeUnknownMatchTypeBackfill(
      { ...baseArgs, apply: false, lockFile },
      { pid: 999_999 },
    )).rejects.toThrow(/already running/);
    fs.unlinkSync(lockFile);
  });
});
