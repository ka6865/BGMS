import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "node:os";

const loadYaml = (createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown }).load;
type MaintenanceWorkflow = {
  jobs: { maintenance: { steps: { name?: string; run?: string }[] } };
};
 
 describe("Daily Tasks Workflow Integration", () => {
  it("includes user match sync step in daily-tasks.yml", () => {
     const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
     const content = readFileSync(yamlPath, "utf-8");
    expect(content).toContain("sync_user_matches");
  });

  it("runs the benchmark scraper before the lower-priority user match sync", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content.indexOf("- name: Run Smart Scraper")).toBeLessThan(
      content.indexOf("- name: Run User Matches Sync"),
    );
  });

  it("keeps Bluezone statistics before the lower-priority user match sync", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content.indexOf("- name: Extract Bluezone Statistics")).toBeLessThan(
      content.indexOf("- name: Run User Matches Sync"),
    );
  });

  it("runs match type backfill in a separate job after all normal maintenance", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content).toContain("match-type-backfill:");
    expect(content).toContain("needs: [board-write-quota-cleanup, maintenance]");
    expect(content).toContain("backfill_unknown_match_types.ts --limit 300");
  });

  it("runs the backfill when the database health gate passes even if another maintenance step fails", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content).toContain("outputs:");
    expect(content).toContain("database_health: ${{ steps.database_health.outcome }}");
    expect(content).toContain(
      "needs.maintenance.outputs.database_health == 'success'",
    );
    expect(content).not.toContain(
      "needs.board-write-quota-cleanup.result == 'success' && needs.maintenance.outputs.database_health == 'success'",
    );
    expect(content).toContain("MATCH_TYPE_BACKFILL_RESULT");
  });

  it("stops the lower-priority hotdrop step after sync detects a PUBG API rate limit", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content).toContain("id: sync_user_matches");
    expect(content).toContain("pubg_rate_limited: ${{ steps.sync_user_matches.outputs.rate_limited }}");
    expect(content).toContain("Skip Hotdrop After PUBG API Rate Limit");
    expect(content).toContain("steps.sync_user_matches.outputs.rate_limited == 'true'");
    expect(content).toContain("steps.sync_user_matches.outputs.rate_limited != 'true'");
  });

  it("publishes aggregate linked-sync outputs and a privacy-safe step summary", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");
    const syncIndex = content.indexOf("- name: Run User Matches Sync");
    const summaryIndex = content.indexOf("- name: Report Linked PUBG Sync Summary");
    const hotdropSkipIndex = content.indexOf("- name: Skip Hotdrop After PUBG API Rate Limit");

    for (const output of [
      "candidate_count",
      "synced_identities",
      "new_matches",
      "lock_collisions",
      "stopped_reason",
    ]) {
      expect(content).toContain(`${output}: \${{ steps.sync_user_matches.outputs.${output} }}`);
    }

    expect(content).toContain("GITHUB_STEP_SUMMARY");
    expect(content).toContain("rateLimitTrackingErrors");
    expect(summaryIndex).toBeGreaterThan(syncIndex);
    expect(summaryIndex).toBeLessThan(hotdropSkipIndex);
    expect(content).not.toMatch(/displayNickname|normalizedNickname|pubg_nickname|account_id/);
  });

  it("keeps one sequential PUBG user-sync consumer", () => {
    const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
    const content = readFileSync(yamlPath, "utf-8");

    expect(content.match(/scripts\/sync_user_matches\.ts/g)).toHaveLength(1);
    expect(content).not.toContain("parallel-pubg");
  });

  it("bounds daily jobs and includes support cleanup in failure notifications", () => {
    const content = readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8");
    expect(content).toContain("support-attachment-cleanup:\n    if: ${{ github.ref == 'refs/heads/main' }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 10");
    expect(content).toContain("board-write-quota-cleanup:\n    if: ${{ github.ref == 'refs/heads/main' }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 5");
    expect(content).toContain("maintenance:\n    if: ${{ github.ref == 'refs/heads/main' }}");
    expect(content).toContain("timeout-minutes: 90");
    expect(content).toContain("needs: [support-attachment-cleanup, board-write-quota-cleanup, maintenance, match-type-backfill]");
    expect(content).toContain("--connect-timeout 10 --max-time 60");
    expect(content).not.toContain("github.run_started_at");
  });

  it("keeps the destructive board image cleanup disabled", () => {
    const content = readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8");
    expect(content).toContain("board-image-cleanup:\n    # migration·Preview Storage QA·수동 dry-run 완료 전에는 운영 객체 삭제를 시작하지 않는다.\n    if: ${{ false }}");
  });

  it("runs maintenance cleanup only after the core backup succeeds", () => {
    const content = readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8");
    expect(content).toContain("- name: Backup Core Tables\n        id: core_backup");
    for (const name of [
      "Compact Inactive PUBG Player Cache",
      "Run AI Cache Cleanup",
      "Run Analytics Events Cleanup",
      "Run Match Stats Raw Compaction",
      "Cleanup PUBG Cache And Quota Tables",
    ]) {
      const start = content.indexOf(`- name: ${name}`);
      const nextStep = content.indexOf("\n      - name:", start + 1);
      expect(start, name).toBeGreaterThanOrEqual(0);
      expect(content.slice(start, nextStep < 0 ? undefined : nextStep), name)
        .toContain("steps.core_backup.outcome == 'success'");
    }
    const scraperStart = content.indexOf("- name: Run Smart Scraper");
    const scraperNext = content.indexOf("\n      - name:", scraperStart + 1);
    const scraperStep = content.slice(scraperStart, scraperNext);
    expect(scraperStep).toContain("steps.database_health.outcome == 'success'");
    expect(scraperStep).not.toContain("core_backup");
  });

  it("schedules off the hour without sharing a slot with other scheduled workflows", () => {
    const workflowDir = join(process.cwd(), ".github/workflows");
    const daily = loadYaml(readFileSync(join(workflowDir, "daily-tasks.yml"), "utf-8")) as {
      on: { schedule: { cron: string }[] };
    };
    const [{ cron }] = daily.on.schedule;
    const [minute, hour] = cron.split(" ");
    expect(minute).not.toBe("0");
    expect(Number(minute)).toBeGreaterThan(0);
    // KST 새벽(UTC 15~20시)에 시작한다.
    expect(Number(hour)).toBeGreaterThanOrEqual(15);
    expect(Number(hour)).toBeLessThanOrEqual(20);

    const otherCrons = readdirSync(workflowDir)
      .filter((file) => file.endsWith(".yml") && file !== "daily-tasks.yml")
      .flatMap((file) => [...readFileSync(join(workflowDir, file), "utf-8").matchAll(/cron:\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1]));
    for (const other of otherCrons) {
      const [otherMinute, otherHour] = other.split(" ");
      const sameMinute = otherMinute.startsWith("*/")
        ? Number(minute) % Number(otherMinute.slice(2)) === 0
        : otherMinute === "*" || otherMinute.split(",").includes(minute);
      const sameHour = otherHour === "*"
        || (otherHour.startsWith("*/") ? Number(hour) % Number(otherHour.slice(2)) === 0 : otherHour.split(",").includes(hour));
      expect(sameMinute && sameHour, other).toBe(false);
    }
  });

  it("runs the small cleanup jobs in parallel while keeping PUBG key and backup order inside maintenance", () => {
    const workflow = loadYaml(readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8")) as {
      jobs: Record<string, { needs?: unknown; steps?: { name?: string }[] }>;
    };
    expect(workflow.jobs["support-attachment-cleanup"].needs).toBeUndefined();
    expect(workflow.jobs["board-write-quota-cleanup"].needs).toBeUndefined();
    expect(workflow.jobs.maintenance.needs).toBeUndefined();

    const names = (workflow.jobs.maintenance.steps ?? []).map((step) => step.name);
    const order = [
      "Backup Core Tables",
      "Verify Core Backup Restore",
      "Compact Inactive PUBG Player Cache",
      "Run Smart Scraper",
      "Extract Bluezone Statistics",
      "Run User Matches Sync",
      "Run Hotdrop Collection",
    ].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("gives the player cache compaction only the database credentials it uses", () => {
    const content = readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8");
    const workflow = loadYaml(content) as {
      jobs: { maintenance: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } };
    };
    const step = workflow.jobs.maintenance.steps.find((candidate) => candidate.run === "npx tsx scripts/cleanup_telemetry.ts");
    expect(step?.name).toBe("Compact Inactive PUBG Player Cache");
    expect(step?.env).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
      SUPABASE_SERVICE_ROLE_KEY: "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
    });
    // 숫자 secret 은 로그의 같은 숫자를 *** 로 가린다. 쓰지 않는 값은 다시 참조하지 않는다.
    expect(content).not.toContain("CLEANUP_TARGET_VERSION");
    expect(content).not.toContain("CLEANUP_RETENTION_DAYS");
  });

  it("surfaces a failed data quality audit in the daily report instead of passing silently", () => {
    const workflow = loadYaml(readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8")) as {
      jobs: { maintenance: { steps: { id?: string; name?: string; run?: string; env?: Record<string, string>; "continue-on-error"?: boolean }[] } };
    };
    const steps = workflow.jobs.maintenance.steps;
    const auditIndex = steps.findIndex((step) => step.id === "data_quality_audit");
    const reportIndex = steps.findIndex((step) => step.name === "Send Daily DB and R2 Report");
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeLessThan(reportIndex);
    expect(steps[auditIndex]["continue-on-error"]).toBe(true);
    expect(steps[auditIndex].run).toContain("--page-size 100");
    expect(steps[reportIndex].env).toMatchObject({
      DATA_QUALITY_AUDIT_OUTCOME: "${{ steps.data_quality_audit.outcome }}",
      DATA_QUALITY_MISMATCH_COUNT: "${{ steps.data_quality_audit.outputs.mismatch_count }}",
    });
  });

  it("fails the monitor step only when a configured Discord alert was not delivered", () => {
    const source = readFileSync(join(process.cwd(), ".github/workflows/daily-tasks.yml"), "utf-8");
    const workflow = loadYaml(source) as MaintenanceWorkflow;
    const run = workflow.jobs.maintenance.steps.find((step) => step.name === "Record Agent Monitor Snapshot")?.run;
    expect(run).toBeTruthy();

    const root = mkdtempSync(join(tmpdir(), "bgms-monitor-workflow-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), '#!/bin/sh\nprintf \'%s\' "$FAKE_RESPONSE"\n', { mode: 0o755 });

    try {
      const invoke = (notification: Record<string, unknown>) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", run!], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          APP_URL: "https://monitor.invalid",
          ADMIN_AGENT_CRON_SECRET: "ci-placeholder-secret",
          CRON_SECRET: "",
          FAKE_RESPONSE: JSON.stringify({ notification }),
        },
        encoding: "utf8",
      });

      for (const notification of [
        { configured: true, sent: false, reason: "no_alerts" },
        { configured: true, sent: false, reason: "cooldown" },
        { configured: false, sent: false, reason: "webhook_missing" },
        { configured: true, sent: true, reason: "alert_sent" },
      ]) expect(invoke(notification).status, notification.reason).toBe(0);

      for (const reason of ["http_error", "send_failed", "timeout", "receipt_missing"]) {
        expect(invoke({ configured: true, sent: false, reason }).status, reason).toBeGreaterThan(0);
      }
      expect(invoke({ configured: true, sent: false, reason: "unexpected" }).status).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
