import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainExpiredMatchArchives, parseDrainOptions, summarizeDrainRun } from "../scripts/drain_expired_match_archives";

const now = Date.parse("2026-10-08T03:00:00Z");
function report(reason = "end-of-pass", startedFromBeginning = true): Array<Record<string, unknown>> {
  return [
    { mode: "r2-usage", phase: 'before', bytes: 1000, objects: 20 },
    { mode: "continuous-retention", scope: "completed-batches", failed: false,
      startedFromBeginning,
      completedBatches: 2, deletedObjects: 5, removedBytes: 400, backupBytes: 500, stopReason: reason },
    // New writes offset some deletion; report the actual total instead of treating 400 as net savings.
    { mode: "r2-usage", phase: 'after', bytes: 800, objects: 16 },
  ];
}
const asLog = (records = report()) => records.map(r => "retain\tSTEP\t2026-10-08T03:00:00Z " + JSON.stringify(r)).join("\n");
const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("one-off archive drain", () => {
  it("defaults to read-only with a fixed 14-day cutoff and rejects unsafe or unbounded arguments", () => {
    const options = parseDrainOptions(["--log", "/tmp/drain.jsonl"], now);
    expect(options).toMatchObject({ mode: "dry-run", maxRuns: 1, cutoff: "2026-09-24T03:00:00.000Z" });
    for (const argv of [[], ["--apply", "--max-runs", "101", "--log", "/tmp/a"],
      ["--log", "/tmp/a", "--cutoff", "2026-09-25T00:00:00Z"],
      ["--log", "/tmp/a", "--cutoff", "invalid"],
      ["--log", "/tmp/a", "--apply", "--apply"],
      ["--log", "/tmp/a", "--unknown", "1"]]) {
      expect(() => parseDrainOptions(argv, now)).toThrow();
    }
  });

  it("accepts only completed evidence and keeps deleted bytes separate from net bucket reduction", () => {
    expect(summarizeDrainRun(asLog())).toMatchObject({ deletedObjects: 5, removedBytes: 400,
      backupBytes: 500, beforeBytes: 1000, afterBytes: 800, stopReason: "end-of-pass" });
    const incomplete = report();
    expect(() => summarizeDrainRun(asLog(incomplete.slice(0, 2)))).toThrow();
    incomplete[1] = { ...incomplete[1], failed: true };
    expect(() => summarizeDrainRun(asLog(incomplete))).toThrow();
    expect(summarizeDrainRun(asLog(incomplete.slice(0, 2)), false)).toMatchObject({
      deletedObjects: 5, removedBytes: 400, beforeBytes: 1000, afterBytes: null,
    });
  });

  async function fakeGh(success: boolean, startedFromBeginning = true) {
    const folder = await mkdtemp(join(tmpdir(), "bgms-drain-"));
    folders.push(folder);
    const records = join(folder, "commands");
    const script = [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> '" + records + "'",
      "task_dispatch_count=$(awk '/^workflow run/ { n++ } END { print n+0 } ' '" + records + "')",
      "case \"$1 $2\" in",
      "  'workflow run') printf '%s\\n' \"https://github.com/ka6865/BGMS/actions/runs/$((1233 + task_dispatch_count))\" ;;",
      "  'run view')",
      "    case \"$*\" in",
      "      *--log*) cat <<'LOG'",
      asLog(report('end-of-pass', startedFromBeginning)),
      "LOG",
      "        ;;",
      "      *) printf '%s\\n' '" + JSON.stringify({ status: "completed", conclusion: success ? "success" : "failure" }) + "' ;;",
      "    esac ;;",
      "  *) exit 1 ;;",
      "esac",
    ].join("\n");
    await writeFile(join(folder, "gh"), script, { mode: 0o700 });
    vi.stubEnv("PATH", folder + ":" + process.env.PATH);
    return { folder, records, log: join(folder, "progress.jsonl") };
  }

  it("uses only main's guarded workflow and stops after the pass while writing private net measurements", async () => {
    const h = await fakeGh(true);
    await drainExpiredMatchArchives(["--apply", "--log", h.log]);
    const commands = await readFile(h.records, "utf8");
    expect(commands.split("\n").filter(line => line.startsWith("workflow run"))).toHaveLength(1);
    expect(commands).toContain("--ref main");
    expect(commands).toContain("platform=all");
    expect(commands).toContain("batches=10");
    expect(commands).toContain("cutoff=");
    const lines = (await readFile(h.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ event: "stopped", stopReason: "end-of-pass", removedBytes: 400,
      netBucketReductionBytes: 200, protectedObjectsMayRemain: true });
    expect((await stat(h.log)).mode & 0o777).toBe(0o600);
  });

  it('starts from a middle cursor, wraps, and covers the prefix before finishing the full pass', async () => {
    const h = await fakeGh(true, false);
    await drainExpiredMatchArchives(['--apply', '--log', h.log]);
    expect((await readFile(h.records, 'utf8')).split('\n').filter(line => line.startsWith('workflow run'))).toHaveLength(2);
    const lines = (await readFile(h.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ stopReason: 'end-of-pass', passEnds: 2, requiredPassEnds: 2, deletedObjects: 10 });
  });

  it("stops on a failed run and does not count unverified partial deletion or dispatch another", async () => {
    const h = await fakeGh(false);
    await expect(drainExpiredMatchArchives(["--apply", "--log", h.log])).rejects.toThrow("backlog-drain-stopped");
    expect((await readFile(h.records, "utf8")).split("\n").filter(line => line.startsWith("workflow run"))).toHaveLength(1);
    const lines = (await readFile(h.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ event: "failed", activeRun: "1234", deletedObjects: 5,
      totalsIncomplete: true, unverifiedPartialDeletionMayRemain: true });
  });
});
