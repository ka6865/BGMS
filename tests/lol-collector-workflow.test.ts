import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
const workflow = yaml.load(readFileSync(join(process.cwd(), ".github/workflows/lol-champion-stats.yml"), "utf8"));
const job = workflow.jobs.collect;
const collectorStep = job.steps.find((step: { name?: string }) => step.name === "제한된 챔피언 통계 수집");

describe("LoL champion stats workflow", () => {
  it("runs every three hours only on main when the schedule flag is enabled", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "31 */3 * * *" }]);
    expect(job.if).toBe("github.ref == 'refs/heads/main' && (github.event_name != 'schedule' || vars.LOL_CHAMPION_STATS_ENABLED == 'true')");
    expect(workflow.concurrency).toEqual({ group: "lol-champion-stats", "cancel-in-progress": false });
    expect(job["timeout-minutes"]).toBe(20);
  });

  it("defaults manual runs to dry-run and uses the bounded collector options", () => {
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: "boolean", default: true });
    expect(collectorStep.run).toContain("if [ \"$GITHUB_EVENT_NAME\" = 'schedule' ]; then");
    expect(collectorStep.run).toContain("collector_mode=--apply");
    expect(collectorStep.run).toContain("collector_mode=--dry-run");
    expect(collectorStep.run).toContain("$LOL_CHAMPION_STATS_DRY_RUN");
    expect(collectorStep.run).toContain('npx tsx scripts/lol_collect_champion_stats.ts "$collector_mode" --per-2min=20 --timeline-ratio=0.5 --max-minutes=15');
  });

  it("reuses the existing secrets and maps the approved flag to collector writes", () => {
    expect(collectorStep.env).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
      SUPABASE_SERVICE_ROLE_KEY: "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
      RIOT_API_KEY: "${{ secrets.RIOT_API_KEY }}",
      LOL_CHAMPION_STATS_ENABLED: "${{ vars.LOL_CHAMPION_STATS_ENABLED }}",
      LOL_COLLECT_ENABLED: "${{ vars.LOL_CHAMPION_STATS_ENABLED }}",
      LOL_PERSISTENCE_ENABLED: "true",
      LOL_RIOT_PRIORITY: "background",
    });
  });

  it("pins the existing actions and runs Node 22 with read-only workflow permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false },
    });
    expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/setup-node@"))).toMatchObject({
      uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      with: { "node-version": "22", cache: "npm" },
    });
  });
});
