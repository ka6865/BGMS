import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const workflowDirectory = join(process.cwd(), ".github/workflows");
const workflowFiles = readdirSync(workflowDirectory).filter((file) => file.endsWith(".yml"));

describe("GitHub Actions workflow permissions and action pins", () => {
  it("grants only read access and pins every workflow action to a verified full SHA", () => {
    expect(workflowFiles).toHaveLength(9);
    for (const file of workflowFiles) {
      const source = readFileSync(join(workflowDirectory, file), "utf8");
      expect(source, file).toMatch(/^permissions:\n  contents: read$/m);
      expect(source, file).not.toMatch(/uses:\s*[^\s@]+@v\d+/);
      expect(source, file).not.toMatch(/actions\/(?:checkout|setup-node)@v4/);

      const checkoutUses = [...source.matchAll(/uses:\s*actions\/checkout@([0-9a-f]{40})\s+#\s+v([\d.]+)/g)];
      const setupNodeUses = [...source.matchAll(/uses:\s*actions\/setup-node@([0-9a-f]{40})\s+#\s+v([\d.]+)/g)];
      for (const match of checkoutUses) expect(match[1]).toBe("3d3c42e5aac5ba805825da76410c181273ba90b1");
      for (const match of setupNodeUses) expect(match[1]).toBe("820762786026740c76f36085b0efc47a31fe5020");
      expect(checkoutUses.length, file).toBe((source.match(/uses:\s*actions\/checkout@/g) ?? []).length);
      expect(setupNodeUses.length, file).toBe((source.match(/uses:\s*actions\/setup-node@/g) ?? []).length);
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
