import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readerPaths = [
  "app/api/pubg/battle/route.ts",
  "actions/rankings.ts",
  "lib/pubg-analysis/squadAnalysis.ts",
] as const;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function globalBenchmarkQueryBlocks(source: string): string[] {
  const starts = Array.from(source.matchAll(/\.from\((['"])global_benchmarks\1\)/g))
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);

  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
}

describe("global_benchmarks reader population contract", () => {
  it("gates every direct reader so legacy rows cannot be returned", () => {
    const blocks = readerPaths.flatMap((path) => globalBenchmarkQueryBlocks(read(path)));

    expect(blocks).toHaveLength(6);
    for (const block of blocks) {
      expect(block).toMatch(/\.eq\(\s*[\"']filter_version[\"']\s*,\s*(?:8|BENCHMARK_FILTER_VERSION)\s*\)/);
      expect(block).toMatch(/\.eq\(\s*[\"']population_evidence_version[\"']\s*,\s*(?:1|BENCHMARK_POPULATION_EVIDENCE_VERSION|POPULATION_EVIDENCE_VERSION)\s*\)/);
      expect(block).toMatch(/\.in\(\s*[\"']match_type[\"']\s*,\s*\[\s*[\"']official[\"']\s*,\s*[\"']competitive[\"']\s*\]\s*\)/);
      expect(block).toMatch(/\.in\(\s*[\"']game_mode[\"']/);
    }
  });

  it("keeps battle comparisons inside the six canonical human BR modes", () => {
    const battle = globalBenchmarkQueryBlocks(read(readerPaths[0]));
    expect(battle).toHaveLength(1);
    expect(battle[0]).toMatch(
      /\.in\(\s*[\"']game_mode[\"']\s*,\s*\[\s*[\"']solo[\"']\s*,\s*[\"']solo-fpp[\"']\s*,\s*[\"']duo[\"']\s*,\s*[\"']duo-fpp[\"']\s*,\s*[\"']squad[\"']\s*,\s*[\"']squad-fpp[\"']\s*\]/,
    );
  });
});
