import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  planBenchmarkRecoveryCanary,
  type BenchmarkRecoveryCandidateInput,
} from "../lib/pubg-analysis/benchmarkRecoveryPlanner";
import {
  buildBenchmarkRecoveryManifest,
  parseBenchmarkRecoveryArgs,
} from "../scripts/plan_benchmark_recovery";

const NOW = "2026-09-02T00:00:00.000Z";

function fixture(index: number, overrides: Record<string, unknown> = {}): BenchmarkRecoveryCandidateInput {
  const matchId = `match-${index}`;
  const playerId = `player-${index}`;
  const platform = "steam";
  const fullResult = {
    v: 72,
    matchId,
    player_id: playerId,
    platform,
    gameMode: "duo",
    matchType: "competitive",
    createdAt: "2026-09-01T00:00:00.000Z",
    stats: { name: playerId, playerId: `account-${index}` },
    benchmark: { tier: "C" },
    isValidBenchmark: true,
  };
  return {
    benchmark: {
      id: index,
      match_id: matchId,
      player_id: playerId,
      platform,
      game_mode: "duo",
      match_type: "competitive",
      tier: "C",
      filter_version: 8,
      population_evidence_version: null,
      ...overrides,
    },
    playerMatchRows: [{
      match_id: matchId,
      player_id: playerId,
      platform,
      played_at: "2026-09-01T00:00:00.000Z",
      game_mode: "duo",
      match_type: "competitive",
      map_name: "Baltic_Main",
    }],
    processedRows: [{
      match_id: matchId,
      player_id: playerId,
      platform,
      data: { fullResult },
    }],
  };
}

function setPlatform(input: BenchmarkRecoveryCandidateInput, platform: "steam" | "kakao"): BenchmarkRecoveryCandidateInput {
  input.benchmark.platform = platform;
  input.playerMatchRows = input.playerMatchRows?.map((row) => ({ ...row, platform }));
  input.processedRows = input.processedRows?.map((row) => ({
    ...row,
    platform,
    data: {
      ...(row.data as Record<string, unknown>),
      fullResult: {
        ...((row.data as { fullResult: Record<string, unknown> }).fullResult),
        platform,
      },
    },
  }));
  return input;
}

