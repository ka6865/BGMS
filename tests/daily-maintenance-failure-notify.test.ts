import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const loadYaml = (createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown }).load;
const classifier = createRequire(import.meta.url)(
  resolve("scripts/classify_daily_maintenance_failure.cjs"),
) as {
  classifyFailedStepLog(log: string, startedAt: string, completedAt: string, stepName?: string): string[];
  extractFailedStepRuntimeLines(log: string, startedAt: string, completedAt: string, stepName?: string): string[];
};

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};

type Workflow = {
  jobs: Record<string, {
    permissions?: Record<string, string>;
    needs?: string[];
    "timeout-minutes"?: number;
    steps?: WorkflowStep[];
  }>;
};

const workflowSource = readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8");
const workflow = loadYaml(workflowSource) as Workflow;
const notifyJob = workflow.jobs["failure-notify"];
const notifySteps = notifyJob.steps ?? [];
const notifyStep = notifySteps.find((step) => step.name === "Notify Discord On Failure");
const runStartedAt = "2026-10-04T21:23:55Z";
const runCompletedAt = "2026-10-04T21:24:43Z";

function timestamped(timestamp: string, message: string, stepName = "Extract Bluezone Statistics"): string {
  return "maintenance\t" + stepName + "\t" + timestamp + "Z " + message;
}

function writeFakeCommands(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "api" ]; then',
      '  case "$*" in',
      '    *"/actions/runs/123/jobs"*)',
      '      if [ "$LOOKUP_FAIL" = "1" ]; then exit 1; fi',
      "      printf '%s' \"$FAKE_JOBS_JSONL\"",
      "      ;;",
      '    *"/actions/runs/123"*) printf "%s" "2026-10-04T21:00:00Z" ;;',
      "    *) exit 1 ;;",
      "  esac",
      'elif [ "$1" = "run" ]; then',
      '  cat "$FAKE_LOG"',
      "else",
      "  exit 1",
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "curl"), '#!/bin/sh\ncat > "$CAPTURE_PATH"\n', { mode: 0o755 });
  return bin;
}

function failedStepLog(): string {
  return [
    timestamped("2026-10-04T21:20:00.0000000", "Analytics cleanup: rate limit rows removed", "Cleanup Analytics"),
    timestamped("2026-10-04T21:23:55.8800000", "##[group]Run npx tsx scripts/extract_bluezone.ts"),
    timestamped("2026-10-04T21:23:55.8810000", "curl --connect-timeout 10 --max-time 30"),
    timestamped("2026-10-04T21:23:55.8820000", "SYNC_RATE_LIMITED: false"),
    timestamped("2026-10-04T21:23:55.8830000", "rate_limited=false"),
    timestamped("2026-10-04T21:23:55.8840000", "HTTP 503"),
    timestamped("2026-10-04T21:23:55.8850000", "env:"),
    timestamped("2026-10-04T21:23:55.8860000", "  PUBG_API_KEY: hidden-secret"),
    timestamped("2026-10-04T21:23:55.8870000", "##[endgroup]"),
    timestamped("2026-10-04T21:23:56.3860000", "Bluezone Extractor started"),
    timestamped(
      "2026-10-04T21:24:20.0000000",
      "Unable to finish collection for accountId=private-account from https://private.example/data?token=private-token",
    ),
    timestamped(
      "2026-10-04T21:24:42.7780000",
      "자기장 데이터 수집을 완료하지 못했습니다. DB·PUBG 응답 및 실행 제한을 확인하세요.",
    ),
    timestamped("2026-10-04T21:24:42.8030000", "##[error]Process completed with exit code 1."),
    timestamped("2026-10-04T21:24:43.1000000", "HTTP 503 from a later step", "Sync Patch Notes"),
  ].join("\n");
}

function bluezoneRateLimitLog(): string {
  return [
    timestamped("2026-10-04T21:23:56.3860000", "자기장 데이터 수집 실패 {"),
    timestamped("2026-10-04T21:23:56.3870000", "  errorCode: 'bluezone-pubg-rate-limited'"),
    timestamped("2026-10-04T21:23:56.3880000", "}"),
    timestamped("2026-10-04T21:23:56.3890000", "accountId=private-account https://private.example/?token=secret"),
  ].join("\n");
}

