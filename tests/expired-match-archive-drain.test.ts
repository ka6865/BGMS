import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
  vi.restoreAllMocks();
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
    for (const minutes of ['0', '211', '1.5', 'NaN']) {
      expect(() => parseDrainOptions(['--log', '/tmp/a', '--max-runtime-minutes', minutes], now)).toThrow();
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

  async function fakeGh(success: boolean, starts: boolean[] = [true]) {
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
      "      *--log*)",
      "        case \"$task_dispatch_count\" in",
      ...[...starts, starts.at(-1)!].flatMap((started, index) => [
        "          " + (index === starts.length ? '*' : String(index + 1)) + ") cat <<'LOG'",
        asLog(report('end-of-pass', started)), "LOG", "            ;;",
      ]),
      "        esac ;;",
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
    const h = await fakeGh(true, [false, true]);
    await drainExpiredMatchArchives(['--apply', '--log', h.log]);
    expect((await readFile(h.records, 'utf8')).split('\n').filter(line => line.startsWith('workflow run'))).toHaveLength(2);
    const lines = (await readFile(h.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ stopReason: 'end-of-pass', passEnds: 2, deletedObjects: 10 });
  });

  it('실행 예산에 도달해도 진행 중인 작업의 근거를 기록한 뒤 다음 실행을 중단한다', async () => {
    const h = await fakeGh(true, [false]);
    vi.spyOn(Date, 'now').mockImplementation(() => existsSync(h.records)
      && readFileSync(h.records, 'utf8').includes('--log') ? now + 60_001 : now);
    await drainExpiredMatchArchives(['--apply', '--max-runtime-minutes', '1', '--log', h.log]);
    expect((await readFile(h.records, 'utf8')).split('\n').filter(line => line.startsWith('workflow run'))).toHaveLength(1);
    const lines = (await readFile(h.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ event: 'stopped', stopReason: 'runtime-budget', deletedObjects: 5 });
  });

  it('읽기 실패는 재시도하되 dispatch 오류는 재시도하지 않고 단계를 기록한다', async () => {
    const h = await fakeGh(true);
    const gh = join(h.folder, 'gh');
    const original = await readFile(gh, 'utf8');
    await writeFile(gh, original.replace('case "$1 $2" in',
      'if [ "$1 $2" = "run view" ] && [ ! -f "' + h.folder + '/retried" ]; then touch "' + h.folder + '/retried"; exit 1; fi\ncase "$1 $2" in'));
    await drainExpiredMatchArchives(['--apply', '--log', h.log]);
    expect((await readFile(h.records, 'utf8')).split('\n').filter(line => line.includes('--json'))).toHaveLength(2);
    const failed = await fakeGh(true);
    await writeFile(join(failed.folder, 'gh'), '#!/bin/sh\nprintf "called\\n" >> "' + failed.records + '"\nexit 1\n');
    await expect(drainExpiredMatchArchives(['--apply', '--log', failed.log])).rejects.toThrow('backlog-drain-stopped');
    expect((await readFile(failed.records, 'utf8')).trim()).toBe('called');
    const records = (await readFile(failed.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ event: 'failed', failureStage: 'dispatch', activeRun: null });
  });

  it('does not count two empty wraps as a pass until a run actually starts at the beginning', async () => {
    const h = await fakeGh(true, [false, false, true]);
    await drainExpiredMatchArchives(['--apply', '--log', h.log]);
    expect((await readFile(h.records, 'utf8')).split('\n').filter(line => line.startsWith('workflow run'))).toHaveLength(3);
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
