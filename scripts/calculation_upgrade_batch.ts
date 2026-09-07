import { createHash } from "node:crypto";

export const CALCULATION_UPGRADE_BATCH_VERSION = 2 as const;

export type CalculationUpgradeStatus =
  | "prepared"
  | "completed"
  | "already_current"
  | "canonical_missing"
  | "benchmark_missing"
  | "benchmark_ineligible"
  | "raw_unavailable"
  | "deferred_batch_limit"
  | "source_byte_cap"
  | "contended"
  | "transient_failed";

export type CalculationUpgradePhase = "prepared" | "running" | "paused" | "completed";

export type CalculationUpgradeLimits = {
  maxBatch: number;
  maxScan: number;
  maxSourceBytes: number;
  maxTotalSourceBytes: number;
  maxRequests: number;
  maxWrites: number;
  maxErrors: number;
  maxRunMs: number;
};

export const DEFAULT_CALCULATION_UPGRADE_LIMITS: CalculationUpgradeLimits = {
  maxBatch: 10,
  maxScan: 100,
  maxSourceBytes: 32 * 1024 * 1024,
  maxTotalSourceBytes: 160 * 1024 * 1024,
  maxRequests: 50,
  maxWrites: 10,
  maxErrors: 1,
  maxRunMs: 120_000,
};

export type CalculationUpgradeIdentity = {
  matchId: string;
  platform: "steam" | "kakao";
  playerId: string;
};

export type CalculationUpgradeDecision = {
  identity: CalculationUpgradeIdentity;
  status: CalculationUpgradeStatus;
  reasons: string[];
  source?: {
    kind: "local_official_raw";
    matchFile: string;
    telemetryFile: string;
    uniqueBytes: number;
  };
  registry?: {
    rows: number;
    modes: string[];
    versions: number[];
    /** Map projections are evidence only and are never used as raw telemetry. */
    sourceEligible: false;
  };
  upgradeIndex?: number;
  error?: string;
};

export type CalculationUpgradeCounters = {
  databaseReads: number;
  databaseWrites: number;
  localSourceBytes: number;
  providerCalls: 0;
  upstreamDownloads: 0;
  errors: number;
};

export type CalculationUpgradeManifest = {
  kind: "calculation-upgrade-prepared";
  version: typeof CALCULATION_UPGRADE_BATCH_VERSION;
  generatedAt: string;
  project: string;
  calculationVersion: number;
  phase: CalculationUpgradePhase;
  preparedHash: string;
  limits: CalculationUpgradeLimits;
  counters: CalculationUpgradeCounters;
  discovery?: {
    /** Offset cursor for the bounded, deterministic candidate page. */
    cursor: number;
    /** Optional normalized player filter used to target a named account. */
    playerId?: string;
    nextCursor?: number;
    scanned: number;
  };
  decisions: CalculationUpgradeDecision[];
  upgrades: unknown[];
  run?: {
    startedAt?: string;
    finishedAt?: string;
    lastError?: string;
  };
};

// The RPC compares the complete global_benchmarks row. These identity and
// result columns are the minimum evidence that a prepared benchmark snapshot
// is complete enough to reach that CAS; nullable values are valid, but omitted
// keys indicate a partial select and must fail before apply.
const REQUIRED_BENCHMARK_SNAPSHOT_FIELDS = [
  "id", "match_id", "platform", "player_id", "created_at",
  "damage", "kills", "win_place", "game_mode", "match_type",
  "filter_version", "population_evidence_version", "calculation_version",
  "source",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCompleteBenchmarkSnapshots(upgrades: readonly unknown[]): void {
  upgrades.forEach((upgrade, index) => {
    if (!isRecord(upgrade) || !isRecord(upgrade.p_expected_benchmark)) {
      throw new Error(`invalid_expected_benchmark_snapshot:${index}`);
    }
    const snapshot = upgrade.p_expected_benchmark;
    for (const field of REQUIRED_BENCHMARK_SNAPSHOT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, field)) {
        throw new Error(`invalid_expected_benchmark_snapshot:${index}:${field}`);
      }
    }
  });
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  ))).digest("hex");
}

export function normalizeCalculationUpgradeLimits(
  input: Partial<CalculationUpgradeLimits> = {},
): CalculationUpgradeLimits {
  const limits = { ...DEFAULT_CALCULATION_UPGRADE_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`invalid_limit_${name}`);
  }
  if (limits.maxBatch > 10) throw new Error("calculation_upgrade_batch_limit_exceeds_10");
  if (limits.maxWrites > limits.maxBatch) throw new Error("calculation_upgrade_write_limit_exceeds_batch");
  if (limits.maxScan < limits.maxBatch) throw new Error("calculation_upgrade_scan_limit_below_batch");
  if (limits.maxTotalSourceBytes < limits.maxSourceBytes) throw new Error("calculation_upgrade_total_byte_limit_below_source_limit");
  // A run stops at its first failed operation. Continuing after an unknown
  // write outcome would make recovery less auditable.
  if (limits.maxErrors !== 1) throw new Error("calculation_upgrade_error_limit_must_be_1");
  return limits;
}