function invokeNotification(options: { lookupFails?: boolean; log?: string } = {}) {
  const run = notifyStep?.run ?? "";
  const root = mkdtempSync(join(tmpdir(), "bgms-failure-notify-"));
  const bin = writeFakeCommands(root);
  const logPath = join(root, "job.log");
  const payloadPath = join(root, "payload.json");
  const jobs = [{
    id: 111,
    name: "maintenance",
    conclusion: "failure",
    steps: [{
      name: "Extract Bluezone Statistics",
      conclusion: "failure",
      started_at: runStartedAt,
      completed_at: runCompletedAt,
    }],
  }];

  writeFileSync(logPath, options.log ?? failedStepLog());
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: bin + ":" + (process.env.PATH ?? ""),
      FAKE_LOG: logPath,
      FAKE_JOBS_JSONL: JSON.stringify(jobs[0]),
      LOOKUP_FAIL: options.lookupFails ? "1" : "",
      CAPTURE_PATH: payloadPath,
      DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
      RUN_URL: "https://github.com/example/repo/actions/runs/123",
      QUOTA_RESULT: "success",
      SUPPORT_ATTACHMENT_RESULT: "success",
      MAINTENANCE_RESULT: "failure",
      MATCH_TYPE_BACKFILL_RESULT: "success",
      GH_TOKEN: "gh-token",
      REPOSITORY: "example/repo",
      RUN_ID: "123",
      SYNC_CANDIDATE_COUNT: "2",
      SYNC_SYNCED_IDENTITIES: "1",
      SYNC_NEW_MATCHES: "3",
      SYNC_LOCK_COLLISIONS: "0",
      SYNC_STOPPED_REASON: "none",
      SYNC_RATE_LIMIT_TRACKING_ERRORS: "0",
    },
    encoding: "utf8",
  });

  return { result, payloadPath, root };
}

