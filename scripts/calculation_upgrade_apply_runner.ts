import {
  ANALYSIS_CALCULATION_VERSION,
} from "../lib/pubg-analysis/constants";
import {
  classifyCalculationUpgradeFailure,
  isRunnableCalculationUpgradeStatus,
  pauseCalculationUpgradeRun,
  stableHash,
  startCalculationUpgradeRun,
  type CalculationUpgradeManifest,
} from "./calculation_upgrade_batch";

export type CalculationUpgradeRow = {
  processed: { data?: { fullResult?: unknown } } | null;
  benchmark: Record<string, unknown> | null;
};

export type CalculationUpgradeRunnerDatabase = {
  readCurrent: (upgrade: any, timeoutMs: number) => Promise<CalculationUpgradeRow>;
  upgrade: (upgrade: any, timeoutMs: number) => Promise<{ data: boolean | null; error: unknown | null }>;
};

export type CalculationUpgradeRunnerOptions = {
  manifest: CalculationUpgradeManifest;
  database: CalculationUpgradeRunnerDatabase;
  saveCheckpoint: (manifest: CalculationUpgradeManifest) => Promise<void>;
  now?: () => number;
  isoNow?: () => string;
};

export type CalculationUpgradeRunnerResult = {
  manifest: CalculationUpgradeManifest;
  stopped?: "time_cap" | "write_cap" | "request_cap" | "contended" | "rate_limited" | "transient_failed";
};

function currentMatchesUpgrade(current: CalculationUpgradeRow, upgrade: any): boolean {
  if (!current.processed?.data?.fullResult || !current.benchmark) return false;
  return stableHash(current.processed?.data?.fullResult) === stableHash(upgrade.p_full_result)
    && current.benchmark?.calculation_version === ANALYSIS_CALCULATION_VERSION
    && Object.entries(upgrade.p_benchmark).every(([field, value]) => (
      stableHash(current.benchmark?.[field]) === stableHash(value)
    ));
}

function remainingRunMs(manifest: CalculationUpgradeManifest, startedAt: number, now: () => number): number {
  return manifest.limits.maxRunMs - (now() - startedAt);
}

function requestTimeout(remainingMs: number, preferredMs: number): number {
  if (remainingMs < 1) throw new Error("time_cap");
  return Math.min(preferredMs, remainingMs);
}

function reserveRequests(
  manifest: CalculationUpgradeManifest,
  runCounters: { reads: number; writes: number },
  reads: number,
  writes: number,
) {
  if (runCounters.reads + runCounters.writes + reads + writes > manifest.limits.maxRequests) {
    throw new Error("request_cap");
  }
  // Count before awaiting so timeouts and transport failures cannot evade the cap.
  runCounters.reads += reads;
  runCounters.writes += writes;
  manifest.counters.databaseReads += reads;
  manifest.counters.databaseWrites += writes;
}

export async function runCalculationUpgrade(options: CalculationUpgradeRunnerOptions): Promise<CalculationUpgradeRunnerResult> {
  const now = options.now ?? Date.now;
  const isoNow = options.isoNow ?? (() => new Date(now()).toISOString());
  const startedAt = now();
  const runCounters = { reads: 0, writes: 0 };
  let manifest = startCalculationUpgradeRun(options.manifest, isoNow());
  await options.saveCheckpoint(manifest);

  const stop = async (reason?: CalculationUpgradeRunnerResult["stopped"], complete = false) => {
    manifest = pauseCalculationUpgradeRun(manifest, {
      finishedAt: isoNow(),
      ...(reason ? { error: reason } : {}),
      complete,
    });
    await options.saveCheckpoint(manifest);
    return { manifest, ...(reason ? { stopped: reason } : {}) };
  };

  for (const decision of manifest.decisions) {
    if (!isRunnableCalculationUpgradeStatus(decision.status)) continue;
    if (remainingRunMs(manifest, startedAt, now) < 1) return stop("time_cap");
    if (runCounters.writes >= manifest.limits.maxWrites) return stop("write_cap");
    if (typeof decision.upgradeIndex !== "number") throw new Error("prepared_decision_upgrade_index_missing");
    const upgrade: any = manifest.upgrades[decision.upgradeIndex];
    if (!upgrade) throw new Error("prepared_upgrade_missing");

    try {
      reserveRequests(manifest, runCounters, 2, 0);
      const current = await options.database.readCurrent(upgrade, requestTimeout(remainingRunMs(manifest, startedAt, now), 15_000));
      if (!current.processed?.data?.fullResult || !current.benchmark) throw new Error("canonical_snapshot_changed");
      if (currentMatchesUpgrade(current, upgrade)) {
        decision.status = "completed";
        decision.error = undefined;
        await options.saveCheckpoint(manifest);
        continue;
      }

      if (runCounters.writes >= manifest.limits.maxWrites) return stop("write_cap");
      reserveRequests(manifest, runCounters, 0, 1);
      const rpc = await options.database.upgrade(upgrade, requestTimeout(remainingRunMs(manifest, startedAt, now), 30_000));
      if (rpc.error || rpc.data !== true) {
        const kind = rpc.error ? classifyCalculationUpgradeFailure(rpc.error) : "contended";
        decision.status = kind === "contended" ? "contended" : "transient_failed";
        decision.error = kind;
        manifest.counters.errors += 1;
        await options.saveCheckpoint(manifest);
        return stop(kind);
      }

      reserveRequests(manifest, runCounters, 2, 0);
      const currentAfterWrite = await options.database.readCurrent(upgrade, requestTimeout(remainingRunMs(manifest, startedAt, now), 15_000));
      if (!currentMatchesUpgrade(currentAfterWrite, upgrade)) throw new Error("postcondition_failed");
      decision.status = "completed";
      decision.error = undefined;
      await options.saveCheckpoint(manifest);
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "transient_failed";
      if (rawReason === "time_cap" || rawReason === "request_cap") return stop(rawReason);
      const kind = classifyCalculationUpgradeFailure(error);
      decision.status = kind === "contended" ? "contended" : "transient_failed";
      decision.error = kind;
      manifest.counters.errors += 1;
      await options.saveCheckpoint(manifest);
      return stop(kind);
    }
  }

  return stop(undefined, true);
}
