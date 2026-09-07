/** Applies a reviewed prepared manifest one compare-and-swap RPC at a time. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { ANALYSIS_CALCULATION_VERSION } from "../lib/pubg-analysis/constants";
import {
  assertCalculationUpgradeManifest,
  summarizeCalculationUpgradeDecisions,
  type CalculationUpgradeManifest,
} from "./calculation_upgrade_batch";
import {
  acquireCalculationUpgradeCheckpointLock,
  saveCalculationUpgradeCheckpointAtomic,
} from "./calculation_upgrade_checkpoint";
import { runCalculationUpgrade } from "./calculation_upgrade_apply_runner";

const { values } = parseArgs({ options: {
  plan: { type: "string" }, resume: { type: "string" }, checkpoint: { type: "string" }, apply: { type: "boolean" },
} });
if (values.plan && values.resume) throw new Error("use_plan_or_resume_not_both");
if (!values.plan && !values.resume) throw new Error("use_plan_or_resume");
const sourcePath = resolve(values.resume ?? values.plan!);
const checkpointPath = resolve(values.checkpoint ?? (values.resume ? sourcePath : `${sourcePath}.checkpoint.json`));

async function loadManifest(): Promise<CalculationUpgradeManifest> {
  const manifest = JSON.parse(await readFile(sourcePath, "utf8"));
  assertCalculationUpgradeManifest(manifest);
  return manifest;
}

let manifest = await loadManifest();
if (!values.apply) {
  console.log(JSON.stringify({
    dryRun: true, phase: manifest.phase, checkpoint: checkpointPath,
    decisionCounts: summarizeCalculationUpgradeDecisions(manifest.decisions), counters: manifest.counters,
    providerCalls: 0, upstreamDownloads: 0,
  }, null, 2));
  process.exit(0);
}

dotenv.config({ path: ".env.local", quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Supabase server environment required");
if (manifest.project !== new URL(url).hostname || manifest.calculationVersion !== ANALYSIS_CALCULATION_VERSION) {
  throw new Error("calculation_upgrade_manifest_project_or_version_mismatch");
}
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const lock = await acquireCalculationUpgradeCheckpointLock(checkpointPath);
try {
  const result = await runCalculationUpgrade({
    manifest,
    saveCheckpoint: (next) => saveCalculationUpgradeCheckpointAtomic(checkpointPath, next),
    database: {
      async readCurrent(upgrade, timeoutMs) {
        const [processed, benchmark] = await Promise.all([
          db.from("processed_match_telemetry").select("data").eq("match_id", upgrade.p_match_id).eq("platform", upgrade.p_platform).eq("player_id", upgrade.p_player_id).abortSignal(AbortSignal.timeout(timeoutMs)).maybeSingle(),
          db.from("global_benchmarks").select("*").eq("match_id", upgrade.p_match_id).eq("platform", upgrade.p_platform).eq("player_id", upgrade.p_player_id).abortSignal(AbortSignal.timeout(timeoutMs)).maybeSingle(),
        ]);
        if (processed.error || benchmark.error) throw processed.error ?? benchmark.error;
        return { processed: processed.data, benchmark: benchmark.data };
      },
      async upgrade(upgrade, timeoutMs) {
        return db.rpc("upgrade_analysis_calculation", upgrade).abortSignal(AbortSignal.timeout(timeoutMs));
      },
    },
  });
  manifest = result.manifest;
  console.log(JSON.stringify({
    // "completed" includes rows proven current during preflight. The RPC
    // attempt count is tracked separately so a resume cannot look like new
    // writes merely because its decisions reached the terminal state.
    completed: manifest.decisions.filter((decision) => decision.status === "completed").length,
    rpcWriteAttempts: manifest.counters.databaseWrites,
    phase: manifest.phase,
    checkpoint: checkpointPath,
    decisionCounts: summarizeCalculationUpgradeDecisions(manifest.decisions),
    counters: manifest.counters,
    providerCalls: 0,
    upstreamDownloads: 0,
    ...(result.stopped ? { stopped: result.stopped } : {}),
  }, null, 2));
  if (result.stopped) process.exitCode = 1;
} finally {
  await lock.release();
}
