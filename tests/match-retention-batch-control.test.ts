import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetentionBatchState, completeRetentionBatch, checkRetentionBatchBudget,
  runRetentionBatchControl } from "../scripts/match_retention_batch_control";

const now = Date.parse("2026-10-07T08:30:00Z");
const cursor = (id = "a") => ({ played_at: "2026-07-31T00:00:00Z", platform: "steam", match_id: id });
const manifest = (objects = 1, next = cursor()) => ({
  objects: Array.from({ length: objects }, () => ({})), matches: [{}], cursorGeneration: 8, nextCursor: next,
});
const applied = (count = 1) => ({ mode: "apply", deletedObjects: count, removedBytes: count * 100, backupBytes: count * 150 });

describe("continuous retention batch control", () => {
  it("continues successful batches and sums backup cost through the requested limit", () => {
    let state = createRetentionBatchState("apply", 2, now);
    state = completeRetentionBatch(state, manifest(), applied(), now + 1000);
    expect(state.stopReason).toBeNull();
    state = completeRetentionBatch(state, manifest(1, cursor("b")), applied(), now + 2000);
    expect(state).toMatchObject({ completedBatches: 2, deletedObjects: 2, removedBytes: 200,
      backupBytes: 300, stopReason: "batch-limit" });
  });
  it("continues zero-deletion pages when the inspected cursor advances", () => {
    let state = createRetentionBatchState("apply", 10, now);
    state = completeRetentionBatch(state, manifest(0), applied(0), now);
    expect(state.stopReason).toBeNull();
    state = completeRetentionBatch(state, manifest(0, cursor("b")), applied(0), now);
    expect(state.stopReason).toBeNull();
  });
  it("stops a stalled page but allows partial-match deletions with the same cursor", () => {
    let state = createRetentionBatchState("apply", 10, now);
    state = completeRetentionBatch(state, manifest(), applied(), now);
    state = completeRetentionBatch(state, manifest(), applied(), now);
    expect(state.stopReason).toBeNull();
    state = completeRetentionBatch(state, manifest(0), applied(0), now);
    expect(state.stopReason).toBe("no-progress");
  });
  it("ends at the empty final page and does not start a second pass", () => {
    let state = createRetentionBatchState("apply", 10, now);
    state = completeRetentionBatch(state, manifest(0), applied(0), now);
    state = completeRetentionBatch(state, { objects: [], matches: [], cursorGeneration: 9, nextCursor: null }, applied(0), now);
    expect(state.stopReason).toBe("end-of-pass");
    expect(() => completeRetentionBatch(state, manifest(), applied(), now)).toThrow();
  });

  it('keeps the first batch start position while later batches advance to the end', () => {
    let state = createRetentionBatchState('apply', 10, now);
    state = completeRetentionBatch(state, { ...manifest(), startedFromBeginning: true }, applied(), now);
    state = completeRetentionBatch(state, { ...manifest(), startedFromBeginning: false }, applied(), now);
    expect(state.startedFromBeginning).toBe(true);
  });
  it("continues the first partial match while the cursor remains at the beginning", () => {
    const m = { ...manifest(), nextCursor: null };
    expect(completeRetentionBatch(createRetentionBatchState("apply", 10, now), m, applied(), now).stopReason).toBeNull();
  });
  it("stops new work at the time budget while preserving completed counters", () => {
    const state = completeRetentionBatch(createRetentionBatchState("apply", 10, now), manifest(), applied(), now);
    expect(checkRetentionBatchBudget(state, now + 3_600_000)).toMatchObject({
      stopReason: "time-budget", completedBatches: 1, deletedObjects: 1,
    });
    expect(checkRetentionBatchBudget(state, now - 1).stopReason).toBe("time-budget");
  });
  it("keeps dry-run to one inspection and never counts deletes", () => {
    const state = createRetentionBatchState("dry-run", 10, now);
    expect(state.maxBatches).toBe(1);
    expect(completeRetentionBatch(state, manifest(), { mode: "dry-run" }, now)).toMatchObject({
      stopReason: "dry-run", deletedObjects: 0, completedBatches: 1,
    });
  });
  it("stops an exhausted explicit scope without declaring a completed global pass", () => {
    expect(completeRetentionBatch(createRetentionBatchState("apply", 10, now),
      { objects: [], matches: [{}] }, applied(0), now).stopReason).toBe("scope-exhausted");
  });
  it("rejects invalid options, incomplete deletion and excessive results", () => {
    for (const max of [0, 11, 1.5, NaN]) expect(() => createRetentionBatchState("apply", max, now)).toThrow();
    expect(() => createRetentionBatchState("unknown", 1, now)).toThrow();
    const state = createRetentionBatchState("apply", 10, now);
    for (const result of [{ ...applied(), mode: "dry-run" }, applied(0),
      { ...applied(), removedBytes: 33 * 1024 * 1024 }, { ...applied(), backupBytes: -1 }]) {
      expect(() => completeRetentionBatch(state, manifest(), result, now)).toThrow();
    }
    expect(() => completeRetentionBatch(state, manifest(51), applied(51), now)).toThrow();
    expect(state.completedBatches).toBe(0);
  });
});

