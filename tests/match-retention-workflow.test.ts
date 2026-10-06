import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

describe("PUBG archive retention workflow contract", () => {
  it("keeps scheduled and manual cleanup bounded behind backup readback", () => {
    const source = readFileSync(join(process.cwd(), ".github/workflows/pubg-archive-retention.yml"), "utf8");
    const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
    const workflow = yaml.load(source);
    expect(workflow.on.schedule).toEqual([{ cron: "8,23,38,53 * * * *" }]);
    expect(workflow.on.workflow_dispatch.inputs.mode).toMatchObject({ default: "dry-run" });
    expect(workflow.on.workflow_dispatch.inputs.limit).toMatchObject({
      options: ["1", "3", "5", "20", "50"],
      default: "1",
    });
    expect(workflow.jobs.retain.timeout).toBeUndefined();
    expect(workflow.jobs.retain["timeout-minutes"]).toBe(15);
    expect(workflow.jobs.retain.env.OP_LIMIT).toContain("'50'");
    expect(source).toContain("--scan-limit \"$OP_SCAN_LIMIT\"");
    expect(source).toContain("OP_SCAN_LIMIT: '1000'");
    expect(source).toContain("--prepare-backup --preserve-performance");
    expect(source).toContain("retention-days: 7");
    expect(source).toContain("cmp \"$RUNNER_TEMP/match-retention/backup.enc\"");
    expect(source).toContain("--apply --backup-upload-verified");
    expect(source.indexOf("Verify uploaded backup bytes before deletion"))
      .toBeLessThan(source.indexOf("Apply exact plan and verify object absence"));
    expect(workflow.concurrency).toMatchObject({ group: "pubg-detail-archive-retention", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  });
});
