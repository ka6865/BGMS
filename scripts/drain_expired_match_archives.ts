import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MATCH_DETAIL_RETENTION_DAYS } from "../lib/pubg-analysis/matchRetention";
import { MAX_RETENTION_BATCH_OBJECTS, MAX_RETENTION_BATCH_BYTES } from "../lib/pubg-analysis/matchRetentionBatch";

const exec = promisify(execFile);
const REPO = "ka6865/BGMS";
const WORKFLOW = "pubg-archive-retention.yml";
const STOP_REASONS = ["batch-limit", "time-budget", "dry-run", "end-of-pass", "no-progress", "scope-exhausted"];

export function parseDrainOptions(argv: string[], now = Date.now()) {
  let apply = false, maxRuns = 100, maxRuntimeMinutes = 210;
  let cutoff = new Date(now - MATCH_DETAIL_RETENTION_DAYS * 86_400_000).toISOString();
  let logPath: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (seen.has(name)) throw new Error("backlog-option-repeated");
    seen.add(name);
    if (name === "--apply") { apply = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("backlog-option-missing");
    if (name === "--max-runs") maxRuns = Number(value);
    else if (name === "--max-runtime-minutes") maxRuntimeMinutes = Number(value);
    else if (name === "--cutoff") cutoff = value;
    else if (name === "--log") logPath = resolve(value);
    else throw new Error("backlog-option-unknown");
  }
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 100 || !logPath
    || !Number.isSafeInteger(maxRuntimeMinutes) || maxRuntimeMinutes < 1 || maxRuntimeMinutes > 210
    || !Number.isFinite(Date.parse(cutoff))
    || Date.parse(cutoff) > now - MATCH_DETAIL_RETENTION_DAYS * 86_400_000) {
    throw new Error("backlog-options-invalid");
  }
  return { mode: apply ? "apply" : "dry-run", maxRuns: apply ? maxRuns : 1,
    maxRuntimeMinutes, cutoff: new Date(cutoff).toISOString(), logPath };
}

export function summarizeDrainRun(log: string, successful = true) {
  const records: Array<Record<string, unknown>> = [];
  for (const line of log.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(start));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
    } catch { /* Shell source and unrelated logs are not operation reports. */ }
  }
  const progress = records.filter(r => r.mode === "continuous-retention").at(-1);
  const measurements = records.filter(r => r.mode === "r2-usage");
  const before = measurements.filter(m => m.phase === 'before');
  const after = measurements.filter(m => m.phase === 'after');
  const validCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!progress || typeof progress.failed !== 'boolean' || (successful && progress.failed !== false)
    || progress.scope !== "completed-batches" || typeof progress.startedFromBeginning !== 'boolean'
    || ![progress.completedBatches, progress.deletedObjects, progress.removedBytes, progress.backupBytes].every(validCount)
    || Number(progress.completedBatches) < (successful ? 1 : 0) || Number(progress.completedBatches) > 10
    || Number(progress.deletedObjects) > Number(progress.completedBatches) * MAX_RETENTION_BATCH_OBJECTS
    || Number(progress.removedBytes) > Number(progress.completedBatches) * MAX_RETENTION_BATCH_BYTES
    || (progress.stopReason !== null && (typeof progress.stopReason !== "string" || !STOP_REASONS.includes(progress.stopReason)))
    || before.length > 1 || after.length > 1 || before.length + after.length !== measurements.length
    || (successful && (progress.stopReason === null || before.length !== 1 || after.length !== 1))
    || measurements.some(m => !validCount(m.bytes) || !validCount(m.objects))) {
    throw new Error("backlog-run-evidence-incomplete");
  }
  return { completedBatches: progress.completedBatches as number,
    deletedObjects: progress.deletedObjects as number, removedBytes: progress.removedBytes as number,
    backupBytes: progress.backupBytes as number, stopReason: progress.stopReason as string | null,
    startedFromBeginning: progress.startedFromBeginning,
    beforeBytes: before[0]?.bytes as number | undefined ?? null,
    afterBytes: after[0]?.bytes as number | undefined ?? null };
}

async function gh(args: string[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await exec("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
      return result.stdout;
    } catch (error) {
      // Only read-only requests can be retried; dispatch might already have succeeded.
      if (args[0] !== 'run' || attempt >= 2) throw error;
      await delay(1000);
    }
  }
}

