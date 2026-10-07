import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_RETENTION_BATCH_OBJECTS, MAX_RETENTION_BATCH_BYTES } from "../lib/pubg-analysis/matchRetentionBatch";

export const MAX_CONTINUOUS_RETENTION_BATCHES = 10;
export const RETENTION_RUN_MINUTES = 60;
type StopReason = "batch-limit" | "time-budget" | "dry-run" | "end-of-pass" | "no-progress" | "scope-exhausted";
export type RetentionBatchState = {
  mode: "apply" | "dry-run"; maxBatches: number; startedAt: number;
  completedBatches: number; deletedObjects: number; removedBytes: number; backupBytes: number;
  lastCursor: string | null; stopReason: StopReason | null;
};
type BatchManifest = {
  objects: unknown[]; matches: unknown[]; cursorGeneration?: number;
  nextCursor?: { played_at: string; platform: string; match_id: string } | null;
};
type BatchResult = { mode: string; deletedObjects?: number; removedBytes?: number; backupBytes?: number };

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
export function createRetentionBatchState(mode: string, maxBatches: number, now = Date.now()): RetentionBatchState {
  if (!["apply", "dry-run"].includes(mode) || !Number.isInteger(maxBatches)
    || maxBatches < 1 || maxBatches > MAX_CONTINUOUS_RETENTION_BATCHES || !nonnegative(now)) {
    throw new Error("retention-run-options-invalid");
  }
  return { mode: mode as RetentionBatchState["mode"], maxBatches: mode === "dry-run" ? 1 : maxBatches,
    startedAt: now, completedBatches: 0, deletedObjects: 0, removedBytes: 0, backupBytes: 0,
    lastCursor: null, stopReason: null };
}
export function checkRetentionBatchBudget(state: RetentionBatchState, now = Date.now()): RetentionBatchState {
  if (state.stopReason) return state;
  if (state.completedBatches >= state.maxBatches) return { ...state, stopReason: "batch-limit" };
  if (now < state.startedAt || now - state.startedAt >= RETENTION_RUN_MINUTES * 60_000) {
    return { ...state, stopReason: "time-budget" };
  }
  return state;
}
function cursorFingerprint(manifest: BatchManifest): string | null {
  if (!manifest.nextCursor) return null;
  const c = manifest.nextCursor;
  if (typeof c.played_at !== "string" || !Number.isFinite(Date.parse(c.played_at))
    || !["steam", "kakao"].includes(c.platform) || typeof c.match_id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(c.match_id)) throw new Error("retention-run-cursor-invalid");
  return createHash("sha256").update(JSON.stringify([c.played_at, c.platform, c.match_id])).digest("hex");
}
export function completeRetentionBatch(state: RetentionBatchState, manifest: BatchManifest,
  result: BatchResult, now = Date.now()): RetentionBatchState {
  if (state.stopReason || !Array.isArray(manifest.objects) || !Array.isArray(manifest.matches)
    || manifest.objects.length > MAX_RETENTION_BATCH_OBJECTS || result.mode !== state.mode) throw new Error("retention-run-result-invalid");
  let updated = { ...state, completedBatches: state.completedBatches + 1 };
  if (state.mode === "dry-run") return { ...updated, stopReason: "dry-run" };
  if (![result.deletedObjects, result.removedBytes, result.backupBytes].every(nonnegative)
    || result.deletedObjects !== manifest.objects.length || result.removedBytes! > MAX_RETENTION_BATCH_BYTES) {
    throw new Error("retention-run-result-invalid");
  }
  const cursor = cursorFingerprint(manifest);
  updated = { ...updated, deletedObjects: state.deletedObjects + result.deletedObjects!,
    removedBytes: state.removedBytes + result.removedBytes!, backupBytes: state.backupBytes + result.backupBytes!,
    lastCursor: cursor };
  if (manifest.matches.length === 0) updated.stopReason = "end-of-pass";
  else if (manifest.cursorGeneration === undefined && result.deletedObjects === 0) updated.stopReason = "scope-exhausted";
  else if (manifest.cursorGeneration !== undefined && result.deletedObjects === 0 && cursor === state.lastCursor) {
    updated.stopReason = "no-progress";
  }
  return checkRetentionBatchBudget(updated, now);
}

function formatProgress(state: RetentionBatchState, failed = false) {
  return JSON.stringify({ mode: "continuous-retention", completedBatches: state.completedBatches,
    scope: "completed-batches", failed,
    maxBatches: state.maxBatches, deletedObjects: state.deletedObjects, removedBytes: state.removedBytes,
    backupBytes: state.backupBytes, netBytesIncludingTemporaryBackup: state.removedBytes - state.backupBytes,
    stopReason: state.stopReason });
}
async function saveState(path: string, state: RetentionBatchState) {
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}
async function outputs(value: string) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("retention-run-output-missing");
  await appendFile(process.env.GITHUB_OUTPUT, value);
}
export async function runRetentionBatchControl(args = process.argv.slice(2)) {
  const [command, statePath, manifestPath, resultPath] = args;
  if (!statePath || !["init", "gate", "complete", "summary"].includes(command)) {
    throw new Error("retention-run-arguments-invalid");
  }
  if (command === "init") {
    if (args.length !== 2) throw new Error("retention-run-arguments-invalid");
    await saveState(statePath, createRetentionBatchState(process.env.OP_MODE ?? "",
      Number(process.env.OP_BATCHES), process.env.OP_RUN_STARTED_AT === undefined
        ? Date.now() : Number(process.env.OP_RUN_STARTED_AT)));
    return;
  }
  const state = JSON.parse(await readFile(statePath, "utf8")) as RetentionBatchState;
  createRetentionBatchState(state.mode, state.maxBatches, state.startedAt);
  if (![state.completedBatches, state.deletedObjects, state.removedBytes, state.backupBytes].every(nonnegative)
    || state.completedBatches > state.maxBatches) throw new Error("retention-run-state-invalid");
  if (command === "gate") {
    if (args.length !== 2) throw new Error("retention-run-arguments-invalid");
    const current = checkRetentionBatchBudget(state);
    await saveState(statePath, current);
    await outputs("enabled=" + String(current.stopReason === null) + "\n");
  } else if (command === "complete") {
    if (args.length !== 4 || !manifestPath || !resultPath) throw new Error("retention-run-arguments-invalid");
    const current = completeRetentionBatch(state, JSON.parse(await readFile(manifestPath, "utf8")),
      JSON.parse(await readFile(resultPath, "utf8")));
    await saveState(statePath, current);
    await outputs("continue=" + String(current.stopReason === null) + "\n");
    console.info(formatProgress(current));
  } else {
    if (args.length !== 2) throw new Error("retention-run-arguments-invalid");
    const progress = formatProgress(state, process.env.OP_RUN_FAILED === "true");
    console.info(progress);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, progress + "\n");
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runRetentionBatchControl().catch(() => {
    console.error("Continuous match retention control failed.");
    process.exitCode = 1;
  });
}
