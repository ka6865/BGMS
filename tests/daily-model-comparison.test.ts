import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeDailyModelSchedule,
  dailyComparisonDryRunReport,
  appendDailyComparisonRecord,
  isRetryableDailyModelError,
  parseDailyComparisonManifest,
  scheduleDailyModelRuns,
  type PreparedDailyMatch,
} from "../scripts/compare_daily_models";

const entry = {
  dayKst: "2026-09-23",
  matchId: "match-1",
  candidate: { accountId: "account.1", nickname: "player", rank: 1 },
  matchPath: "match.json",
  matchSha256: "a".repeat(64),
  telemetryPath: "telemetry.json",
  telemetrySha256: "b".repeat(64),
  requiredEvidenceGroups: [{ id: "revive", factIds: ["revive-1"] }],
} as const;

function prepared(missingGroups: string[] = []): PreparedDailyMatch {
  return {
    entry: { ...entry, candidate: { ...entry.candidate }, requiredEvidenceGroups: entry.requiredEvidenceGroups.map((group) => ({ ...group, factIds: [...group.factIds] })) },
    evidence: { matchId: "match-1", facts: [] } as any,
    inputHash: "input-hash", promptHash: "prompt-hash", scriptHash: "script-hash", promptVersion: "prompt-v1", evidenceVersion: 5, missingGroups,
  };
}

type MockDependencies = {
  modelsAvailable: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
};

const dependencies = (overrides: Partial<MockDependencies> = {}): MockDependencies => ({
  modelsAvailable: vi.fn(async () => new Set(["gemini-a", "gemini-b"])),
  generate: vi.fn(async () => ({ value: { sceneIds: ["scene-1"] }, rawText: '{"sceneIds":["scene-1"]}', usage: { totalTokenCount: 7 }, finishReason: "STOP", modelVersion: "v1" })),
  validate: vi.fn(() => ({ headline: "headline", conclusion: "text", points: [], selection: { usedFallback: false, rejectedReasons: [] } } as any)),
  append: vi.fn(async () => {}),
  now: vi.fn(() => 123),
  wait: vi.fn(async () => {}),
  ...overrides,
});

function runSchedule(preparedMatches: PreparedDailyMatch[], models: string[], runs: number, deps: MockDependencies, key: string, id: string) {
  return executeDailyModelSchedule(preparedMatches, models, runs, deps as unknown as Parameters<typeof executeDailyModelSchedule>[3], key, id);
}

