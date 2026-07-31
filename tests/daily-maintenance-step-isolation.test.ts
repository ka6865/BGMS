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
  id?: string;
  if?: string;
  "continue-on-error"?: boolean;
};

type Workflow = {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};

const workflow = loadYaml(
  readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8"),
) as Workflow;

const maintenanceSteps = workflow.jobs.maintenance.steps ?? [];

// 데이터 작업 step 은 앞 step 실패로 skip 되어서는 안 된다.
// 2026-07-28 부터 3일 연속 cleanup 한 건의 실패로 뒤 9개 step 이 skip 되어
// 정리·스크래핑·패치노트 동기화가 멈춘 사고가 있었다.
const DATA_STEP_COMMANDS = [
  'npx tsx scripts/monitor_storage.ts --label "BEFORE"',
  "npx tsx scripts/cleanup_telemetry.ts",
  "npx tsx scripts/cleanup_ai_cache.ts",
  "npx tsx scripts/extract_bluezone.ts",
  "npx tsx scripts/sync_patch_notes.ts",
  'npx tsx scripts/monitor_storage.ts --label "AFTER"',
  "npx tsx scripts/cleanup_pubg_cache.ts",
  "npx tsx scripts/run_hotdrop.ts",
];

describe("일일 유지보수: 앞 step 실패가 뒤 step 을 막지 않는다", () => {
  it("의존성 설치 step 이 후속 조건 참조용 id 를 갖는다", () => {
    const install = maintenanceSteps.find((step) => step.run === "npm ci");
    expect(install).toBeTruthy();
    expect(install?.id).toBe("install");
  });

  it("모든 데이터 작업 step 이 install 성공 조건으로 실행된다", () => {
    for (const command of DATA_STEP_COMMANDS) {
      const step = maintenanceSteps.find((candidate) => candidate.run === command);
      expect(step, `step 을 찾지 못했습니다: ${command}`).toBeTruthy();
      expect(step?.if, `if 조건이 없습니다: ${command}`).toBeTruthy();
      expect(step?.if).toContain("!cancelled()");
      expect(step?.if).toContain("steps.install.outcome == 'success'");
    }
  });

  it("scraper step 도 앞 step 실패와 무관하게 실행된다", () => {
    const scraper = maintenanceSteps.find((step) => step.run === "npx tsx scripts/scrape_elite.ts");
    expect(scraper).toBeTruthy();
    expect(scraper?.if).toContain("steps.install.outcome == 'success'");
  });

  it("실패를 숨기지 않기 위해 데이터 작업 step 에 continue-on-error 를 쓰지 않는다", () => {
    for (const command of DATA_STEP_COMMANDS) {
      const step = maintenanceSteps.find((candidate) => candidate.run === command);
      expect(step?.["continue-on-error"] ?? false).toBe(false);
    }
  });

  it("checkout 과 setup step 에는 조건을 추가하지 않는다", () => {
    const setupSteps = maintenanceSteps.filter((step) => typeof step.run !== "string");
    expect(setupSteps.length).toBeGreaterThan(0);
    for (const step of setupSteps) {
      expect(step.if).toBeUndefined();
    }
  });
});
