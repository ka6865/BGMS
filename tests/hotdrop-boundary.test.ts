import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const loadYaml = (createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
}).load;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

it("공개 hotdrop route와 Vercel Cron을 제공하지 않는다", () => {
  expect(existsSync(resolve("app/api/cron/hotdrop/route.ts"))).toBe(false);
  expect(existsSync(resolve("vercel.json"))).toBe(false);
});

it("GitHub Actions만 hotdrop script를 한 번 실행한다", () => {
  const workflow = readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8");
  const parsed: unknown = loadYaml(workflow);
  expect(isRecord(parsed)).toBe(true);
  if (!isRecord(parsed)) return;
  const triggers = parsed.on;
  const jobs = parsed.jobs;
  expect(isRecord(triggers)).toBe(true);
  expect(isRecord(jobs)).toBe(true);
  if (!isRecord(triggers) || !isRecord(jobs)) return;
  const schedule = triggers.schedule;
  const maintenance = jobs.maintenance;
  expect(schedule).toEqual([{ cron: "0 18 * * *" }]);
  expect(triggers).toHaveProperty("workflow_dispatch");
  expect(isRecord(maintenance)).toBe(true);
  if (!isRecord(maintenance)) return;
  const steps = maintenance.steps;
  expect(Array.isArray(steps)).toBe(true);
  if (!Array.isArray(steps)) return;
  const hotdropStep = steps.at(-1);
  expect(isRecord(hotdropStep)).toBe(true);
  if (!isRecord(hotdropStep)) return;
  expect(hotdropStep.name).toBe("Run Hotdrop Collection");
  expect(hotdropStep.run).toBe("npx tsx scripts/run_hotdrop.ts");
  expect(hotdropStep["continue-on-error"] ?? false).toBe(false);
  expect(hotdropStep.env).toEqual({
    PUBG_API_KEY: "${{ secrets.PUBG_API_KEY }}",
    NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
    SUPABASE_SERVICE_ROLE_KEY: "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
  });
  expect(workflow).toContain("id: sync_user_matches");
  expect(workflow).toContain("pubg_rate_limited: ${{ steps.sync_user_matches.outputs.rate_limited }}");
  expect(workflow).toContain("Skip Hotdrop After PUBG API Rate Limit");
  expect(workflow).toContain("steps.sync_user_matches.outputs.rate_limited != 'true'");
  expect(workflow.match(/npx tsx scripts\/run_hotdrop\.ts/g)).toHaveLength(1);
});

it("작업 모듈의 제품 consumer는 실행 script 하나뿐이다", () => {
  const productFiles = [
    ...collectTypeScriptFiles(resolve("app")),
    ...collectTypeScriptFiles(resolve("lib")),
    ...collectTypeScriptFiles(resolve("scripts")),
  ];
  const consumers = productFiles.filter((file) => (
    file !== resolve("lib/hotdrop/runHotdropCollection.ts")
      && readFileSync(file, "utf8").includes("runHotdropCollection")
  ));
  expect(consumers).toEqual([resolve("scripts/run_hotdrop.ts")]);
});