describe("benchmark recovery canary planner", () => {
  it("selects exactly five deterministic rows from the preferred exact bucket", () => {
    const inputs = Array.from({ length: 6 }, (_, index) => fixture(index + 1));
    const plan = planBenchmarkRecoveryCanary(inputs, {
      now: NOW,
      recentSince: "2026-08-19T00:00:00.000Z",
    });

    expect(plan.selectionStatus).toBe("selected");
    expect(plan.selected).toHaveLength(5);
    expect(plan.selected.every((row) => row.bucket?.gameMode === "duo"
      && row.bucket.matchType === "competitive"
      && row.bucket.tier === "C")).toBe(true);
    expect(plan.selected.map((row) => row.identity.matchId)).toEqual([
      "match-1",
      "match-2",
      "match-3",
      "match-4",
      "match-5",
    ]);
  });

  it("fails closed when the preferred bucket has fewer than five rows", () => {
    const preferred = Array.from({ length: 4 }, (_, index) => fixture(index + 1));
    const alternate = Array.from({ length: 5 }, (_, index) => {
      const value = fixture(index + 10);
      value.benchmark.game_mode = "squad";
      value.processedRows = value.processedRows?.map((row) => ({
        ...row,
        data: {
          fullResult: {
            ...(row.data as { fullResult: Record<string, unknown> }).fullResult,
            gameMode: "squad",
          },
        },
      }));
      value.playerMatchRows = value.playerMatchRows?.map((row) => ({ ...row, game_mode: "squad" }));
      return value;
    });
    const plan = planBenchmarkRecoveryCanary([...preferred, ...alternate], { now: NOW });

    expect(plan.selectionStatus).toBe("insufficient_cohort");
    expect(plan.selected).toEqual([]);
    expect(plan.selectedBucket).toBeNull();
    expect(plan.viableBuckets).toEqual([
      { gameMode: "squad", matchType: "competitive", tier: "C", platform: "steam", eligibleCount: 5 },
    ]);
  });

  it("does not combine Steam and Kakao rows into one five-row cohort", () => {
    const steam = Array.from({ length: 3 }, (_, index) => fixture(index + 1));
    const kakao = Array.from({ length: 2 }, (_, index) => setPlatform(fixture(index + 10), "kakao"));
    const plan = planBenchmarkRecoveryCanary([...steam, ...kakao], { now: NOW });

    expect(plan.selectionStatus).toBe("insufficient_cohort");
    expect(plan.selected).toEqual([]);
    expect(plan.selectedPlatform).toBeNull();
    expect(plan.viableBuckets).toEqual([]);
  });

  it("freezes the preferred platform into selection and the local manifest", () => {
    const kakao = Array.from({ length: 5 }, (_, index) => setPlatform(fixture(index + 1), "kakao"));
    const plan = planBenchmarkRecoveryCanary(kakao, {
      now: NOW,
      preferredPlatform: "kakao",
    });

    expect(plan.selectionStatus).toBe("selected");
    expect(plan.preferredPlatform).toBe("kakao");
    expect(plan.selectedPlatform).toBe("kakao");
    expect(plan.selected.every((row) => row.identity.platform === "kakao")).toBe(true);

    const manifest = buildBenchmarkRecoveryManifest(plan, {
      generatedAt: NOW,
      recentDays: 14,
      recentSince: "2026-08-19T00:00:00.000Z",
      globalBenchmarkRows: 5,
      playerMatchRows: 5,
      processedTelemetryRows: 5,
      truncated: false,
    });

    expect(manifest.criteria.preferredPlatform).toBe("kakao");
    expect(manifest.selectedPlatform).toBe("kakao");
    expect(manifest.canary.every((row) => row.platform === "kakao")).toBe(true);
  });

  it("uses the processed fullResult date before the history fallback", () => {
    const candidate = fixture(1);
    const processed = candidate.processedRows?.[0];
    if (processed) {
      const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
      fullResult.createdAt = "2026-08-01T00:00:00.000Z";
    }
    const plan = planBenchmarkRecoveryCanary([candidate], {
      now: NOW,
      recentSince: "2026-08-19T00:00:00.000Z",
    });

    expect(plan.decisions[0]?.playedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(plan.decisions[0]?.reasons).toContain("history_too_old");
    expect(plan.selected).toEqual([]);
  });

  it("accepts only the immediately previous v72 contract and rejects older/current-unmarked rows", () => {
    const previous = fixture(1);
    const current = fixture(2);
    const previousResult = (previous.processedRows?.[0]?.data as { fullResult: Record<string, unknown> }).fullResult;
    previousResult.v = 71;
    const currentResult = (current.processedRows?.[0]?.data as { fullResult: Record<string, unknown> }).fullResult;
    currentResult.v = 73;

    const plan = planBenchmarkRecoveryCanary([previous, current], { now: NOW });

    expect(plan.decisions[0]?.eligible).toBe(false);
    expect(plan.decisions[0]?.reasons).toContain("processed_identity_mismatch");
    expect(plan.decisions[1]?.eligible).toBe(false);
    expect(plan.decisions[1]?.reasons).toContain("processed_identity_mismatch");

    const v72 = fixture(3);
    expect(planBenchmarkRecoveryCanary([v72], { now: NOW }).decisions[0]?.eligible).toBe(true);
  });

  it("reports trusted rows and strict identity/platform failures", () => {
    const trusted = fixture(1);
    trusted.benchmark.population_evidence_version = 1;
    const invalidPlatform = fixture(2, { platform: "legacy_unknown" });
    const invalidIdentity = fixture(3);
    invalidIdentity.processedRows = [{
      ...(invalidIdentity.processedRows?.[0] || {}),
      player_id: "different-player",
    }];

    const plan = planBenchmarkRecoveryCanary([trusted, invalidPlatform, invalidIdentity], { now: NOW });

    expect(plan.decisions[0]?.reasons).toContain("already_trusted");
    expect(plan.decisions[1]?.reasons).toContain("unsupported_platform");
    expect(plan.decisions[2]?.reasons).toContain("processed_missing");
  });

  it("rejects a noncanonical tier at the planner boundary", () => {
    const candidate = fixture(1, { tier: "BLAH" });
    const processed = candidate.processedRows?.[0];
    if (processed) {
      const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
      fullResult.benchmark = { tier: "BLAH" };
    }
    const plan = planBenchmarkRecoveryCanary([candidate], { now: NOW });

    expect(plan.decisions[0]?.eligible).toBe(false);
    expect(plan.decisions[0]?.reasons).toContain("invalid_bucket_tier");
    expect(plan.selected).toEqual([]);
  });

  it.each([
    ["event", { gameMode: "event" }],
    ["custom", { matchType: "custom" }],
  ] as const)("rejects a noncanonical preferred %s bucket at the planner boundary", (_label, preferredBucket) => {
    const inputs = Array.from({ length: 5 }, (_, index) => fixture(index + 1));
    expect(() => planBenchmarkRecoveryCanary(inputs, {
      now: NOW,
      preferredBucket,
    })).toThrow(/preferred_bucket_population/);
  });

  it("defaults to a read-only CLI and rejects an apply flag", () => {
    expect(parseBenchmarkRecoveryArgs([])).toMatchObject({
      recentDays: 14,
      output: "tmp/benchmark-recovery-canary-plan.json",
    });
    expect(() => parseBenchmarkRecoveryArgs(["--apply"])).toThrow(/read-only/);
    expect(parseBenchmarkRecoveryArgs(["--page-size", "5000"]).pageSize).toBe(1000);
    expect(() => parseBenchmarkRecoveryArgs(["--page-size", "0.5"])).toThrow(/positive integer/i);
    expect(() => parseBenchmarkRecoveryArgs(["--tier", "BLAH"])).toThrow(/tier/i);
    expect(() => parseBenchmarkRecoveryArgs(["--game-mode", "event"])).toThrow(/preferred bucket|canonical|mode/i);
    expect(() => parseBenchmarkRecoveryArgs(["--match-type", "custom"])).toThrow(/preferred bucket|canonical|match/i);
    expect(parseBenchmarkRecoveryArgs([]).preferredPlatform).toBe("steam");
    expect(parseBenchmarkRecoveryArgs(["--platform", "kakao"]).preferredPlatform).toBe("kakao");
    expect(() => parseBenchmarkRecoveryArgs(["--platform", "xbox"])).toThrow(/platform/i);
  });

  it("does not contain database/storage mutator calls", () => {
    const source = readFileSync(new URL("../scripts/plan_benchmark_recovery.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.(?:upsert|insert|update|delete)\s*\(/);
    expect(source).not.toContain("uploadToR2");
  });

  it("projects a local manifest without credentials or raw telemetry", () => {
    const plan = planBenchmarkRecoveryCanary(Array.from({ length: 5 }, (_, index) => fixture(index + 1)), { now: NOW });
    const manifest = buildBenchmarkRecoveryManifest(plan, {
      generatedAt: NOW,
      recentDays: 14,
      recentSince: "2026-08-19T00:00:00.000Z",
      globalBenchmarkRows: 5,
      playerMatchRows: 5,
      processedTelemetryRows: 5,
      truncated: false,
    });
    const serialized = JSON.stringify(manifest);

    expect(manifest.canaryCount).toBe(5);
    expect(manifest.databaseWritesAttempted).toBe(0);
    expect("decisions" in manifest).toBe(false);
    expect(serialized).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(serialized).not.toContain("fullResult");
  });
});
