import { describe, expect, it } from "vitest";
import {
  assertCalculationUpgradeManifest,
  buildCalculationUpgradeManifest,
  classifyCalculationUpgradeFailure,
  normalizeCalculationUpgradeLimits,
  pauseCalculationUpgradeRun,
  startCalculationUpgradeRun,
  summarizeCalculationUpgradeDecisions,
} from "../scripts/calculation_upgrade_batch";

const limits = normalizeCalculationUpgradeLimits({ maxBatch: 2, maxScan: 4, maxWrites: 2 });
const input = () => ({
  generatedAt: "2026-09-07T00:00:00.000Z",
  project: "example.supabase.co",
  calculationVersion: 2,
  limits,
  counters: { databaseReads: 5, databaseWrites: 0, localSourceBytes: 123, providerCalls: 0 as const, upstreamDownloads: 0 as const, errors: 0 },
  decisions: [
    { identity: { matchId: "match-a", platform: "steam" as const, playerId: "player-a" }, status: "prepared" as const, reasons: ["official_raw_identity_and_full_calculation_fields_verified"], upgradeIndex: 0 },
    { identity: { matchId: "match-b", platform: "steam" as const, playerId: "player-b" }, status: "raw_unavailable" as const, reasons: ["r2_map_projection_not_used_as_raw"] },
  ],
  upgrades: [{
    p_match_id: "match-a",
    p_expected_benchmark: {
      id: 1, match_id: "match-a", platform: "steam", player_id: "player-a", created_at: "2026-09-07T00:00:00.000Z",
      damage: 1, kills: 1, win_place: 1, game_mode: "squad", match_type: "competitive",
      filter_version: 8, population_evidence_version: 1, calculation_version: null,
      source: "user",
    },
  }],
});

describe("calculation upgrade batch checkpoints", () => {
  it("records a discovered row as prepared, never running, until an apply starts", () => {
    const manifest = buildCalculationUpgradeManifest(input());

    expect(manifest.phase).toBe("prepared");
    expect(summarizeCalculationUpgradeDecisions(manifest.decisions)).toMatchObject({ prepared: 1, raw_unavailable: 1, completed: 0 });
    expect(manifest.counters).toMatchObject({ providerCalls: 0, upstreamDownloads: 0, databaseWrites: 0 });
  });

  it("keeps a batch-cap deferral separate from an unverified raw-source catalog", () => {
    const manifest = buildCalculationUpgradeManifest({
      ...input(),
      decisions: [
        ...input().decisions,
        { identity: { matchId: "match-c", platform: "steam" as const, playerId: "player-c" }, status: "deferred_batch_limit" as const, reasons: ["deferred_batch_limit"] },
      ],
    });

    expect(summarizeCalculationUpgradeDecisions(manifest.decisions)).toMatchObject({
      raw_unavailable: 1,
      deferred_batch_limit: 1,
    });
  });

  it("preserves the normalized player filter used for a bounded target scan", () => {
    const manifest = buildCalculationUpgradeManifest({
      ...input(),
      discovery: { cursor: 0, playerId: "miaeq_q", scanned: 2 },
    });

    expect(manifest.discovery).toMatchObject({ cursor: 0, playerId: "miaeq_q", scanned: 2 });
  });

  it("permits resume after an interrupted run without relabeling unavailable raw data", () => {
    const running = startCalculationUpgradeRun(buildCalculationUpgradeManifest(input()), "2026-09-07T00:01:00.000Z");
    running.decisions[0]!.status = "transient_failed";
    const checkpoint = pauseCalculationUpgradeRun(running, { finishedAt: "2026-09-07T00:01:10.000Z", error: "rate_limited" });

    expect(checkpoint.phase).toBe("paused");
    expect(checkpoint.decisions[0]?.status).toBe("transient_failed");
    expect(checkpoint.decisions[1]?.status).toBe("raw_unavailable");
  });

  it("rejects edited prepared upgrades so a checkpoint cannot silently change snapshots", () => {
    const manifest: any = buildCalculationUpgradeManifest(input());
    manifest.upgrades[0].p_match_id = "other-match";

    expect(() => assertCalculationUpgradeManifest(manifest)).toThrow(/stale/);
  });

  it("rejects a partial benchmark snapshot before an apply can reach the RPC", () => {
    const partial: any = input();
    delete partial.upgrades[0].p_expected_benchmark.damage;

    expect(() => buildCalculationUpgradeManifest(partial)).toThrow(/expected_benchmark_snapshot.*damage/);
  });

  it("keeps contention terminal and rate limits resumable", () => {
    expect(classifyCalculationUpgradeFailure({ code: "40001" })).toBe("contended");
    expect(classifyCalculationUpgradeFailure({ status: 429 })).toBe("rate_limited");
    expect(classifyCalculationUpgradeFailure(new Error("socket closed"))).toBe("transient_failed");
  });

  it("rejects an unsafe write limit above the batch cap", () => {
    expect(() => normalizeCalculationUpgradeLimits({ maxBatch: 2, maxScan: 2, maxWrites: 3 })).toThrow(/write_limit/);
  });

  it("keeps the error cap at one because a write outcome can be unknown", () => {
    expect(() => normalizeCalculationUpgradeLimits({ maxErrors: 2 })).toThrow(/error_limit/);
  });
});
