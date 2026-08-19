import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// js-yaml 은 타입 선언이 없어 기존 워크플로 테스트와 동일한 방식으로 로드한다.
const loadYaml = (createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
}).load;

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};

type Workflow = {
  jobs: Record<string, {
    permissions?: Record<string, string>;
    steps?: WorkflowStep[];
  }>;
};

const workflowSource = readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8");
const workflow = loadYaml(workflowSource) as Workflow;
const notifyJob = workflow.jobs["failure-notify"];
const notifyStep = (notifyJob.steps ?? []).find((step) => step.name === "Notify Discord On Failure");

describe("일일 유지보수 실패 알림이 원인을 함께 전달한다", () => {
  it("알림 step 이 존재한다", () => {
    expect(notifyStep).toBeTruthy();
    expect(typeof notifyStep?.run).toBe("string");
  });

  it("실패 step 과 원인 로그 조회에 필요한 환경변수를 갖는다", () => {
    const env = notifyStep?.env ?? {};
    expect(env.GH_TOKEN).toBe("${{ github.token }}");
    expect(env.REPOSITORY).toBe("${{ github.repository }}");
    expect(env.RUN_ID).toBe("${{ github.run_id }}");
    expect(env.RUN_STARTED_AT).toBe("${{ github.run_started_at }}");
    expect(env.DISCORD_WEBHOOK_URL).toBe("${{ secrets.DISCORD_WEBHOOK_URL }}");
  });

  it("워크플로 로그 조회를 위해 actions read 권한을 최소 범위로 갖는다", () => {
    expect(notifyJob.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("실패한 step 이름과 원인 로그를 메시지에 포함한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("FAILED_STEPS");
    expect(run).toContain("ERROR_LINES");
    expect(run).toContain("실패한 단계");
    expect(run).toContain("가능한 원인");
    expect(run).toContain("운영자가 지금 할 일");
  });

  it("연동 PUBG 동기화의 집계 결과만 실패 알림에 전달한다", () => {
    const env = notifyStep?.env ?? {};
    const run = notifyStep?.run ?? "";

    expect(env.SYNC_CANDIDATE_COUNT).toBe("${{ needs.maintenance.outputs.candidate_count }}");
    expect(env.SYNC_SYNCED_IDENTITIES).toBe("${{ needs.maintenance.outputs.synced_identities }}");
    expect(env.SYNC_NEW_MATCHES).toBe("${{ needs.maintenance.outputs.new_matches }}");
    expect(env.SYNC_LOCK_COLLISIONS).toBe("${{ needs.maintenance.outputs.lock_collisions }}");
    expect(env.SYNC_STOPPED_REASON).toBe("${{ needs.maintenance.outputs.stopped_reason }}");
    expect(env.SYNC_RATE_LIMIT_TRACKING_ERRORS).toBe(
      "${{ needs.maintenance.outputs.rate_limit_tracking_errors }}",
    );
    expect(run).toContain("SYNC_RATE_LIMIT_TRACKING_ERRORS");
    expect(run).toContain("연동 PUBG 전적 동기화");
    expect(run).not.toMatch(/displayNickname|normalizedNickname|pubg_nickname|account_id/);
  });

  it("원인 추출은 원본 로그 대신 고정된 분류만 사용한다", () => {
    const run = notifyStep?.run ?? "";

    expect(run).not.toContain("MATCHED_LINES");
    expect(run).toContain("step failure (details hidden)");
    expect(run).toContain("Hotdrop failure");
    expect(run).toContain("PUBG API failure");
    expect(run).toContain("rate limit");
    expect(run).toContain("timeout");
    expect(run).toContain("HTTP ");
  });

  it("실행된 실패 로그가 식별자·비밀·명령을 Discord payload로 넘기지 않는다", () => {
    const run = notifyStep?.run ?? "";
    const root = mkdtempSync(join(tmpdir(), "bgms-failure-notify-"));
    const bin = join(root, "bin");
    const logPath = join(root, "job.log");
    const payloadPath = join(root, "payload.json");
    const markerPath = join(root, "shell-metacharacter-ran");
    const rawValues = [
      "pubg-abc123",
      "pubg-hyphen-456",
      "pubg-space-789",
      "secret-account-321",
      "Linked_Player",
      "https://user:password@example.com/private?token=super-secret",
      "Bearer super-secret-token",
      markerPath,
    ];
    const adversarialLog = [
      "Error: playerId=pubg-abc123 failed",
      "Error: player-id=pubg-hyphen-456 failed",
      "Error: player id=pubg-space-789 failed",
      "Error: accountId=secret-account-321 failed",
      "Error: Linked_Player failed",
      "Linked_Player",
      "Error: https://user:password@example.com/private?token=super-secret",
      "Error: Bearer super-secret-token",
      `Error: $(touch ${markerPath}) ; touch ${markerPath} ; \`touch ${markerPath}\``,
      "rate limit reached",
      "request timeout while fetching data",
      "HTTP 503 from upstream",
      "Hotdrop 수집 실패: PUBG API error 429",
      "PUBG API error 500",
    ].join("\n");

    try {
      writeFileSync(logPath, adversarialLog);
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh
case "$*" in
  *"/logs"*) cat "$FAKE_LOG" ;;
  *) printf '123\\tmaintenance\\tfailure\\n' ;;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "curl"),
        '#!/bin/sh\ncat > "$CAPTURE_PATH"\n',
        { mode: 0o755 },
      );

      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          CAPTURE_PATH: payloadPath,
          DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
          RUN_URL: "https://github.com/example/repo/actions/runs/123",
          QUOTA_RESULT: "success",
          MAINTENANCE_RESULT: "failure",
          MATCH_TYPE_BACKFILL_RESULT: "success",
          RUN_STARTED_AT: "2026-08-19T00:00:00Z",
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

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(existsSync(markerPath)).toBe(false);
      const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as { content: string };
      expect(payload.content).toContain("rate limit");
      expect(payload.content).toContain("timeout");
      expect(payload.content).toContain("HTTP 503");
      expect(payload.content).toContain("Hotdrop failure");
      expect(payload.content).toContain("PUBG API failure");
      expect(payload.content).toContain("step failure (details hidden)");
      for (const rawValue of rawValues) {
        expect(readFileSync(payloadPath, "utf8")).not.toContain(rawValue);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("알림 잡 자신의 로그를 원인 추출 대상에서 제외한다", () => {
    // 알림 잡 로그에는 메시지 템플릿 문자열이 남아 원인으로 오인된다.
    expect(notifyStep?.run ?? "").toContain('.name != "failure-notify"');
    expect(notifyStep?.run ?? "").toContain("actions/jobs/${JOB_ID}/logs");
  });

  it("실제 오류가 앞부분의 환경변수 로그에 묻히지 않게 마지막 오류 후보를 사용한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("tail -n 8");
    expect(run).not.toContain("|429|rate limit|timeout|timed out|supabase");
  });

  it("조회 실패 시에도 알림 자체는 발송한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("실패 잡 목록 조회 실패");
    expect(run).toContain("원인 미확인: 실패 잡 로그에서 분류 가능한 예외를 찾지 못했습니다.");
  });

  it("메시지는 실제 개행을 가진 운영 요약으로 전송한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("MESSAGE=$(cat <<EOF");
    expect(run).toContain("allowed_mentions: {parse: [\"everyone\"]}");
    expect(run).not.toContain('printf \'%s\' \\\n            "🚨');
  });

  it("webhook 이 없으면 조용히 종료한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("DISCORD_WEBHOOK_URL is missing");
    expect(run).toContain("exit 0");
  });
});
