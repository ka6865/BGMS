import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BENCHMARK_RECOVERY_DEFAULT_BASE_URL,
  benchmarkRecoveryConfirmationToken,
  parseBenchmarkRecoveryCanaryArgs,
  runBenchmarkRecoveryCanary,
  validateBenchmarkRecoveryManifest,
  type BenchmarkRecoveryCanaryArgs,
  type BenchmarkRecoveryR2PostconditionEvidence,
  type ReadOnlySupabaseClient,
} from "../scripts/run_benchmark_recovery_canary";
import type { BenchmarkRecoveryManifest } from "../scripts/plan_benchmark_recovery";
import { TELEMETRY_VERSION } from "../lib/pubg-analysis/constants";

const GENERATED_AT = "2026-09-02T00:00:00.000Z";

function manifestFixture(): BenchmarkRecoveryManifest {
  const canary = Array.from({ length: 5 }, (_, index) => ({
    benchmarkId: index + 1,
    matchId: `match-${index + 1}`,
    playerId: `player-${index + 1}`,
    platform: "steam" as const,
    gameMode: "duo",
    matchType: "competitive",
    tier: "C",
    playedAt: "2026-09-01T00:00:00.000Z",
    eligible: true,
    reason: "eligible",
    reasons: [],
  }));
  return {
    schemaVersion: "benchmark-recovery-canary-v1",
    mode: "read-only-dry-run",
    generatedAt: GENERATED_AT,
    criteria: {
      recentDays: 14,
      recentSince: "2026-08-19T00:00:00.000Z",
      cohortSize: 5,
      preferredBucket: { gameMode: "duo", matchType: "competitive", tier: "C" },
      preferredPlatform: "steam",
      trustedMarkers: { filterVersion: 8, populationEvidenceVersion: 1, resultVersion: 73 },
    },
    sources: {
      globalBenchmarkRows: 5,
      playerMatchRows: 5,
      processedTelemetryRows: 5,
      truncated: false,
    },
    selectionStatus: "selected",
    selectedBucket: { gameMode: "duo", matchType: "competitive", tier: "C" },
    selectedPlatform: "steam",
    canaryCount: 5,
    eligibleCount: 5,
    ineligibleCount: 0,
    reasonCounts: {},
    viableBuckets: [{ gameMode: "duo", matchType: "competitive", tier: "C", platform: "steam", eligibleCount: 5 }],
    canary,
    readEvidence: canary.map((entry) => ({
      matchId: entry.matchId,
      playerId: entry.playerId,
      platform: entry.platform,
      gameMode: entry.gameMode,
      matchType: entry.matchType,
      tier: entry.tier,
      playedAt: entry.playedAt,
      isValidBenchmark: true,
    })),
    databaseWritesAttempted: 0,
    storageWritesAttempted: 0,
    externalApiCalls: 0,
  };
}

function databaseFixture() {
  const global = Array.from({ length: 5 }, (_, index) => ({
    match_id: `match-${index + 1}`,
    player_id: `player-${index + 1}`,
    platform: "steam",
    game_mode: "duo",
    match_type: "competitive",
    tier: "C",
    filter_version: 8,
    population_evidence_version: null,
  }));
  const processed = global.map((row) => ({
    ...row,
    data: {
      fullResult: {
        v: 72,
        isValidBenchmark: true,
        matchId: row.match_id,
        player_id: row.player_id,
        platform: row.platform,
        createdAt: "2026-09-01T00:00:00.000Z",
        gameMode: "duo",
        matchType: "competitive",
        benchmark: { tier: "C" },
        stats: { name: row.player_id },
      },
    },
  }));
  const playerMatches = global.map((row) => ({
    ...row,
    played_at: "2026-09-01T00:00:00.000Z",
  }));
  return {
    global_benchmarks: global,
    processed_match_telemetry: processed,
    pubg_player_matches: playerMatches,
    match_stats_raw: [],
    weapon_meta_match_samples: [],
    telemetry_map_cache_entries: [],
    match_master_telemetry: [],
    pubg_player_cache: global.map((row) => ({
      lower_nickname: row.player_id,
      platform: row.platform,
      nickname: row.player_id,
    })),
  } as Record<string, Array<Record<string, unknown>>>;
}