describe("일일 유지보수 실패 알림이 실패 단계 런타임만 분류한다", () => {
  it("알림 job은 helper를 checkout하고 Actions read 권한을 유지한다", () => {
    const checkout = notifySteps.find((step) => step.name === "Checkout Notification Helper");

    expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout?.["continue-on-error"]).toBe(true);
    expect(notifyStep?.if).toBe("always()");
    expect(notifyStep?.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(notifyStep?.env?.RUN_ID).toBe("${{ github.run_id }}");
    expect(notifyStep?.env?.DISCORD_WEBHOOK_URL).toBe("${{ secrets.DISCORD_WEBHOOK_URL }}");
    expect(notifyJob.permissions).toEqual({ contents: "read", actions: "read" });
    expect(notifyJob["timeout-minutes"]).toBe(3);
  });

  it("실패 step metadata의 시간 구간과 job 결과 요약을 사용한다", () => {
    const run = notifyStep?.run ?? "";

    expect(run).toContain(".started_at");
    expect(run).toContain(".completed_at");
    expect(run).toContain('gh run view "${RUN_ID}" --job "${JOB_ID}" --log');
    expect(run).toContain("classify_daily_maintenance_failure.cjs");
    expect(run).toContain('"$STEP_NAME"');
    expect(run).toContain("FAILED_STEPS");
    expect(run).toContain("ERROR_LINES");
    expect(run).toContain("status_label");
    expect(run).not.toContain("grep -qiE");
    expect(run).not.toContain("step failure (details hidden)");
  });

  it("Analytics 정리, echoed 명령, 그룹/env, false flag의 문구를 실패 원인으로 오인하지 않는다", () => {
    const categories = classifier.classifyFailedStepLog(
      failedStepLog(),
      runStartedAt,
      runCompletedAt,
      "Extract Bluezone Statistics",
    );
    const runtimeLines = classifier.extractFailedStepRuntimeLines(
      failedStepLog(),
      runStartedAt,
      runCompletedAt,
      "Extract Bluezone Statistics",
    );

    expect(categories).toEqual([]);
    expect(runtimeLines.join("\n")).toContain("자기장 데이터 수집을 완료하지 못했습니다");
    expect(runtimeLines.join("\n")).not.toContain("connect-timeout");
    expect(runtimeLines.join("\n")).not.toContain("rate limit rows removed");
    expect(runtimeLines.join("\n")).not.toContain("SYNC_RATE_LIMITED");
    expect(runtimeLines.join("\n")).toContain("private-account");
  });

  it("실패 단계의 whitelisted HTTP 상태, rate limit, timeout만 고정된 분류로 반환한다", () => {
    const log = [
      timestamped("2026-10-04T21:23:56.0000000", "request failed with HTTP 503"),
      timestamped("2026-10-04T21:23:57.0000000", "upstream returned HTTP 429"),
      timestamped("2026-10-04T21:23:58.0000000", "ETIMEDOUT while calling https://private.example/path?key=secret"),
      timestamped("2026-10-04T21:23:59.0000000", "accountId=private-account"),
    ].join("\n");

    expect(classifier.classifyFailedStepLog(log, runStartedAt, runCompletedAt, "Extract Bluezone Statistics")).toEqual([
      "rate limit",
      "timeout",
      "HTTP 503",
    ]);
  });

  it("multiline Bluezone errorCode는 whitelist 카테고리만 Discord에 전달한다", () => {
    expect(classifier.classifyFailedStepLog(
      bluezoneRateLimitLog(),
      runStartedAt,
      runCompletedAt,
      "Extract Bluezone Statistics",
    )).toEqual(["Bluezone PUBG rate limit"]);

    const { result, payloadPath, root } = invokeNotification({ log: bluezoneRateLimitLog() });
    try {
      expect(result.status).toBe(0);
      const payloadText = readFileSync(payloadPath, "utf8");
      const payload = JSON.parse(payloadText) as { content: string };
      expect(payload.content).toContain("Bluezone PUBG rate limit");
      expect(payloadText).not.toContain("private-account");
      expect(payloadText).not.toContain("private.example");
      expect(payloadText).not.toContain("token=secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("명시적 error code나 HTTP 상태가 없는 실패는 unknown으로 남긴다", () => {
    const log = timestamped("2026-10-04T21:24:20.0000000", "operation failed for accountId=private-account");

    expect(classifier.classifyFailedStepLog(log, runStartedAt, runCompletedAt, "Extract Bluezone Statistics")).toEqual([]);
    expect(classifier.classifyFailedStepLog(log, "", runCompletedAt)).toEqual([]);
  });

  it("실행된 알림은 실패 단계와 동기화 요약을 보존하고 원문·비밀·식별자를 보내지 않는다", () => {
    const { result, payloadPath, root } = invokeNotification();

    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payloadText = readFileSync(payloadPath, "utf8");
      const payload = JSON.parse(payloadText) as { content: string; allowed_mentions: { parse: string[] } };

      expect(payload.allowed_mentions.parse).toEqual([]);
      expect(payload.content).toContain("maintenance / Extract Bluezone Statistics (failure)");
      expect(payload.content).toContain("데이터 유지보수: ❌ 실패");
      expect(payload.content).toContain("후보 수: 2");
      expect(payload.content).toContain("신규 매치 수: 3");
      expect(payload.content).toContain("원인 미확인");
      expect(payload.content).toContain("실행 로그: https://github.com/example/repo/actions/runs/123");
      for (const privateValue of [
        "private-account",
        "private-token",
        "hidden-secret",
        "https://private.example/data",
        "Unable to finish collection",
      ]) {
        expect(payloadText).not.toContain(privateValue);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("잡 metadata 조회 실패에도 작업별 상태 요약과 unknown 알림을 보낸다", () => {
    const { result, payloadPath, root } = invokeNotification({ lookupFails: true });

    try {
      expect(result.status).toBe(0);
      const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as { content: string };
      expect(payload.content).toContain("실패 잡 목록 조회 실패");
      expect(payload.content).toContain("원인 미확인");
      expect(payload.content).toContain("데이터 유지보수: ❌ 실패");
      expect(payload.content).not.toContain("private-account");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("webhook이 없으면 발송을 건너뛰고 종료한다", () => {
    const run = notifyStep?.run ?? "";
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
      env: { ...process.env, DISCORD_WEBHOOK_URL: "" },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DISCORD_WEBHOOK_URL is missing");
  });
});
