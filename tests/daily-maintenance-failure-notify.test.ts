import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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
    expect(env.DISCORD_WEBHOOK_URL).toBe("${{ secrets.DISCORD_WEBHOOK_URL }}");
  });

  it("워크플로 로그 조회를 위해 actions read 권한을 최소 범위로 갖는다", () => {
    expect(notifyJob.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("실패한 step 이름과 원인 로그를 메시지에 포함한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("FAILED_STEPS");
    expect(run).toContain("ERROR_LINES");
    expect(run).toContain("실패한 step");
    expect(run).toContain("원인 로그");
  });

  it("알림 잡 자신의 로그를 원인 추출 대상에서 제외한다", () => {
    // 알림 잡 로그에는 메시지 템플릿 문자열이 남아 원인으로 오인된다.
    expect(notifyStep?.run ?? "").toContain("! -name '*failure-notify*'");
  });

  it("조회 실패 시에도 알림 자체는 발송한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("실패 step 조회 실패");
    expect(run).toContain("원인 라인을 추출하지 못했습니다");
  });

  it("webhook 이 없으면 조용히 종료한다", () => {
    const run = notifyStep?.run ?? "";
    expect(run).toContain("DISCORD_WEBHOOK_URL is missing");
    expect(run).toContain("exit 0");
  });
});