const ROUTE_RESPONSE_URL = `${BENCHMARK_RECOVERY_DEFAULT_BASE_URL}/api/pubg/match`;

function routeResponse(payload: unknown, status = 200, finalUrl = ROUTE_RESPONSE_URL): Response {
  const response = new Response(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    { status, headers: { "content-type": "application/json" } },
  );
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

type FixtureR2Object = { key: string; body: string; etag: string };
type FixtureR2Registry = {
  matchId: string;
  playerId: string;
  platform: "steam" | "kakao";
  storagePath: string;
  status: "ready";
  telemetryVersion: number;
  etag: string;
};

const fixtureR2Objects = new Map<string, FixtureR2Object>();
const fixtureR2Registry = new Map<string, FixtureR2Registry>();
let fixtureR2Reads = 0;
let fixtureR2ObjectReads = 0;
let fixtureR2RegistryReads = 0;

function markFixtureR2Ready(identity: {
  matchId: string;
  playerId: string;
  platform: "steam" | "kakao";
}): void {
  const key = `telemetry-map/v${TELEMETRY_VERSION}/${identity.platform}/${identity.matchId}/${identity.playerId}.json`;
  const body = `canonical-r2-${identity.matchId}`;
  const etag = `etag-${identity.matchId}`;
  fixtureR2Objects.set(identity.matchId, { key, body, etag });
  fixtureR2Registry.set(identity.matchId, {
    matchId: identity.matchId,
    playerId: identity.playerId,
    platform: identity.platform,
    storagePath: key,
    status: "ready",
    telemetryVersion: TELEMETRY_VERSION,
    etag,
  });
}

async function fixtureR2PostconditionVerifier(
  identity: { matchId: string; playerId: string; platform: "steam" | "kakao"; bucket: { gameMode: string; matchType: string; tier: string }; playedAt: string },
  before: ReturnType<typeof databaseFixture>,
  after: ReturnType<typeof databaseFixture>,
): Promise<BenchmarkRecoveryR2PostconditionEvidence> {
  void before;
  void after;
  // These reads intentionally exercise both sides of the storage contract;
  // the verifier does not infer R2 readiness from the database fixture.
  fixtureR2Reads += 1;
  fixtureR2ObjectReads += 1;
  const object = fixtureR2Objects.get(identity.matchId);
  fixtureR2RegistryReads += 1;
  const registry = fixtureR2Registry.get(identity.matchId);
  if (!object || !registry) {
    return {
      object: { key: "", exists: false, etag: "", sha256: "", readBack: false },
      registry: {
        matchId: identity.matchId,
        playerId: identity.playerId,
        platform: identity.platform,
        storagePath: "",
        status: "ready",
        telemetryVersion: TELEMETRY_VERSION,
        etag: "",
        readBack: false,
      },
    } as unknown as BenchmarkRecoveryR2PostconditionEvidence;
  }
  return {
    object: {
      key: object.key,
      exists: true,
      etag: object.etag,
      sha256: createHash("sha256").update(object.body).digest("hex"),
      readBack: true,
    },
    registry: {
      ...registry,
      readBack: true,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  fixtureR2Objects.clear();
  fixtureR2Registry.clear();
  fixtureR2Reads = 0;
  fixtureR2ObjectReads = 0;
  fixtureR2RegistryReads = 0;
});

function readOnlySupabase(rows: Record<string, Array<Record<string, unknown>>>, readEvents: string[] = []): ReadOnlySupabaseClient {
  return {
    from(table: string) {
      const filters: Array<{ column: string; values: string[] }> = [];
      const query = {
        select: () => query,
        in: (column: string, values: readonly string[]) => {
          filters.push({ column, values: [...values] });
          return query;
        },
        eq: (column: string, value: string) => {
          filters.push({ column, values: [value] });
          return query;
        },
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
          readEvents.push(table);
          const data = (rows[table] || []).filter((row) => filters.every(({ column, values }) => (
            values.includes(String(row[column] ?? ""))
          )));
          return Promise.resolve(resolve({ data, error: null }));
        },
      };
      return query;
    },
  } as unknown as ReadOnlySupabaseClient;
}

function applyArgs(manifest: BenchmarkRecoveryManifest, overrides: Partial<BenchmarkRecoveryCanaryArgs> = {}): BenchmarkRecoveryCanaryArgs {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
  vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
  return {
    manifest: "tmp/benchmark-recovery-canary-plan.json",
    apply: true,
    confirm: benchmarkRecoveryConfirmationToken(manifest),
    baseUrl: BENCHMARK_RECOVERY_DEFAULT_BASE_URL,
    report: "tmp/test-canary-report.json",
    json: false,
    ...overrides,
  };
}

describe("benchmark recovery canary executor", () => {
  it("defaults to preflight and makes zero route calls", async () => {
    const manifest = manifestFixture();
    const fetchRoute = vi.fn();
    const writeLocal = vi.fn(async () => undefined);
    const report = await runBenchmarkRecoveryCanary(
      parseBenchmarkRecoveryCanaryArgs([]),
      { manifest, fetchRoute, writeLocal, now: () => Date.parse(GENERATED_AT) },
    );

    expect(report.status).toBe("preflight");
    expect(report.routeCalls).toBe(0);
    expect(report.selectedPlatform).toBe("steam");
    expect(report.confirmationToken).toBe(benchmarkRecoveryConfirmationToken(manifest));
    expect(fetchRoute).not.toHaveBeenCalled();
    expect(writeLocal).toHaveBeenCalledTimes(1);
  });

  it("requires an exact confirmation token and rejects non-loopback apply targets", async () => {
    const manifest = manifestFixture();
    await expect(runBenchmarkRecoveryCanary(
      applyArgs(manifest, { confirm: "wrong" }),
      { manifest },
    )).rejects.toThrow("confirmation_mismatch");

    await expect(runBenchmarkRecoveryCanary(
      applyArgs(manifest, { baseUrl: "https://preview.example.com" }),
      { manifest },
    )).rejects.toThrow("loopback");
  });

  it("rejects apply when synchronous stale recovery is disabled before snapshot or route execution", async () => {
    const manifest = manifestFixture();
    const fetchRoute = vi.fn();
    const writeLocal = vi.fn(async () => undefined);
    const args = applyArgs(manifest);
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "false");

    await expect(runBenchmarkRecoveryCanary(args, {
      manifest,
      fetchRoute,
      writeLocal,
    })).rejects.toThrow(/sync.*stale|stale.*sync/i);

    expect(fetchRoute).not.toHaveBeenCalled();
    expect(writeLocal).not.toHaveBeenCalled();
  });

  it("refuses apply before any route when no concrete R2 postcondition verifier is supplied", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn();

    await expect(runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
    })).rejects.toThrow("r2_postcondition_verifier_required");
    expect(fetchRoute).not.toHaveBeenCalled();
  });

  it("freezes the selected platform in manifest validation and confirmation material", () => {
    const steamManifest = manifestFixture();
    const kakaoManifest = structuredClone(steamManifest);
    kakaoManifest.criteria.preferredPlatform = "kakao";
    kakaoManifest.selectedPlatform = "kakao";
    kakaoManifest.canary = kakaoManifest.canary.map((entry) => ({ ...entry, platform: "kakao" }));
    kakaoManifest.readEvidence = kakaoManifest.readEvidence.map((entry) => ({ ...entry, platform: "kakao" }));

    expect(benchmarkRecoveryConfirmationToken(steamManifest)).not.toBe(
      benchmarkRecoveryConfirmationToken(kakaoManifest),
    );

    const mixedManifest = structuredClone(steamManifest);
    mixedManifest.canary[0] = { ...mixedManifest.canary[0], platform: "kakao" };
    expect(() => benchmarkRecoveryConfirmationToken(mixedManifest)).toThrow(/mixed.*platform/i);
  });

  it("binds full safety criteria and selected-entry freshness into the manifest token", () => {
    const manifest = manifestFixture();
    const token = benchmarkRecoveryConfirmationToken(manifest);

    const changedCriteria = structuredClone(manifest);
    changedCriteria.criteria.recentDays = 7;
    expect(benchmarkRecoveryConfirmationToken(changedCriteria)).not.toBe(token);

    const changedEntry = structuredClone(manifest);
    changedEntry.canary[0] = {
      ...changedEntry.canary[0],
      playedAt: "2026-08-31T00:00:00.000Z",
    };
    changedEntry.readEvidence[0] = {
      ...changedEntry.readEvidence[0],
      playedAt: "2026-08-31T00:00:00.000Z",
    };
    expect(benchmarkRecoveryConfirmationToken(changedEntry)).not.toBe(token);
  });

  it("rejects truncated, stale, or marker-mismatched manifests before apply", () => {
    const manifest = manifestFixture();
    const cases = [
      ["truncated", (value: BenchmarkRecoveryManifest) => { value.sources.truncated = true; }],
      ["cohort", (value: BenchmarkRecoveryManifest) => { value.criteria.cohortSize = 4; }],
      ["marker", (value: BenchmarkRecoveryManifest) => { value.criteria.trustedMarkers.filterVersion = 7; }],
      ["stale", (value: BenchmarkRecoveryManifest) => { value.generatedAt = "2026-08-01T00:00:00.000Z"; }],
    ] as const;

    for (const [label, mutate] of cases) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect(() => validateBenchmarkRecoveryManifest(candidate, { now: Date.parse(GENERATED_AT) }), label)
        .toThrow(/manifest|truncated|fresh|stale|criteria|marker/i);
    }
  });

  it.each([
    ["event mode", { gameMode: "event", matchType: "official" }],
    ["custom match type", { gameMode: "duo", matchType: "custom" }],
    ["unknown mode", { gameMode: "unknown", matchType: "official" }],
    ["ranked alias", { gameMode: "duo", matchType: "ranked" }],
  ] as const)("rejects a complete manifest with noncanonical %s population", (_label, population) => {
    const manifest = manifestFixture();
    manifest.selectedBucket = { ...manifest.selectedBucket!, ...population };
    manifest.criteria.preferredBucket = { ...manifest.criteria.preferredBucket, ...population };
    manifest.canary = manifest.canary.map((entry) => ({ ...entry, ...population }));
    manifest.readEvidence = manifest.readEvidence.map((entry) => ({ ...entry, ...population }));
    expect(() => validateBenchmarkRecoveryManifest(manifest, { now: Date.parse(GENERATED_AT) }))
      .toThrow(/population|bucket|mode|match_type/i);
  });

  it("uses five deterministic sequential route calls and snapshots before the first call", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const events: string[] = [];
    const readEvents: string[] = [];
    let readsBeforeFirstRoute = 0;
    const writeLocal = vi.fn(async (filePath: string) => {
      events.push(filePath.includes("snapshot") ? "snapshot" : "report");
    });
    const fetchRoute = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (fetchRoute.mock.calls.length === 1) readsBeforeFirstRoute = readEvents.length;
      if (fetchRoute.mock.calls.length === 2) expect(readEvents.length).toBeGreaterThan(readsBeforeFirstRoute);
      events.push("route");
      const url = new URL(String(input));
      const matchId = url.searchParams.get("matchId") || "";
      const playerId = url.searchParams.get("nickname") || "";
      const platform = url.searchParams.get("platform") || "";
      const row = rows.global_benchmarks.find((candidate) => candidate.match_id === matchId);
      if (row) {
        row.population_evidence_version = 1;
        const processed = rows.processed_match_telemetry.find((candidate) => candidate.match_id === matchId);
        if (processed) {
          const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
          fullResult.v = 73;
          fullResult.populationEvidenceVersion = 1;
        }
      }
      markFixtureR2Ready({ matchId, playerId, platform: platform === "kakao" ? "kakao" : "steam" });
      return routeResponse({ matchId, player_id: playerId, platform, v: 73, populationEvidenceVersion: 1 }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows, readEvents),
      fetchRoute,
      writeLocal,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
      now: () => Date.parse(GENERATED_AT),
    });

    expect(report.status).toBe("applied");
    expect(report.routeCalls).toBe(5);
    expect(report.postconditionsVerified).toBe(true);
    expect(fetchRoute).toHaveBeenCalledTimes(5);
    expect(events[0]).toBe("snapshot");
    expect(events.filter((event) => event === "route")).toHaveLength(5);
    expect(events.indexOf("snapshot")).toBeLessThan(events.indexOf("route"));
    expect(fetchRoute.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("matchId"))).toEqual([
      "match-1", "match-2", "match-3", "match-4", "match-5",
    ]);
    expect(fetchRoute.mock.calls.every(([input]) => {
      const url = new URL(String(input));
      return !url.searchParams.has("force") && !url.searchParams.has("source");
    })).toBe(true);
    expect(fetchRoute.mock.calls.every(([, init]) => {
      const headers = new Headers(init?.headers);
      return headers.get("x-benchmark-recovery-token") === "canary-token";
    })).toBe(true);
    expect(fetchRoute.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(fixtureR2Reads).toBe(5);
    expect(fixtureR2ObjectReads).toBe(5);
    expect(fixtureR2RegistryReads).toBe(5);
  });

  it("rechecks isValidBenchmark immediately before every route call", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const matchId = url.searchParams.get("matchId") || "";
      const playerId = url.searchParams.get("nickname") || "";
      const row = rows.global_benchmarks.find((candidate) => candidate.match_id === matchId);
      if (row) row.population_evidence_version = 1;
      const processed = rows.processed_match_telemetry.find((candidate) => candidate.match_id === matchId);
      if (processed) {
        const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
        fullResult.v = 73;
        fullResult.populationEvidenceVersion = 1;
      }
      // Simulate a benchmark-validity revocation after route 1 completed but
      // before the executor is allowed to call route 2.
      if (matchId === "match-1") {
        const next = rows.processed_match_telemetry.find((candidate) => candidate.match_id === "match-2");
        if (next) {
          const nextResult = (next.data as { fullResult: Record<string, unknown> }).fullResult;
          nextResult.isValidBenchmark = false;
        }
      }
      markFixtureR2Ready({ matchId, playerId, platform: "steam" });
      return routeResponse({ matchId, player_id: playerId, platform: "steam", v: 73, populationEvidenceVersion: 1 }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ code: "race_read_evidence_changed", index: 1 });
    expect(report.routeCalls).toBe(1);
    expect(fetchRoute).toHaveBeenCalledTimes(1);
    expect(fixtureR2Reads).toBe(1);
  });

  it.each([
    ["player match played_at", (rows: ReturnType<typeof databaseFixture>) => {
      rows.pubg_player_matches[0].played_at = "2026-08-31T00:00:00.000Z";
    }],
    ["processed fullResult createdAt", (rows: ReturnType<typeof databaseFixture>) => {
      const processed = rows.processed_match_telemetry[0];
      const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
      fullResult.createdAt = "2026-08-31T00:00:00.000Z";
    }],
  ] as const)("fails closed when route writes a mismatched %s", async (_label, mutate) => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const matchId = url.searchParams.get("matchId") || "";
      const playerId = url.searchParams.get("nickname") || "";
      const row = rows.global_benchmarks.find((candidate) => candidate.match_id === matchId);
      if (row) row.population_evidence_version = 1;
      const processed = rows.processed_match_telemetry.find((candidate) => candidate.match_id === matchId);
      if (processed) {
        const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
        fullResult.v = 73;
        fullResult.populationEvidenceVersion = 1;
      }
      if (matchId === "match-1") mutate(rows);
      return routeResponse({ matchId, player_id: playerId, platform: "steam", v: 73, populationEvidenceVersion: 1 }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ code: "postcondition_failed", index: 0 });
    expect(report.routeCalls).toBe(1);
    expect(report.completed).toHaveLength(0);
  });

  it("stops before the next route when read evidence changes after a completed prefix", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const matchId = url.searchParams.get("matchId") || "";
      const playerId = url.searchParams.get("nickname") || "";
      const row = rows.global_benchmarks.find((candidate) => candidate.match_id === matchId);
      if (row) row.population_evidence_version = 1;
      const processed = rows.processed_match_telemetry.find((candidate) => candidate.match_id === matchId);
      if (processed) {
        const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
        fullResult.v = 73;
        fullResult.populationEvidenceVersion = 1;
      }
      if (matchId === "match-1") {
        rows.pubg_player_matches[1].played_at = "2026-08-01T00:00:00.000Z";
      }
      markFixtureR2Ready({ matchId, playerId, platform: "steam" });
      return routeResponse({ matchId, player_id: playerId, platform: "steam", v: 73, populationEvidenceVersion: 1 }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
      writeLocal: async () => undefined,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ code: "race_read_evidence_changed", index: 1 });
    expect(report.routeCalls).toBe(1);
    expect(report.completed.map((entry) => entry.identity.matchId)).toEqual(["match-1"]);
  });

  it("rejects a route response whose final URL leaves the exact loopback match endpoint", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn(async () => {
      const response = new Response(JSON.stringify({
        matchId: "match-1",
        player_id: "player-1",
        platform: "steam",
        v: 73,
        populationEvidenceVersion: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(response, "url", { value: "https://evil.example/api/pubg/match" });
      return response;
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
      writeLocal: async () => undefined,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ code: "route_response_url_invalid", index: 0 });
    expect(report.routeCalls).toBe(1);
  });

  it("rejects a successful route response with an empty final URL", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn(async () => routeResponse({
      matchId: "match-1",
      player_id: "player-1",
      platform: "steam",
      v: 73,
      populationEvidenceVersion: 1,
    }, 200, ""));

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ code: "route_response_url_invalid", index: 0 });
    expect(report.routeCalls).toBe(1);
    expect(report.completed).toHaveLength(0);
  });

  it("stops sequential execution on the first failed route response", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    const fetchRoute = vi.fn(async (input: RequestInfo | URL) => routeResponse("failed", 503, String(input)));
    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ code: "route_non_200", index: 0, httpStatus: 503 });
    expect(report.routeCalls).toBe(1);
    expect(fetchRoute).toHaveBeenCalledTimes(1);
  });

  it("rejects missing post-run markers or wrong persisted identity", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    let calls = 0;
    const fetchRoute = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = new URL(String(input));
      if (calls === 1) {
        rows.processed_match_telemetry[0].data = {
          fullResult: {
            v: 73,
            matchId: "wrong-match",
            player_id: "player-1",
            platform: "steam",
            populationEvidenceVersion: 1,
            stats: { name: "player-1" },
          },
        };
      }
      return routeResponse({
        matchId: url.searchParams.get("matchId"),
        player_id: url.searchParams.get("nickname"),
        platform: url.searchParams.get("platform"),
        v: 73,
        populationEvidenceVersion: 1,
      }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("failed");
    expect(report.failure?.code).toBe("postcondition_failed");
    expect(report.failure?.index).toBe(0);
    expect(report.routeCalls).toBe(1);
    expect(fetchRoute).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful route when player match or player cache postconditions are missing", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    rows.pubg_player_matches.shift();
    rows.pubg_player_cache.shift();
    const fetchRoute = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const matchId = url.searchParams.get("matchId") || "";
      const playerId = url.searchParams.get("nickname") || "";
      const row = rows.global_benchmarks.find((candidate) => candidate.match_id === matchId);
      if (row) row.population_evidence_version = 1;
      const processed = rows.processed_match_telemetry.find((candidate) => candidate.match_id === matchId);
      if (processed) {
        const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
        fullResult.v = 73;
        fullResult.populationEvidenceVersion = 1;
      }
      return routeResponse({
        matchId,
        player_id: playerId,
        platform: "steam",
        v: 73,
        populationEvidenceVersion: 1,
      }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("failed");
    expect(report.failure?.code).toBe("race_read_evidence_changed");
    expect(report.failure?.index).toBe(0);
    expect(report.routeCalls).toBe(0);
    expect(fetchRoute).not.toHaveBeenCalled();
  });

  it("trims the executor recovery token before sending the route header", async () => {
    const manifest = manifestFixture();
    const rows = databaseFixture();
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "  canary-token  ");
    const fetchRoute = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-benchmark-recovery-token")).toBe("canary-token");
      const url = new URL(String(input));
      const matchId = url.searchParams.get("matchId") || "";
      const playerId = url.searchParams.get("nickname") || "";
      const row = rows.global_benchmarks.find((candidate) => candidate.match_id === matchId);
      if (row) row.population_evidence_version = 1;
      const processed = rows.processed_match_telemetry.find((candidate) => candidate.match_id === matchId);
      if (processed) {
        const fullResult = (processed.data as { fullResult: Record<string, unknown> }).fullResult;
        fullResult.v = 73;
        fullResult.populationEvidenceVersion = 1;
      }
      markFixtureR2Ready({ matchId, playerId, platform: "steam" });
      return routeResponse({ matchId, player_id: playerId, platform: "steam", v: 73, populationEvidenceVersion: 1 }, 200, String(input));
    });

    const report = await runBenchmarkRecoveryCanary(applyArgs(manifest), {
      manifest,
      supabase: readOnlySupabase(rows),
      fetchRoute,
      writeLocal: async () => undefined,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    });

    expect(report.status).toBe("applied");
    expect(fetchRoute).toHaveBeenCalledTimes(5);
    expect(fixtureR2Reads).toBe(5);
    expect(fixtureR2ObjectReads).toBe(5);
    expect(fixtureR2RegistryReads).toBe(5);
  });

  it("fails apply closed when the recovery token is not configured", async () => {
    const manifest = manifestFixture();
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "");
    await expect(runBenchmarkRecoveryCanary(applyArgs(manifest, { confirm: "wrong" }), {
      manifest,
    })).rejects.toThrow("confirmation_mismatch");

    const args = {
      ...applyArgs(manifest),
      confirm: benchmarkRecoveryConfirmationToken(manifest),
    };
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "");
    await expect(runBenchmarkRecoveryCanary(args, { manifest })).rejects.toThrow("missing_benchmark_recovery_token");
  });

  it("rejects injected R2 verifiers outside the explicit test-only boundary", async () => {
    const manifest = manifestFixture();
    const fetchRoute = vi.fn();
    const args = applyArgs(manifest);
    vi.stubEnv("NODE_ENV", "production");

    await expect(runBenchmarkRecoveryCanary(args, {
      manifest,
      supabase: readOnlySupabase(databaseFixture()),
      fetchRoute,
      verifyR2Postconditions: fixtureR2PostconditionVerifier,
    })).rejects.toThrow("r2_postcondition_verifier_required");
    expect(fetchRoute).not.toHaveBeenCalled();
  });

  it("contains no direct database or R2 mutator calls", () => {
    const source = readFileSync(new URL("../scripts/run_benchmark_recovery_canary.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.from\([^)]*\)\.(?:upsert|insert|update|delete)\s*\(/);
    expect(source).not.toContain("uploadToR2");
  });
});
