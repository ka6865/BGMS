import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  buildDailyModelInput,
  DAILY_SCENE_SYSTEM_INSTRUCTION,
  DAILY_STORY_MODEL,
  generateDailySceneResponse,
  validateDailyAiStory,
} from "../lib/learn/dailyAi";
import { buildDailyEvidence, type DailyEvidence } from "../lib/learn/dailyEvidence";

export type DailyComparisonManifest = {
  schemaVersion: 1;
  matches: {
    dayKst: string;
    matchId: string;
    candidate: { accountId: string; nickname: string; rank: number };
    matchPath: string;
    matchSha256: string;
    telemetryPath: string;
    telemetrySha256: string;
    /** A group passes when any alternative fact ID exists in reconstructed evidence. */
    requiredEvidenceGroups: { id: string; factIds: string[] }[];
  }[];
};

export type PreparedDailyMatch = {
  entry: DailyComparisonManifest["matches"][number];
  evidence: DailyEvidence;
  inputHash: string;
  promptHash: string;
  scriptHash: string;
  promptVersion: string;
  evidenceVersion: number;
  missingGroups: string[];
};

type Options = { manifest: string; models: string[]; runs: number; output: string; run: boolean };
type RunDependencies = {
  modelsAvailable: (key: string) => Promise<Set<string>>;
  generate: typeof generateDailySceneResponse;
  validate: typeof validateDailyAiStory;
  append: (record: unknown) => Promise<void>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseDailyComparisonManifest(value: unknown): DailyComparisonManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.matches) || !value.matches.length) {
    throw new Error("invalid_manifest");
  }
  const seen = new Set<string>();
  const matches = value.matches.map((raw) => {
    if (!isRecord(raw) || typeof raw.dayKst !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dayKst)
      || typeof raw.matchId !== "string" || !raw.matchId || !isRecord(raw.candidate)
      || typeof raw.candidate.accountId !== "string" || !raw.candidate.accountId
      || typeof raw.candidate.nickname !== "string" || !raw.candidate.nickname
      || !Number.isInteger(raw.candidate.rank) || raw.candidate.rank < 1
      || typeof raw.matchPath !== "string" || !raw.matchPath
      || typeof raw.telemetryPath !== "string" || !raw.telemetryPath
      || !/^[a-f\d]{64}$/i.test(raw.matchSha256) || !/^[a-f\d]{64}$/i.test(raw.telemetrySha256)
      || !Array.isArray(raw.requiredEvidenceGroups)
      || raw.requiredEvidenceGroups.some((group: unknown) => !isRecord(group) || typeof group.id !== "string"
        || !group.id || !Array.isArray(group.factIds) || !group.factIds.length
        || group.factIds.some((id: unknown) => typeof id !== "string" || !id))) {
      throw new Error("invalid_manifest_match");
    }
    const identity = `${raw.dayKst}/${raw.matchId}`;
    if (seen.has(identity)) throw new Error("duplicate_manifest_match");
    seen.add(identity);
    return raw as DailyComparisonManifest["matches"][number];
  });
  return { schemaVersion: 1, matches };
}

export function scheduleDailyModelRuns<T>(matches: T[], models: string[], runs: number) {
  if (!matches.length || !models.length || !Number.isInteger(runs) || runs < 1) throw new Error("invalid_schedule");
  return Array.from({ length: runs }, (_, runIndex) => matches.flatMap((match) =>
    models.map((_, modelIndex) => ({ match, model: models[(modelIndex + runIndex) % models.length], run: runIndex + 1 })),
  )).flat();
}

export function dailyComparisonDryRunReport(prepared: PreparedDailyMatch[], models: string[], runs: number) {
  const schedule = scheduleDailyModelRuns(prepared, models, runs);
  const inputMissing = prepared.filter((match) => match.missingGroups.length).map((match) => ({
    matchId: match.entry.matchId, missingEvidenceGroups: match.missingGroups,
  }));
  return {
    matches: prepared.length, models, runs,
    expectedCalls: schedule.filter((task) => !task.match.missingGroups.length).length,
    inputMissing,
  };
}