describe("daily model comparison", () => {
  it("validates source hashes, account identity and required evidence groups in manifest shape", () => {
    expect(parseDailyComparisonManifest({ schemaVersion: 1, matches: [entry] }).matches).toHaveLength(1);
    expect(() => parseDailyComparisonManifest({ schemaVersion: 1, matches: [{ ...entry, matchSha256: "bad" }] }))
      .toThrow("invalid_manifest_match");
    expect(() => parseDailyComparisonManifest({ schemaVersion: 1, matches: [entry, entry] }))
      .toThrow("duplicate_manifest_match");
  });

  it("rotates model order per run while retaining every match/model trial", () => {
    expect(scheduleDailyModelRuns(["m1", "m2"], ["a", "b", "c"], 2).map(({ match, model, run }) => [match, model, run]))
      .toEqual([
        ["m1", "a", 1], ["m1", "b", 1], ["m1", "c", 1], ["m2", "a", 1], ["m2", "b", 1], ["m2", "c", 1],
        ["m1", "b", 2], ["m1", "c", 2], ["m1", "a", 2], ["m2", "b", 2], ["m2", "c", 2], ["m2", "a", 2],
      ]);
  });

  it("reports input_missing and excludes it from paid dry-run calls", () => {
    expect(dailyComparisonDryRunReport([prepared(["revive"])], ["gemini-a", "gemini-b"], 3)).toEqual({
      matches: 1, models: ["gemini-a", "gemini-b"], runs: 3, expectedCalls: 0,
      inputMissing: [{ matchId: "match-1", missingEvidenceGroups: ["revive"] }],
    });
  });

  it("keeps immutable attempt JSONL separate from trial summary JSONL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "daily-model-comparison-"));
    const output = path.join(directory, "run.jsonl");
    try {
      await appendDailyComparisonRecord(output, { attempt: 1, status: "published", originalResponse: "raw" });
      await appendDailyComparisonRecord(output, { recordType: "trial_summary", status: "published", attemptCount: 1 });
      expect((await readFile(output, "utf8")).trim()).toBe('{"attempt":1,"status":"published","originalResponse":"raw"}');
      expect((await readFile(`${output}.summary.jsonl`, "utf8")).trim())
        .toBe('{"recordType":"trial_summary","status":"published","attemptCount":1}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries only 429, 503 and timeout errors", () => {
    expect(isRetryableDailyModelError({ status: 429 })).toBe(true);
    expect(isRetryableDailyModelError({ statusCode: 503 })).toBe(true);
    expect(isRetryableDailyModelError(new Error("request timeout"))).toBe(true);
    expect(isRetryableDailyModelError({ status: 500, message: "server error" })).toBe(false);
    expect(isRetryableDailyModelError(new Error("invalid JSON"))).toBe(false);
  });

  it("caps transient failures at three attempts and summarizes total trial latency", async () => {
    let elapsed = 0;
    const deps = dependencies({
      now: vi.fn(() => elapsed),
      wait: vi.fn(async (ms: number) => { elapsed += ms; }),
      generate: vi.fn(async () => { elapsed += 40; throw Object.assign(new Error("busy"), { status: 429 }); }),
    });
    const result = await runSchedule([prepared()], ["gemini-a"], 1, deps, "secret", "run-retries");
    expect(deps.generate).toHaveBeenCalledTimes(3);
    expect(deps.append.mock.calls.filter(([record]) => (record as any).recordType !== "trial_summary").map(([record]) => (record as any).attempt))
      .toEqual([1, 2, 3]);
    expect(deps.wait.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
    expect(deps.append.mock.calls.at(-1)?.[0]).toMatchObject({ recordType: "trial_summary", status: "call_error", attemptCount: 3, totalLatencyMs: 870 });
    expect(result.failures).toEqual(["match-1/gemini-a:call_error"]);
  });

  it("logs each retry attempt and validates only the eventual complete raw response", async () => {
    let elapsed = 0;
    const deps = dependencies({
      now: vi.fn(() => elapsed),
      wait: vi.fn(async (ms: number) => { elapsed += ms; }),
      generate: vi.fn()
        .mockImplementationOnce(async () => { elapsed += 100; throw Object.assign(new Error("busy"), { status: 503 }); })
        .mockImplementationOnce(async () => { elapsed += 100; return { value: { sceneIds: ["scene-1"] }, rawText: '{"sceneIds":["scene-1"]}', usage: { totalTokenCount: 7 }, finishReason: "STOP", modelVersion: "v1" }; }),
    });
    const result = await runSchedule([prepared()], ["gemini-a"], 1, deps, "secret", "run-1");
    expect(deps.generate).toHaveBeenCalledTimes(2);
    expect(deps.validate).toHaveBeenCalledTimes(1);
    expect(deps.append.mock.calls.filter(([record]) => (record as any).recordType !== "trial_summary").map(([record]) => (record as any).status))
      .toEqual(["retryable_call_error", "published"]);
    expect(deps.append.mock.calls.at(-1)?.[0]).toMatchObject({ recordType: "trial_summary", attemptCount: 2, retryCount: 1, totalLatencyMs: 450 });
    expect(deps.append.mock.calls[0][0]).toMatchObject({ attempt: 1, httpStatus: 503, willRetry: true, originalResponse: null });
    expect(deps.append.mock.calls[1][0]).toMatchObject({ attempt: 2, modelVersion: "v1", usage: { totalTokenCount: 7 }, originalResponse: '{"sceneIds":["scene-1"]}' });
    expect(deps.append.mock.calls[1][0]).toMatchObject({ httpStatus: 200 });
    expect(deps.wait).toHaveBeenCalledWith(250);
    expect(JSON.stringify(deps.append.mock.calls)).not.toContain("secret");
    expect(result.failures).toEqual([]);
  });

  it("honors the server quota retry delay before retrying", async () => {
    const deps = dependencies({ generate: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Please retry in 41.5s. [{"retryDelay":"41s"}]'), { status: 429 }))
      .mockResolvedValue({ value: { sceneIds: ["scene-1"] }, rawText: '{}', finishReason: "STOP", usage: null }) });
    await runSchedule([prepared()], ["gemini-a"], 1, deps, "secret", "quota-delay");
    expect(deps.wait.mock.calls[0][0]).toBeGreaterThanOrEqual(41500);
    expect(deps.append.mock.calls[0][0]).toMatchObject({ retryDelayMs: 41750 });
  });

  it("records malformed or incomplete output without validating it or counting fallback as success", async () => {
    const deps = dependencies({
      generate: vi.fn()
        .mockResolvedValueOnce({ value: null, rawText: "not-json", usage: null, finishReason: "STOP" })
        .mockResolvedValueOnce({ value: { sceneIds: ["scene-1"] }, rawText: "{}", usage: null, finishReason: "MAX_TOKENS" }),
    });
    await runSchedule([prepared()], ["gemini-a"], 2, deps, "secret", "run-2");
    expect(deps.validate).not.toHaveBeenCalled();
    expect(deps.append.mock.calls.filter(([record]) => (record as any).recordType !== "trial_summary").map(([record]) => (record as any).status))
      .toEqual(["format_error", "format_error"]);

    const legacy = dependencies({
      generate: vi.fn(async () => ({ value: { points: [{ evidenceIds: ["fact-1"] }] }, rawText: '{"points":[]}', usage: null, finishReason: "STOP" })),
    });
    await runSchedule([prepared()], ["gemini-a"], 1, legacy, "secret", "run-legacy");
    expect(legacy.validate).not.toHaveBeenCalled();
    expect(legacy.append.mock.calls[0][0]).toMatchObject({ status: "format_error", error: "scene_ids_shape" });

    const fallbackDeps = dependencies({
      validate: vi.fn(() => ({ headline: "fallback", conclusion: "", points: [], selection: { usedFallback: true, rejectedReasons: ["invalid_scene_id"] } } as any)),
    });
    const result = await runSchedule([prepared()], ["gemini-a"], 1, fallbackDeps, "secret", "run-3");
    expect(fallbackDeps.append.mock.calls[0][0]).toMatchObject({ status: "fallback", validation: { valid: true, usedFallback: true } });
    expect(result.failures).toEqual(["match-1/gemini-a:fallback"]);
  });

  it("records input_missing for each trial without generation and preserves unavailable model IDs", async () => {
    const deps = dependencies({ modelsAvailable: vi.fn(async () => new Set(["gemini-a"])) });
    const result = await runSchedule([prepared(["revive"])], ["gemini-a", "gemini-b"], 1, deps, "secret", "run-4");
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.append.mock.calls.filter(([record]) => (record as any).recordType !== "trial_summary").map(([record]) => (record as any).status))
      .toEqual(["input_missing", "input_missing"]);
    expect(deps.append.mock.calls.filter(([record]) => (record as any).recordType === "trial_summary")).toHaveLength(2);
    expect(result.failures).toHaveLength(2);

    const unavailable = dependencies({ modelsAvailable: vi.fn(async () => new Set(["gemini-a"])) });
    await runSchedule([prepared()], ["gemini-b"], 1, unavailable, "secret", "run-5");
    expect(unavailable.generate).not.toHaveBeenCalled();
    expect(unavailable.append.mock.calls[0][0]).toMatchObject({ status: "invalid_model_id", model: "gemini-b" });
  });
});
