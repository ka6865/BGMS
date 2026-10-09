import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const workflowDirectory = join(process.cwd(), ".github/workflows");
const workflowFiles = readdirSync(workflowDirectory).filter((file) => file.endsWith(".yml"));

describe("GitHub Actions workflow permissions and action pins", () => {
  it("archive cleanup pipeline failures stop the workflow before subsequent steps", () => {
    const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
    const config = yaml.load(readFileSync(join(workflowDirectory, "pubg-archive-retention.yml"), "utf8"));
    expect(config.defaults.run.shell).toBe("bash");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c",
      "(exit 23) | tee /dev/null\nprintf 'UNSAFE_NEXT_STEP'"], { encoding: "utf8" });
    expect(result.status).toBe(23);
    expect(result.stdout).not.toContain("UNSAFE_NEXT_STEP");
  });

  it("grants only read access and pins every workflow action to a verified full SHA", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(workflowFiles).toContain("pr-verify.yml");
    for (const file of workflowFiles) {
      const source = readFileSync(join(workflowDirectory, file), "utf8");
      expect(source, file).toMatch(/^permissions:\n  contents: read$/m);
      expect(source, file).not.toMatch(/uses:\s*[^\s@]+@v\d+/);
      expect(source, file).not.toMatch(/actions\/(?:checkout|setup-node)@v4/);
      for (const action of source.matchAll(/uses:\s*([^\s#]+)/g)) {
        if (action[1].startsWith("./")) {
          expect(action[1], file).toBe("./.github/actions/pubg-retention-batch");
          continue;
        }
        expect(action[1], file).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/);
      }

      const checkoutUses = [...source.matchAll(/uses:\s*actions\/checkout@([0-9a-f]{40})\s+#\s+v([\d.]+)/g)];
      const setupNodeUses = [...source.matchAll(/uses:\s*actions\/setup-node@([0-9a-f]{40})\s+#\s+v([\d.]+)/g)];
      const artifactUses = [...source.matchAll(/uses:\s*actions\/upload-artifact@([0-9a-f]{40})\s+#\s+v([\d.]+)/g)];
      for (const match of checkoutUses) expect(match[1]).toBe("3d3c42e5aac5ba805825da76410c181273ba90b1");
      for (const match of setupNodeUses) expect(match[1]).toBe("820762786026740c76f36085b0efc47a31fe5020");
      for (const match of artifactUses) expect(match[1]).toBe("043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
      expect(checkoutUses.length, file).toBe((source.match(/uses:\s*actions\/checkout@/g) ?? []).length);
      expect(setupNodeUses.length, file).toBe((source.match(/uses:\s*actions\/setup-node@/g) ?? []).length);
      expect(artifactUses.length, file).toBe((source.match(/uses:\s*actions\/upload-artifact@/g) ?? []).length);
      if (checkoutUses.length) expect(source.match(/persist-credentials: false/g)).toHaveLength(checkoutUses.length);
    }
  });

  it("runs isolated migration verification as a required pull request job", () => {
    const source = readFileSync(join(workflowDirectory, "pr-verify.yml"), "utf8");
    expect(source).toContain("verify-migrations:");
    expect(source).toContain("timeout-minutes: 20");
    expect(source).toContain("sudo apt-get install --yes postgresql-client");
    expect(source).toContain("npm run verify:migrations");
    expect(source).toContain("audit-production-dependencies:");
    expect(source).toContain("npm audit --omit=dev --audit-level=high");
    expect(source).not.toMatch(/\$\{\{\s*secrets\./);
    const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
    const config = yaml.load(source) as { jobs: Record<string, { env?: Record<string, string> }> };
    for (const job of ["verify-migrations", "audit-production-dependencies"]) {
      expect(config.jobs[job].env ?? {}, job).toEqual({});
    }
    expect(Object.values(config.jobs.verify.env ?? {}).every((value) => value.includes("ci-placeholder"))).toBe(true);
  });
  it.each([
    [true, false, 0, false],
    [false, false, 0, true],
    [false, true, 23, true],
  ])('reuses a working client and fails closed on installation failure (%s/%s)', (ready, installFails, status, installs) => {
    const yaml = createRequire(import.meta.url)("js-yaml") as {load(text: string): any};
    const config = yaml.load(readFileSync(join(workflowDirectory, "pr-verify.yml"), "utf8"));
    const script = config.jobs['verify-migrations'].steps.find((step: {name?: string}) => step.name === 'Ensure PostgreSQL client').run;
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `
      client_ready=${ready};
      psql() { if "$client_ready"; then echo CLIENT_READY; else return 1; fi; }
      sudo() { echo INSTALL_CALL; if [[ "$*" == 'apt-get install --yes postgresql-client' ]]; then
        if ${installFails}; then return 23; fi; client_ready=true; fi; }
      ${script}
    `], {encoding: 'utf8'});
    expect(result.status).toBe(status);
    expect(result.stdout.includes('INSTALL_CALL')).toBe(installs);
    expect(result.stdout.includes('CLIENT_READY')).toBe(status === 0);
  });

  it("schedules grouped monthly patch/minor updates and ignores major version updates", () => {
    const source = readFileSync(join(process.cwd(), ".github/dependabot.yml"), "utf8");
    const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
    const config = yaml.load(source) as {
      updates: {
        "package-ecosystem": string;
        schedule: { interval: string };
        groups: Record<string, { "update-types": string[] }>;
        ignore: { "dependency-name": string; "update-types": string[] }[];
      }[];
    };
    expect(config.updates.map(({ "package-ecosystem": ecosystem }) => ecosystem)).toEqual(["npm", "github-actions"]);
    for (const update of config.updates) {
      expect(update.schedule.interval).toBe("monthly");
      expect(Object.values(update.groups).flatMap((group) => group["update-types"]).sort()).toEqual(["minor", "patch"]);
      expect(update.ignore).toContainEqual({
        "dependency-name": "*",
        "update-types": ["version-update:semver-major"],
      });
    }
  });

  it("fails community review processing errors while allowing deferred drafts", () => {
    const source = readFileSync(join(workflowDirectory, "community-reviews.yml"), "utf8");
    expect(source).toContain("['drafted', 'deferred', 'no_work']");
    expect(source).toContain("Review processing failed");
    expect(source).toContain("notification_failed");
  });
});