export function summarizeCalculationUpgradeDecisions(decisions: readonly CalculationUpgradeDecision[]): Record<CalculationUpgradeStatus, number> {
  const summary = {
    prepared: 0,
    completed: 0,
    already_current: 0,
    canonical_missing: 0,
    benchmark_missing: 0,
    benchmark_ineligible: 0,
    raw_unavailable: 0,
    deferred_batch_limit: 0,
    source_byte_cap: 0,
    contended: 0,
    transient_failed: 0,
  } satisfies Record<CalculationUpgradeStatus, number>;
  for (const decision of decisions) summary[decision.status] += 1;
  return summary;
}

export function buildCalculationUpgradeManifest(input: Omit<CalculationUpgradeManifest, "kind" | "version" | "phase" | "preparedHash">): CalculationUpgradeManifest {
  const prepared = input.decisions.filter((decision) => decision.status === "prepared").length;
  if (prepared !== input.upgrades.length) throw new Error("prepared_upgrade_count_mismatch");
  if (prepared > input.limits.maxBatch) throw new Error("prepared_upgrade_count_exceeds_limit");
  assertCompleteBenchmarkSnapshots(input.upgrades);
  return {
    ...input,
    kind: "calculation-upgrade-prepared",
    version: CALCULATION_UPGRADE_BATCH_VERSION,
    phase: "prepared",
    preparedHash: stableHash(input.upgrades),
  };
}

export function assertCalculationUpgradeManifest(value: unknown): asserts value is CalculationUpgradeManifest {
  if (!value || typeof value !== "object") throw new Error("invalid_calculation_upgrade_manifest");
  const manifest = value as Partial<CalculationUpgradeManifest>;
  if (manifest.kind !== "calculation-upgrade-prepared"
    || manifest.version !== CALCULATION_UPGRADE_BATCH_VERSION
    || !Array.isArray(manifest.upgrades)
    || !Array.isArray(manifest.decisions)
    || typeof manifest.preparedHash !== "string"
    || stableHash(manifest.upgrades) !== manifest.preparedHash
    || !manifest.limits) {
    throw new Error("invalid_or_stale_calculation_upgrade_manifest");
  }
  assertCompleteBenchmarkSnapshots(manifest.upgrades);
  normalizeCalculationUpgradeLimits(manifest.limits);
  if (!["prepared", "running", "paused", "completed"].includes(String(manifest.phase))) {
    throw new Error("invalid_calculation_upgrade_phase");
  }
}

export function startCalculationUpgradeRun(manifest: CalculationUpgradeManifest, startedAt: string): CalculationUpgradeManifest {
  assertCalculationUpgradeManifest(manifest);
  if (manifest.phase === "completed") return manifest;
  return { ...manifest, phase: "running", run: { ...manifest.run, startedAt, finishedAt: undefined, lastError: undefined } };
}

export function isRunnableCalculationUpgradeStatus(status: CalculationUpgradeStatus): boolean {
  return status === "prepared" || status === "transient_failed";
}

export function classifyCalculationUpgradeFailure(error: unknown): "rate_limited" | "contended" | "transient_failed" {
  const record = error as { code?: unknown; status?: unknown; message?: unknown } | undefined;
  const code = String(record?.code ?? "").toLowerCase();
  const status = Number(record?.status);
  const message = String(record?.message ?? error ?? "").toLowerCase();
  if (status === 429 || code === "429" || message.includes("rate limit")) return "rate_limited";
  if (code === "40001" || message.includes("snapshot_changed") || message.includes("contended")) return "contended";
  return "transient_failed";
}

export function pauseCalculationUpgradeRun(
  manifest: CalculationUpgradeManifest,
  options: { finishedAt: string; error?: string; complete?: boolean },
): CalculationUpgradeManifest {
  assertCalculationUpgradeManifest(manifest);
  const runnable = manifest.decisions.some((decision) => isRunnableCalculationUpgradeStatus(decision.status));
  return {
    ...manifest,
    phase: options.complete || !runnable ? "completed" : "paused",
    run: { ...manifest.run, finishedAt: options.finishedAt, ...(options.error ? { lastError: options.error } : {}) },
  };
}