describe("continuous retention CLI local files", () => {
  const folders: string[] = [];
  const original = { mode: process.env.OP_MODE, batches: process.env.OP_BATCHES, output: process.env.GITHUB_OUTPUT,
    started: process.env.OP_RUN_STARTED_AT, failed: process.env.OP_RUN_FAILED };
  afterEach(async () => {
    for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true });
    const values: Array<[string, string | undefined]> = [
      ["OP_MODE", original.mode], ["OP_BATCHES", original.batches], ["GITHUB_OUTPUT", original.output],
      ["OP_RUN_STARTED_AT", original.started], ["OP_RUN_FAILED", original.failed],
    ];
    for (const [key, value] of values) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });
  it("includes setup delay in the budget and reports failures separately from completed batches", async () => {
    const folder = await mkdtemp(join(tmpdir(), "bgms-retention-budget-"));
    folders.push(folder);
    const statePath = join(folder, "state.json");
    process.env.OP_MODE = "apply";
    process.env.OP_BATCHES = "10";
    process.env.OP_RUN_STARTED_AT = String(Date.now() - 3_600_000);
    process.env.GITHUB_OUTPUT = join(folder, "output");
    await runRetentionBatchControl(["init", statePath]);
    await runRetentionBatchControl(["gate", statePath]);
    expect(await readFile(process.env.GITHUB_OUTPUT, "utf8")).toBe("enabled=false\n");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.OP_RUN_FAILED = "true";
    await runRetentionBatchControl(["summary", statePath]);
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({
      scope: "completed-batches", failed: true, completedBatches: 0, stopReason: "time-budget",
    });
  });
  it("writes continuation only after a complete result and never copies raw identity into state", async () => {
    const folder = await mkdtemp(join(tmpdir(), "bgms-retention-control-"));
    folders.push(folder);
    const statePath = join(folder, "state.json");
    process.env.OP_MODE = "apply";
    process.env.OP_BATCHES = "2";
    process.env.GITHUB_OUTPUT = join(folder, "output");
    await runRetentionBatchControl(["init", statePath]);
    const initial = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest()));
    await writeFile(join(folder, "result.json"), JSON.stringify(applied(0)));
    await expect(runRetentionBatchControl(["complete", statePath, join(folder, "manifest.json"),
      join(folder, "result.json")])).rejects.toThrow();
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(initial);
    await writeFile(join(folder, "result.json"), JSON.stringify(applied()));
    await runRetentionBatchControl(["complete", statePath, join(folder, "manifest.json"), join(folder, "result.json")]);
    expect(await readFile(process.env.GITHUB_OUTPUT, "utf8")).toBe("continue=true\n");
    expect(await readFile(statePath, "utf8")).not.toContain("match_id");
  });
});