export async function drainExpiredMatchArchives(argv = process.argv.slice(2)) {
  const options = parseDrainOptions(argv);
  const log = await open(options.logPath, "wx", 0o600);
  const record = async (value: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...value });
    await log.write(line + "\n");
    await log.sync();
    console.info(line);
  };
  let activeRun: string | null = null;
  const seenRuns = new Set<string>();
  let deletedObjects = 0, removedBytes = 0, backupBytes = 0;
  let initialBytes: number | null = null;
  let finalBytes: number | null = null;
  let stopReason = "run-limit";
  let passEnds = 0, fullPassStarted = false;
  const dispatchDeadline = Date.now() + options.maxRuntimeMinutes * 60_000;
  let failureStage = 'start';
  try {
    await record({ event: "start", repo: REPO, ...options });
    for (let index = 0; index < options.maxRuns; index++) {
      if (Date.now() >= dispatchDeadline) { stopReason = 'runtime-budget'; break; }
      // Reuse main's concurrency group and each batch's uploaded, downloaded backup.
      // The local process never receives the production storage credentials.
      failureStage = 'dispatch';
      const dispatched = (await gh(["workflow", "run", WORKFLOW, "--repo", REPO, "--ref", "main",
        "--raw-field", "mode=" + options.mode, "--raw-field", "platform=all",
        "--raw-field", "batches=" + (options.mode === "apply" ? "10" : "1"),
        "--raw-field", "limit=50", "--raw-field", "cutoff=" + options.cutoff])).trim();
      const match = /^https:\/\/github\.com\/ka6865\/BGMS\/actions\/runs\/(\d+)$/.exec(dispatched);
      if (!match || seenRuns.has(match[1])) throw new Error("backlog-dispatch-receipt-missing");
      activeRun = match[1];
      seenRuns.add(activeRun);
      await record({ event: "dispatched", run: Number(activeRun), url: dispatched });
      const deadline = Date.now() + 2 * 60 * 60_000;
      let successful = false;
      failureStage = 'watch';
      while (true) {
        const state = JSON.parse(await gh(["run", "view", activeRun, "--repo", REPO,
          "--json", "status,conclusion"])) as { status?: string; conclusion?: string };
        if (state.status === "completed") {
          successful = state.conclusion === 'success';
          break;
        }
        if (Date.now() >= deadline) throw new Error("backlog-run-watch-timeout");
        await delay(30_000);
      }
      failureStage = 'read-evidence';
      const result = summarizeDrainRun(await gh(["run", "view", activeRun, "--repo", REPO, "--log"]), successful);
      deletedObjects += result.deletedObjects;
      removedBytes += result.removedBytes;
      backupBytes += result.backupBytes;
      initialBytes ??= result.beforeBytes;
      finalBytes = result.afterBytes;
      await record({ event: successful ? "completed" : "failed-run", run: Number(activeRun), ...result,
        totalsScope: 'completed-batches-only', unverifiedPartialDeletionMayRemain: !successful,
        netBucketReductionBytes: result.beforeBytes === null || result.afterBytes === null ? null : result.beforeBytes - result.afterBytes });
      failureStage = 'completed-run';
      if (!successful) throw new Error('backlog-run-not-successful');
      activeRun = null;
      fullPassStarted ||= result.startedFromBeginning;
      if (options.mode === 'apply' && result.stopReason === 'end-of-pass') {
        passEnds++;
        if (!fullPassStarted) continue;
      }
      if (!["batch-limit", "time-budget"].includes(result.stopReason ?? '')) {
        stopReason = result.stopReason!;
        break;
      }
    }
    await record({ event: "stopped", stopReason, deletedObjects, removedBytes, backupBytes,
      passEnds, fullPassStarted, totalsScope: 'completed-batches-only',
      netBucketReductionBytes: initialBytes === null || finalBytes === null ? null : initialBytes - finalBytes,
      protectedObjectsMayRemain: true });
  } catch {
    await record({ event: "failed", failureStage, activeRun, deletedObjects, removedBytes, backupBytes,
      totalsScope: 'completed-batches-only', totalsIncomplete: true, unverifiedPartialDeletionMayRemain: true });
    throw new Error("backlog-drain-stopped-see-private-log");
  } finally { await log.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  drainExpiredMatchArchives().catch(error => {
    console.error(error instanceof Error ? error.message : "backlog-drain-failed");
    process.exitCode = 1;
  });
}
