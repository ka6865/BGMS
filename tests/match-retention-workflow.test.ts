import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
const workflow = yaml.load(readFileSync(join(process.cwd(), ".github/workflows/pubg-archive-retention.yml"), "utf8"));
const actionSource = readFileSync(join(process.cwd(), ".github/actions/pubg-retention-batch/action.yml"), "utf8");
const action = yaml.load(actionSource);

describe("PUBG archive retention workflow contract", () => {
  it("serializes main-only cleanup with finite batch and time budgets", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "8,23,38,53 * * * *" }]);
    expect(workflow.on.workflow_dispatch.inputs.mode.default).toBe("dry-run");
    expect(workflow.on.workflow_dispatch.inputs.limit).toMatchObject({ options: ["1", "3", "5", "20", "50"], default: "1" });
    expect(workflow.on.workflow_dispatch.inputs.batches).toMatchObject({ options: ["1", "2", "5", "10"], default: "1" });
    expect(workflow.jobs.retain["timeout-minutes"]).toContain("inspect-recovery' && 15 || 90");
    expect(workflow.jobs.retain.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.retain.env.OP_LIMIT).toContain("'50'");
    expect(workflow.jobs.retain.env.OP_BATCHES).toContain("'10'");
    expect(workflow.jobs.retain.env.OP_SCAN_LIMIT).toBe("1000");
    expect(workflow.concurrency).toMatchObject({ group: "pubg-detail-archive-retention", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow.jobs.retain.env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(workflow.jobs.retain.steps[0]).toMatchObject({ id: "started" });
    const init = workflow.jobs.retain.steps.find((s: any) => s.name === "Initialize continuous batch budget");
    expect(init.env.OP_RUN_STARTED_AT).toContain("steps.started.outputs.timestamp");
    const batches = workflow.jobs.retain.steps.filter((s: any) => s.uses === "./.github/actions/pubg-retention-batch");
    expect(batches).toHaveLength(10);
    for (const [index, step] of batches.entries()) {
      expect(step.with.batch).toBe(String(index + 1));
      expect(step["timeout-minutes"]).toBe(20);
      expect(step.env.SUPABASE_SERVICE_ROLE_KEY).toContain("secrets.SUPABASE_SERVICE_ROLE_KEY");
      expect(step["continue-on-error"]).toBeUndefined();
      if (index > 0) expect(step.if).toContain("steps.batch" + index + ".outputs.continue == 'true'");
    }
  });

  it("requires each batch's own upload and download comparison before apply", () => {
    const steps = action.runs.steps;
    expect(action.runs.using).toBe("composite");
    const upload = steps.find((s: any) => s.id === "backup");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({ "retention-days": 7, "if-no-files-found": "error" });
    expect(upload.with.name).toContain("inputs.batch");
    expect(upload.with.path).toContain("steps.gate.outputs.directory");
    expect(actionSource).toContain("batch-$OP_BATCH_INDEX");
    expect(actionSource).toContain("--prepare-backup --preserve-performance");
    expect(actionSource).toContain('cmp "$OP_BATCH_DIRECTORY/backup.enc" "$OP_BATCH_DIRECTORY/readback/backup.enc"');
    expect(actionSource).toContain("--apply --backup-upload-verified");
    const verify = steps.findIndex((s: any) => s.name === "Verify uploaded backup bytes before deletion");
    const apply = steps.findIndex((s: any) => s.name === "Apply exact plan and verify object absence");
    expect(verify).toBeGreaterThan(steps.findIndex((s: any) => s.id === "backup"));
    expect(apply).toBeGreaterThan(verify);
    for (const step of steps.slice(1)) {
      expect(step.if).toContain("steps.gate.outputs.enabled == 'true'");
      expect(step.if).not.toMatch(/always\(|failure\(/);
      expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  it("propagates command and backup-comparison failures through every composite shell", () => {
    for (const step of action.runs.steps.filter((s: any) => s.run)) {
      expect(step.shell).toBe("bash --noprofile --norc -eo pipefail {0}");
      for (const failure of ["(exit 23) | tee /dev/null", "cmp /dev/null /missing-backup"]) {
        const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c",
          failure + "\nprintf 'UNSAFE_APPLY'"], { encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("UNSAFE_APPLY");
      }
    }
  });
});
