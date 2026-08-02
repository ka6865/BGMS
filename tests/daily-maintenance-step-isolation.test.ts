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
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, { steps?: WorkflowStep[]; needs?: string; if?: string }>;
};

const workflow = loadYaml(
  readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8"),
) as Workflow;

const maintenanceSteps = workflow.jobs.maintenance.steps ?? [];

// 데이터 작업 step 은 일반 앞 step 실패로 skip 되어서는 안 되지만,
// 명시적인 DB health gate 실패 시에는 추가 부하를 만들지 않아야 한다.
// 2026-07-28 부터 3일 연속 cleanup 한 건의 실패로 뒤 9개 step 이 skip 되어
// 정리·스크래핑·패치노트 동기화가 멈춘 사고가 있었다.
const HEALTH_GATED_COMMANDS = [
  "npx tsx scripts/backup_core_tables.ts",
  'npx tsx scripts/monitor_storage.ts --label "BEFORE"',
  "npx tsx scripts/cleanup_telemetry.ts",
  "npx tsx scripts/cleanup_ai_cache.ts",
  "npx tsx scripts/cleanup_analytics_events.ts",
  "npx tsx scripts/cleanup_match_stats_raw.ts --apply",
  "npx tsx scripts/audit_processed_telemetry_identity.ts --recent-days 2 --max-rows 1000 --target-limit 50",
  "npx tsx scripts/scrape_elite.ts",
  "npx tsx scripts/extract_bluezone.ts",
  "npx tsx scripts/sync_patch_notes.ts",
  'npx tsx scripts/monitor_storage.ts --label "AFTER"',
  "npx tsx scripts/cleanup_pubg_cache.ts",
  "npx tsx scripts/run_hotdrop.ts",
];
const DATA_STEP_COMMANDS = HEALTH_GATED_COMMANDS.filter(
  (command) => command !== "npx tsx scripts/audit_processed_telemetry_identity.ts --recent-days 2 --max-rows 1000 --target-limit 50",
);

describe("일일 유지보수: 앞 step 실패가 뒤 step 을 막지 않는다", () => {
  it("workflow 중복 실행을 허용하지 않는다", () => {
    expect(workflow.concurrency).toEqual({
      group: "daily-bgms-maintenance",
      "cancel-in-progress": false,
    });
  });

  it("의존성 설치 step 이 후속 조건 참조용 id 를 갖는다", () => {
    const install = maintenanceSteps.find((step) => step.run === "npm ci");
    expect(install).toBeTruthy();
    expect(install?.id).toBe("install");
  });

  it("DB health gate가 install 직후 실행된다", () => {
    const installIndex = maintenanceSteps.findIndex((step) => step.run === "npm ci");
    const gateIndex = maintenanceSteps.findIndex(
      (step) => step.run === "npx tsx scripts/check_database_maintenance_health.ts",
    );
    expect(gateIndex).toBe(installIndex + 1);
    expect(maintenanceSteps[gateIndex]?.id).toBe("database_health");
    expect(maintenanceSteps[gateIndex]?.if).toContain("steps.install.outcome == 'success'");
  });

  it("모든 데이터 작업 step 이 install과 DB health gate 성공 조건으로 실행된다", () => {
    for (const command of HEALTH_GATED_COMMANDS) {
      const step = maintenanceSteps.find((candidate) => candidate.run === command);
      expect(step, `step 을 찾지 못했습니다: ${command}`).toBeTruthy();
      expect(step?.if, `if 조건이 없습니다: ${command}`).toBeTruthy();
      expect(step?.if).toContain("!cancelled()");
      expect(step?.if).toContain("steps.install.outcome == 'success'");
      expect(step?.if).toContain("steps.database_health.outcome == 'success'");
    }
  });

  it("scraper step 도 앞 step 실패와 무관하게 실행된다", () => {
    const scraper = maintenanceSteps.find((step) => step.run === "npx tsx scripts/scrape_elite.ts");
    expect(scraper).toBeTruthy();
    expect(scraper?.if).toContain("steps.install.outcome == 'success'");
    expect(scraper?.if).toContain("steps.database_health.outcome == 'success'");
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