export function isRetryableDailyModelError(error: unknown) {
  const candidate = isRecord(error) ? error : {};
  const status = Number(candidate.status ?? candidate.statusCode ?? candidate.response?.status);
  return status === 429 || status === 503 || candidate.name === "TimeoutError" || candidate.name === "AbortError"
    || /timed? ?out|timeout|deadline exceeded/i.test(String(candidate.message ?? error ?? ""));
}

function normalizeModelName(name: string) { return name.replace(/^models\//, ""); }

export async function listCallableModels(apiKey: string): Promise<Set<string>> {
  const names = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Object.assign(new Error(`models_api_${response.status}`), { status: response.status });
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("models_api_invalid_response");
    for (const item of body.models) {
      if (isRecord(item) && typeof item.name === "string" && Array.isArray(item.supportedGenerationMethods)
        && item.supportedGenerationMethods.includes("generateContent")) names.add(normalizeModelName(item.name));
    }
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
  } while (pageToken);
  return names;
}

async function prepareMatches(manifestPath: string, manifest: DailyComparisonManifest): Promise<PreparedDailyMatch[]> {
  const base = path.dirname(path.resolve(manifestPath));
  const scriptHash = sha256(await readFile(new URL(import.meta.url)));
  return Promise.all(manifest.matches.map(async (entry) => {
    const matchBytes = await readFile(path.resolve(base, entry.matchPath));
    const telemetryBytes = await readFile(path.resolve(base, entry.telemetryPath));
    if (sha256(matchBytes) !== entry.matchSha256.toLowerCase()) throw new Error(`match_sha256_mismatch:${entry.matchId}`);
    if (sha256(telemetryBytes) !== entry.telemetrySha256.toLowerCase()) throw new Error(`telemetry_sha256_mismatch:${entry.matchId}`);
    const match = JSON.parse(matchBytes.toString("utf8"));
    const events = JSON.parse(telemetryBytes.toString("utf8"));
    const evidence = buildDailyEvidence({ match, events, candidate: entry.candidate, dayKst: entry.dayKst });
    if (evidence.matchId !== entry.matchId) throw new Error(`match_id_mismatch:${entry.matchId}`);
    const input = buildDailyModelInput(evidence);
    const knownFactIds = new Set(evidence.facts.map((fact) => fact.id));
    const missingGroups = entry.requiredEvidenceGroups
      .filter((group) => !group.factIds.some((id) => knownFactIds.has(id))).map((group) => group.id);
    return {
      entry, evidence, inputHash: sha256(JSON.stringify(input)), promptHash: sha256(DAILY_SCENE_SYSTEM_INSTRUCTION),
      scriptHash, promptVersion: input.promptVersion, evidenceVersion: input.evidenceVersion, missingGroups,
    };
  }));
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  return Number.isInteger(status) ? status : null;
}

function formatError(error: unknown) {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

export function appendDailyComparisonRecord(output: string, record: unknown) {
  const target = isRecord(record) && record.recordType === "trial_summary" ? `${output}.summary.jsonl` : output;
  return appendFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function executeDailyModelSchedule(
  prepared: PreparedDailyMatch[], models: string[], runs: number, dependencies: RunDependencies,
  apiKey: string, runId: string = randomUUID(),
) {
  const schedule = scheduleDailyModelRuns(prepared, models, runs);
  const failures: string[] = [];
  const available = await dependencies.modelsAvailable(apiKey);
  for (const task of schedule) {
    const { entry } = task.match;
    const trialStartedAt = dependencies.now();
    let trialStatus = "pending";
    const finishTrial = async (attemptCount: number) => dependencies.append({
      recordType: "trial_summary", runId, matchId: entry.matchId, dayKst: entry.dayKst, model: task.model, run: task.run,
      status: trialStatus, attemptCount, retryCount: Math.max(0, attemptCount - 1), totalLatencyMs: dependencies.now() - trialStartedAt,
    });
    const base = {
      runId, matchId: entry.matchId, dayKst: entry.dayKst, candidate: entry.candidate,
      model: task.model, run: task.run, inputHash: task.match.inputHash,
      matchSha256: entry.matchSha256, telemetrySha256: entry.telemetrySha256,
      promptHash: task.match.promptHash, scriptHash: task.match.scriptHash, requiredEvidenceGroups: entry.requiredEvidenceGroups,
      promptVersion: task.match.promptVersion, evidenceVersion: task.match.evidenceVersion,
    };
    if (task.match.missingGroups.length) {
      await dependencies.append({ ...base, attempt: 0, status: "input_missing", missingEvidenceGroups: task.match.missingGroups,
        originalResponse: null, validation: null, published: null, usage: null, latencyMs: 0 });
      trialStatus = "input_missing";
      await finishTrial(0);
      failures.push(`${entry.matchId}/${task.model}:input_missing`);
      continue;
    }
    if (!available.has(normalizeModelName(task.model))) {
      await dependencies.append({ ...base, attempt: 0, status: "invalid_model_id", originalResponse: null,
        validation: null, published: null, usage: null, latencyMs: 0 });
      trialStatus = "invalid_model_id";
      await finishTrial(0);
      failures.push(`${entry.matchId}/${task.model}:invalid_model_id`);
      continue;
    }
    let completedAttempts = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      completedAttempts = attempt;
      const startedAt = dependencies.now();
      try {
        const response = await dependencies.generate(task.match.evidence, apiKey, task.model);
        const latencyMs = dependencies.now() - startedAt;
        if (!isRecord(response.value) || !Array.isArray(response.value.sceneIds) || response.finishReason !== "STOP") {
          const error = !isRecord(response.value) || !Array.isArray(response.value.sceneIds)
            ? "scene_ids_shape" : `incomplete:${response.finishReason ?? "missing_finish_reason"}`;
          await dependencies.append({ ...base, attempt, status: "format_error", error, httpStatus: 200,
            originalResponse: response.rawText, value: response.value, finishReason: response.finishReason ?? null,
            modelVersion: response.modelVersion ?? null, validation: null, published: null, usage: response.usage,
            latencyMs, totalLatencyMs: dependencies.now() - trialStartedAt, retryCount: attempt - 1 });
          trialStatus = "format_error";
          failures.push(`${entry.matchId}/${task.model}:format_error`);
          break;
        }
        try {
          const story = dependencies.validate(response.value, task.match.evidence);
          const usedFallback = story.selection?.usedFallback ?? false;
          const status = usedFallback ? "fallback" : "published";
          await dependencies.append({ ...base, attempt, status, httpStatus: 200, originalResponse: response.rawText,
            value: response.value, finishReason: response.finishReason ?? null, modelVersion: response.modelVersion ?? null,
            validation: { valid: true, usedFallback, rejectedReasons: story.selection?.rejectedReasons ?? [] },
            published: story, usage: response.usage, latencyMs, totalLatencyMs: dependencies.now() - trialStartedAt,
            retryCount: attempt - 1 });
          trialStatus = status;
          if (usedFallback) failures.push(`${entry.matchId}/${task.model}:fallback`);
          break;
        } catch (error) {
          const message = formatError(error);
          const status = /evidence|scene_id|unknown/i.test(message) ? "invalid_evidence_id" : "validation_error";
          const rejectedReasons = isRecord(error) && Array.isArray(error.rejectedReasons) ? error.rejectedReasons : [];
          await dependencies.append({ ...base, attempt, status, error: message, httpStatus: 200,
            originalResponse: response.rawText, value: response.value, finishReason: response.finishReason ?? null,
            modelVersion: response.modelVersion ?? null, validation: { valid: false, error: message, rejectedReasons },
            published: null, usage: response.usage, latencyMs, totalLatencyMs: dependencies.now() - trialStartedAt,
            retryCount: attempt - 1 });
          trialStatus = status;
          failures.push(`${entry.matchId}/${task.model}:${status}`);
          break;
        }
      } catch (error) {
        const latencyMs = dependencies.now() - startedAt;
        const retry = isRetryableDailyModelError(error) && attempt < 3;
        const status = errorStatus(error);
        const message = formatError(error);
        const seconds = message.match(/retry in ([\d.]+)s/i)?.[1]
          ?? message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)?.[1];
        const retryDelayMs = seconds ? Math.ceil(Number(seconds) * 1000) + 250 : Math.min(1_000, 250 * 2 ** (attempt - 1));
        await dependencies.append({ ...base, attempt, status: retry ? "retryable_call_error" : "call_error",
          error: message, httpStatus: status, originalResponse: null, validation: null, published: null,
          usage: null, latencyMs, totalLatencyMs: dependencies.now() - trialStartedAt, retryCount: attempt - 1, willRetry: retry,
          ...(retry ? { retryDelayMs } : {}) });
        if (!retry) {
          trialStatus = "call_error";
          failures.push(`${entry.matchId}/${task.model}:call_error`);
          break;
        }
        // Keep individual waits bounded while respecting the provider's complete delay.
        for (let remaining = retryDelayMs; remaining > 0; remaining -= 60_000) {
          await dependencies.wait(Math.min(remaining, 60_000));
        }
      }
    }
    if (trialStatus === "pending") trialStatus = "call_error";
    await finishTrial(completedAttempts);
  }
  return { runId, attemptedRuns: schedule.length, failures };
}

export type DailyModelComparisonResult =
  | { runId: string; dryRun: true; matches: number; models: string[]; runs: number; expectedCalls: number; inputMissing: { matchId: string; missingEvidenceGroups: string[] }[] }
  | { runId: string; dryRun: false; attemptedRuns: number; failures: string[] };

export async function runDailyModelComparison(options: Options, dependencies: RunDependencies, apiKey?: string): Promise<DailyModelComparisonResult> {
  const parsed = parseDailyComparisonManifest(JSON.parse(await readFile(options.manifest, "utf8")));
  const prepared = await prepareMatches(options.manifest, parsed); // Validate every source and expected fact before any model call.
  const runId = randomUUID();
  if (!options.run) return { runId, dryRun: true, ...dailyComparisonDryRunReport(prepared, options.models, options.runs) };
  if (!apiKey) throw new Error("GOOGLE_GEMINI_API_KEY_missing");
  return { dryRun: false, ...(await executeDailyModelSchedule(prepared, options.models, options.runs,
    dependencies, apiKey, runId)) };
}

function parseArgs(argv: string[]): Options {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const manifest = value("manifest");
  const output = value("output");
  if (!manifest || !output) throw new Error("usage: --manifest=<path> --models=<csv> --runs=3 --output=<jsonl> [--run]");
  const models = (value("models") ?? DAILY_STORY_MODEL).split(",").map((model) => model.trim()).filter(Boolean);
  const runs = Number(value("runs") ?? 3);
  if (!models.length || new Set(models).size !== models.length || !Number.isInteger(runs) || runs < 1) throw new Error("invalid_models_or_runs");
  return { manifest, models, runs, output, run: argv.includes("--run") };
}

async function main() {
  dotenv.config({ path: ".env.local", quiet: true });
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  const append = (record: unknown) => appendDailyComparisonRecord(output, record);
  const result = await runDailyModelComparison(options, {
    modelsAvailable: listCallableModels,
    generate: generateDailySceneResponse,
    validate: validateDailyAiStory,
    append,
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }, process.env.GOOGLE_GEMINI_API_KEY);
  console.log(JSON.stringify(result));
  if (!result.dryRun && result.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DAILY_MODEL_COMPARISON_ERROR:${formatError(error)}`);
    process.exitCode = 1;
  });
}
