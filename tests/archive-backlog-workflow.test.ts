import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
const source = readFileSync(join(process.cwd(), ".github/workflows/pubg-archive-backlog.yml"), "utf8");
const workflow = yaml.load(source);
const job = workflow.jobs.drain;
const drain = job.steps.find((step: any) => step.id === "drain");
const summary = job.steps.find((step: any) => step.name === "Summarize backlog");
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "archive backlog "));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PUBG archive backlog wrapper", () => {
  it("keeps the parent serial and gives only repository read and child dispatch permissions", () => {
    const child = yaml.load(readFileSync(join(process.cwd(), ".github/workflows/pubg-archive-retention.yml"), "utf8"));
    expect(workflow.permissions).toEqual({ contents: "read", actions: "write" });
    expect(workflow.concurrency).toBeUndefined();
    expect(job.concurrency).toEqual({ group: "pubg-archive-backlog", "cancel-in-progress": false });
    expect(job.concurrency.group).not.toBe(child.jobs.retain.concurrency.group);
    expect(job["timeout-minutes"]).toBe(360);
    expect(workflow.defaults.run.shell).toBe("bash");
    expect(drain.env).toEqual({ GH_TOKEN: "${{ github.token }}", OP_CUTOFF: "${{ inputs.cutoff }}" });
    expect(source).not.toMatch(/secrets\.|SUPABASE|CLOUDFLARE|R2_RECOVERY_ARCHIVE_KEY|continue-on-error/);
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule).toEqual([{ cron: "17 */3 * * *" }]);
    expect(workflow.on.workflow_dispatch.inputs.cutoff).toMatchObject({ type: "string", default: "" });
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["cutoff"]);
  });

  it.each([
    ["ka6865/BGMS", "refs/heads/main", "workflow_dispatch", "", true],
    ["ka6865/BGMS", "refs/heads/main", "schedule", "true", true],
    ["ka6865/BGMS", "refs/heads/main", "schedule", "false", false],
    ["ka6865/BGMS", "refs/heads/main", "schedule", "", false],
    ["other/BGMS", "refs/heads/main", "workflow_dispatch", "true", false],
    ["ka6865/BGMS", "refs/heads/feature", "workflow_dispatch", "true", false],
    ["ka6865/BGMS", "refs/pull/1/merge", "pull_request", "true", false],
    ["ka6865/BGMS", "refs/heads/main", "push", "true", false],
  ])("gates %s / %s / %s / %s", (repository, ref, event_name, enabled, allowed) => {
    const condition = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    expect(runInNewContext(condition, {
      github: { repository, ref, event_name }, vars: { PUBG_ARCHIVE_BACKLOG_ENABLED: enabled },
    })).toBe(allowed);
  });

  it.each([
    ["false", "true", false, true],
    ["true", "true", true, false],
    ["false", "false", false, false],
    ["true", "false", true, false],
  ])("separates manual dispatch from schedules (backlog=%s, retention=%s)", (backlog, retention, parentScheduled, childScheduled) => {
    const child = yaml.load(readFileSync(join(process.cwd(), ".github/workflows/pubg-archive-retention.yml"), "utf8"));
    const eligible = (condition: string, event_name: string) => runInNewContext(
      condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
        github: { repository: "ka6865/BGMS", ref: "refs/heads/main", event_name },
        vars: { PUBG_ARCHIVE_BACKLOG_ENABLED: backlog, PUBG_DETAIL_ARCHIVE_RETENTION_ENABLED: retention },
      },
    );
    expect([
      eligible(job.if, "workflow_dispatch"), eligible(child.jobs.retain.if, "workflow_dispatch"),
      eligible(job.if, "schedule"), eligible(child.jobs.retain.if, "schedule"),
    ]).toEqual([true, true, parentScheduled, childScheduled]);
  });

  it("reuses the pinned local toolchain and does not interpolate inputs into shell scripts", () => {
    expect(job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"))).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false },
    });
    expect(job.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@"))).toMatchObject({
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "22", cache: "npm" },
    });
    expect(job.steps.find((step: any) => step.run === "npm ci --ignore-scripts")).toBeDefined();
    for (const step of job.steps.filter((step: any) => step.run)) {
      expect(step.run).not.toContain("${{");
      expect(step.run).not.toMatch(/\bgh\b|\beval\b/);
    }
  });

  it.each([
    ["", 0],
    ["2026-01-01T00:00:00.000Z", 0],
    ['$(printf SHELL_INJECTION >&2); "quoted cutoff"', 0],
    ["", 23],
  ])("passes cutoff as one argument and propagates driver exit (%s / %s)", (cutoff, exitCode) => {
    const directory = temporaryDirectory();
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", `
      npx() {
        node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"
        return "$MOCK_EXIT_CODE"
      }
      ${drain.run}
    `], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: directory, OP_CUTOFF: cutoff, MOCK_EXIT_CODE: String(exitCode), GH_TOKEN: "mock-token" },
    });
    expect(result.status, result.stderr).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toEqual([
      "tsx", "scripts/drain_expired_match_archives.ts", "--apply", "--max-runs", "100",
      "--max-runtime-minutes", "210", "--log", join(directory, "private.jsonl"),
      ...(cutoff ? ["--cutoff", cutoff] : []),
    ]);
    expect(result.stderr).not.toContain("SHELL_INJECTION");
  });

  it("preserves only the fsynced counter log for seven days even after failure", () => {
    const artifacts = job.steps.filter((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      if: "${{ always() }}",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "pubg-archive-backlog-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/private.jsonl", "retention-days": 7, "if-no-files-found": "ignore",
      },
    });
    expect(job.steps.indexOf(artifacts[0])).toBeGreaterThan(job.steps.indexOf(drain));
    expect(job.steps.indexOf(artifacts[0])).toBeLessThan(job.steps.indexOf(summary));
    expect(summary.if).toBe("${{ always() }}");
    expect(summary.env).toEqual({ DRAIN_OUTCOME: "${{ steps.drain.outcome }}" });
  });

  it.each(["success", "failure"])("summarizes only verified totals on %s without copying raw fields", (outcome) => {
    const directory = temporaryDirectory();
    const records = [
      { event: "start", accountId: "PRIVATE_ACCOUNT", token: "PRIVATE_TOKEN" },
      { event: "completed", deletedObjects: 50 },
      { event: "completed", deletedObjects: 25 },
      { event: outcome === "success" ? "stopped" : "failed", deletedObjects: 75, removedBytes: 8000,
        backupBytes: 1000, netBucketReductionBytes: -25, rawLog: "PRIVATE_RAW_LOG" },
    ];
    writeFileSync(join(directory, "private.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + '\n{"event":');
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", summary.run], {
      encoding: "utf8", env: { ...process.env, RUNNER_TEMP: directory,
        GITHUB_STEP_SUMMARY: join(directory, "summary.md"), DRAIN_OUTCOME: outcome },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = readFileSync(join(directory, "summary.md"), "utf8");
    const counters = JSON.parse(report.match(/```json\n([\s\S]*?)\n```/)![1]);
    expect(counters).toEqual({ status: outcome, verifiedRuns: 2, totalsScope: "completed-batches-only",
      totalsIncomplete: outcome === "failure", deletedObjects: 75, removedBytes: 8000,
      backupBytes: 1000, netBucketReductionBytes: -25 });
    expect(report).not.toContain("PRIVATE_");
    expect(result.stdout).toBe("");
  });

  it("still reports failure when the driver could not create a counter log", () => {
    const directory = temporaryDirectory();
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", summary.run], {
      encoding: "utf8", env: { ...process.env, RUNNER_TEMP: directory,
        GITHUB_STEP_SUMMARY: join(directory, "summary.md"), DRAIN_OUTCOME: "failure" },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = readFileSync(join(directory, "summary.md"), "utf8");
    expect(report).toContain('"status": "failure"');
    expect(report).toContain('"totalsIncomplete": true');
    expect(report).not.toContain("deletedObjects");
  });
});
