import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCalculationUpgrade } from "../scripts/calculation_upgrade_apply_runner";
import {
  acquireCalculationUpgradeCheckpointLock,
  saveCalculationUpgradeCheckpointAtomic,
} from "../scripts/calculation_upgrade_checkpoint";
import {
  buildCalculationUpgradeManifest,
  normalizeCalculationUpgradeLimits,
  type CalculationUpgradeManifest,
} from "../scripts/calculation_upgrade_batch";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "calculation-upgrade-runner-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(): CalculationUpgradeManifest {
  const fullResult = { v: 73, calculationVersion: 2, stats: { playerId: "player-a" } };
  const benchmark = { calculation_version: 2, match_id: "match-a", player_id: "player-a", damage: 120 };
  return buildCalculationUpgradeManifest({
    generatedAt: "2026-09-07T00:00:00.000Z",
    project: "example.supabase.co",
    calculationVersion: 2,
    limits: normalizeCalculationUpgradeLimits({ maxBatch: 1, maxScan: 1, maxWrites: 1, maxRequests: 8 }),
    counters: { databaseReads: 0, databaseWrites: 0, localSourceBytes: 0, providerCalls: 0, upstreamDownloads: 0, errors: 0 },
    decisions: [{ identity: { matchId: "match-a", platform: "steam", playerId: "player-a" }, status: "prepared", reasons: ["verified"], upgradeIndex: 0 }],
    upgrades: [{
      p_match_id: "match-a", p_platform: "steam", p_player_id: "player-a",
      p_expected_data: { fullResult: { v: 72 } }, p_expected_benchmark: {
        id: 1, match_id: "match-a", platform: "steam", player_id: "player-a", created_at: "2026-09-07T00:00:00.000Z",
        damage: 1, kills: 1, win_place: 1, game_mode: "squad", match_type: "competitive",
        filter_version: 8, population_evidence_version: 1, calculation_version: 1,
        source: "user",
      },
      p_full_result: fullResult, p_benchmark: benchmark,
    }],
  });
}

function emptyCurrent() {
  return { processed: { data: { fullResult: { v: 72 } } }, benchmark: { calculation_version: 1 } };
}

describe("calculation upgrade apply runner", () => {
  it("stops without writing when a prepared canonical row has disappeared", async () => {
    const database = { readCurrent: vi.fn(async () => ({ processed: null, benchmark: null })), upgrade: vi.fn() };
    const result = await runCalculationUpgrade({ manifest: manifest(), database, saveCheckpoint: async () => {} });
    expect(result.stopped).toBe("contended");
    expect(result.manifest.counters.databaseWrites).toBe(0);
    expect(database.upgrade).not.toHaveBeenCalled();
  });

  it("resumes a transient interruption and only writes after the next preflight read", async () => {
    const checkpoints: CalculationUpgradeManifest[] = [];
    const next = manifest().upgrades[0] as any;
    let current = emptyCurrent();
    let attempts = 0;
    const database = {
      readCurrent: vi.fn(async () => current),
      upgrade: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return { data: null, error: { status: 503, message: "connection reset" } };
        current = { processed: { data: { fullResult: next.p_full_result } }, benchmark: next.p_benchmark };
        return { data: true, error: null };
      }),
    };
    const first = await runCalculationUpgrade({ manifest: manifest(), database, saveCheckpoint: async (next) => { checkpoints.push(structuredClone(next)); } });
    expect(first.stopped).toBe("transient_failed");
    expect(first.manifest.decisions[0]?.status).toBe("transient_failed");
    expect(first.manifest.counters).toMatchObject({ databaseReads: 2, databaseWrites: 1, errors: 1 });

    const resumed = await runCalculationUpgrade({ manifest: first.manifest, database, saveCheckpoint: async (next) => { checkpoints.push(structuredClone(next)); } });
    expect(resumed.manifest.phase).toBe("completed");
    expect(resumed.manifest.decisions[0]?.status).toBe("completed");
    expect(database.upgrade).toHaveBeenCalledTimes(2);
    expect(checkpoints.at(-1)?.phase).toBe("completed");
  });

  it("recovers an unknown committed RPC without repeating the CAS write", async () => {
    const next = manifest().upgrades[0] as any;
    let current = emptyCurrent();
    const database = {
      readCurrent: vi.fn(async () => current),
      upgrade: vi.fn(async () => {
        current = { processed: { data: { fullResult: next.p_full_result } }, benchmark: next.p_benchmark };
        throw Object.assign(new Error("request timed out"), { status: 504 });
      }),
    };
    const first = await runCalculationUpgrade({ manifest: manifest(), database, saveCheckpoint: async () => {} });
    expect(first.stopped).toBe("transient_failed");
    expect(first.manifest.decisions[0]?.status).toBe("transient_failed");

    const resumed = await runCalculationUpgrade({ manifest: first.manifest, database, saveCheckpoint: async () => {} });
    expect(resumed.manifest.decisions[0]?.status).toBe("completed");
    expect(database.upgrade).toHaveBeenCalledTimes(1);
  });

  it("counts a rejected preflight read before awaiting it and makes no RPC write", async () => {
    const database = {
      readCurrent: vi.fn(async () => { throw Object.assign(new Error("read timed out"), { status: 504 }); }),
      upgrade: vi.fn(),
    };
    const result = await runCalculationUpgrade({ manifest: manifest(), database, saveCheckpoint: async () => {} });
    expect(result.stopped).toBe("transient_failed");
    expect(result.manifest.counters).toMatchObject({ databaseReads: 2, databaseWrites: 0, errors: 1 });
    expect(database.upgrade).not.toHaveBeenCalled();
  });

  it("atomically replaces checkpoints and rejects a concurrent checkpoint owner", async () => {
    const directory = await temporaryDirectory();
    const checkpoint = join(directory, "checkpoint.json");
    const first = await acquireCalculationUpgradeCheckpointLock(checkpoint);
    await expect(acquireCalculationUpgradeCheckpointLock(checkpoint)).rejects.toThrow("checkpoint_locked");
    await saveCalculationUpgradeCheckpointAtomic(checkpoint, manifest());
    expect(JSON.parse(await readFile(checkpoint, "utf8")).phase).toBe("prepared");
    await first.release();
    const second = await acquireCalculationUpgradeCheckpointLock(checkpoint);
    await second.release();
  });

  it("CLI dry-run never creates a checkpoint or invokes an apply path", async () => {
    const directory = await temporaryDirectory();
    const plan = join(directory, "plan.json");
    await writeFile(plan, JSON.stringify(manifest()));
    const { stdout } = await execFileAsync(resolve("node_modules/.bin/tsx"), ["scripts/apply_calculation_upgrade_batch.ts", "--plan", plan], { cwd: process.cwd() });
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, phase: "prepared" });
    await expect(readFile(`${plan}.checkpoint.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
