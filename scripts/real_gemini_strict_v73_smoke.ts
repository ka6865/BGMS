import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatchAiCoachingPrompt } from "../lib/pubg-analysis/matchAiCoachingPrompt";
import { sanitizeBackupCoachingText } from "../lib/pubg-analysis/backupCoaching";
import {
  getValidFullResultForMatch,
  normalizePlatform,
} from "../lib/pubg-analysis/cacheIdentity";
import {
  collectAiCoachingQualitySignals,
  hasBlockingAiCoachingQualityIssue,
  sanitizeAiCoachingLanguageText,
  type AiCoachingQualitySignals,
} from "../lib/pubg-analysis/aiCoachingQuality";
import { getAiCoachingBlockingSignalNames } from "../lib/pubg-analysis/aiCoachingReportCheck";
import {
  GEMINI_MODELS_TO_TRY,
  POPULATION_EVIDENCE_VERSION,
  RESULT_VERSION,
} from "../lib/pubg-analysis/constants";
import {
  normalizeMatchId,
  RECENT_MATCH_SELECTION_VERSION,
  selectBestMatches,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "../lib/pubg-analysis/recentMatchSelection";
import { isAiSummaryEligibleMatch } from "../lib/pubg-analysis/matchEligibility";
import { normalizeName } from "../lib/pubg-analysis/utils";

export const STRICT_SMOKE_TARGET_NICKNAME = "kangheesung_";
export const STRICT_SMOKE_TARGET_PLATFORM = "steam" as const;
export const STRICT_SMOKE_QUERY_LIMIT = 25;
export const STRICT_SMOKE_LATEST_LIMIT = 10;
export const STRICT_SMOKE_BEST_LIMIT = 5;
export const STRICT_SMOKE_TIMEOUT_MS = 25_000;
export const STRICT_SMOKE_DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  "tmp/real-gemini-strict-v73-smoke-report.json",
);

const STRICT_SINGLE_MATCH_JSON_KEYS = [
  "coach",
  "signature",
  "signatureSub",
  "briefFeedback",
  "finalVerdict",
  "actionItems",
] as const;
const STRICT_SINGLE_MATCH_JSON_KEY_SET = new Set<string>(STRICT_SINGLE_MATCH_JSON_KEYS);

type PlainRecord = Record<string, unknown>;

export type StrictSmokeRow = {
  match_id?: unknown;
  player_id?: unknown;
  platform?: unknown;
  data?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  [key: string]: unknown;
};

export type StrictSmokeGeminiResult = {
  text: string;
  model?: string;
};

export type StrictSmokeGenerateRequest = {
  model: string;
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
};

export type StrictSmokeGenerate = (
  request: StrictSmokeGenerateRequest,
) => Promise<StrictSmokeGeminiResult | string>;

export type StrictSmokeReadQuery = {
  select: (columns: string) => StrictSmokeReadQuery;
  eq: (column: string, value: unknown) => StrictSmokeReadQuery;
  order: (column: string, options?: { ascending?: boolean }) => StrictSmokeReadQuery;
  limit: (count: number) => Promise<{ data: unknown; error: unknown }>;
};

export type StrictSmokeSupabaseClient = {
  from: (table: string) => StrictSmokeReadQuery;
};

export type StrictSmokeReport = {
  schemaVersion: "1";
  parityScope: "single_prompt_provider_plus_population_selection";
  parityNote: "single-prompt provider parity plus latest10-to-best5 population-selection parity";
  selectionVersion: string;
  timestamp: string;
  model: string;
  version: number;
  resultVersion: number;
  acceptedCurrentRowCount: number;
  eligibleCurrentRowCount: number;
  latestCount: number;
  bestCount: number;
  latestMatchFingerprints: string[];
  bestMatchFingerprints: string[];
  chosenMatchFingerprint: string | null;
  jsonKeys: string[];
  qualitySignalNames: string[];
  rawQualitySignalNames: string[];
  finalQualitySignalNames: string[];
  rawBlockingSignalNames: string[];
  finalBlockingSignalNames: string[];
  pass: boolean;
  status: "pass" | "fail";
  failureCode: string | null;
  remoteDatabaseWritesAttempted: 0;
  r2WritesAttempted: 0;
  cacheWritesAttempted: 0;
  usageLogWritesAttempted: 0;
  geminiCallsAttempted: 0 | 1;
};

export type StrictSmokeReportInput = {
  timestamp: string;
  model: string;
  acceptedCurrentRowCount: number;
  eligibleCurrentRowCount?: number;
  latestCount: number;
  bestCount: number;
  latestMatchFingerprints: readonly string[];
  bestMatchFingerprints: readonly string[];
  chosenMatchFingerprint?: string | null;
  resultVersion?: number;
  jsonKeys?: readonly string[];
  qualitySignalNames?: readonly string[];
  rawQualitySignalNames?: readonly string[];
  finalQualitySignalNames?: readonly string[];
  rawBlockingSignalNames?: readonly string[];
  finalBlockingSignalNames?: readonly string[];
  pass: boolean;
  failureCode?: string | null;
  geminiCallsAttempted: number;
};

export type StrictSmokeRunOptions = {
  /** Test-only row injection. The real command leaves this undefined. */
  rows?: readonly StrictSmokeRow[];
  /** Read-only Supabase boundary used by the real command and focused tests. */
  supabase?: StrictSmokeSupabaseClient;
  /** Test-only Gemini boundary; the real command supplies the SDK adapter. */
  generate: StrictSmokeGenerate;
  model?: string;
  coachingStyle?: "mild" | "spicy";
  timeoutMs?: number;
  now?: () => string;
  /** Optional local report path. No report is written when omitted. */
  output?: string | null;
};

export type StrictSmokeRunResult = {
  acceptedCurrentRowCount: number;
  eligibleCurrentRowCount: number;
  latestCount: number;
  bestCount: number;
  latestMatchFingerprints: string[];
  bestMatchFingerprints: string[];
  chosenMatchFingerprint: string | null;
  jsonKeys: string[];
  qualitySignals: {
    raw: AiCoachingQualitySignals;
    final: AiCoachingQualitySignals;
  };
  report: StrictSmokeReport;
  /** Exposed for focused tests without placing any identity in the report. */
  matchFingerprint: (matchId: unknown) => string | null;
};

export class StrictSmokeError extends Error {
  readonly code: string;
  report?: StrictSmokeReport;

  constructor(code: string, message = code) {
    super(message);
    this.name = "StrictSmokeError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteCount(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : 0;
}

function safeModel(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,120}$/.test(model) ? model : "unknown";
}

function safeFailureCode(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const code = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9._:-]{1,80}$/.test(code) ? code : "failure";
}

function safeNames(values: readonly string[] | undefined): string[] {
  const names = Array.isArray(values) ? values : [];
  return Array.from(new Set(names.map((value) => {
    const name = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "redacted";
  }))).sort();
}

function redactJsonKeys(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((value): value is string => (
    typeof value === "string" && STRICT_SINGLE_MATCH_JSON_KEY_SET.has(value)
  )))).sort();
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text;
  }
  return null;
}

/** Hash canonical IDs before they can cross the report boundary. */
export function hashMatchFingerprint(matchId: unknown): string | null {
  const canonical = normalizeMatchId(matchId);
  if (!canonical) return null;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function redactFingerprint(value: unknown): string | null {
  return hashMatchFingerprint(value);
}

function redactFingerprints(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map(redactFingerprint)
    .filter((value): value is string => Boolean(value));
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string") return new Date(0).toISOString();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString();
}

/**
 * Build the only shape persisted by this smoke. Identity values are hashed
 * again here so callers cannot accidentally bypass the report redaction.
 */
export function buildRedactedStrictSmokeReport(input: StrictSmokeReportInput): StrictSmokeReport {
  const pass = input.pass === true;
  const geminiCallsAttempted: 0 | 1 = finiteCount(input.geminiCallsAttempted) > 0 ? 1 : 0;
  const rawQualitySignalNames = safeNames(input.rawQualitySignalNames);
  const finalQualitySignalNames = safeNames(input.finalQualitySignalNames);
  const qualitySignalNames = safeNames([
    ...(input.qualitySignalNames || []),
    ...rawQualitySignalNames,
    ...finalQualitySignalNames,
  ]);

  return {
    schemaVersion: "1",
    parityScope: "single_prompt_provider_plus_population_selection",
    parityNote: "single-prompt provider parity plus latest10-to-best5 population-selection parity",
    selectionVersion: RECENT_MATCH_SELECTION_VERSION,
    timestamp: safeTimestamp(input.timestamp),
    model: safeModel(input.model),
    version: RESULT_VERSION,
    resultVersion: RESULT_VERSION,
    acceptedCurrentRowCount: finiteCount(input.acceptedCurrentRowCount),
    eligibleCurrentRowCount: finiteCount(input.eligibleCurrentRowCount ?? input.acceptedCurrentRowCount),
    latestCount: finiteCount(input.latestCount),
    bestCount: finiteCount(input.bestCount),
    latestMatchFingerprints: redactFingerprints(input.latestMatchFingerprints),
    bestMatchFingerprints: redactFingerprints(input.bestMatchFingerprints),
    chosenMatchFingerprint: redactFingerprint(input.chosenMatchFingerprint),
    jsonKeys: redactJsonKeys(input.jsonKeys),
    qualitySignalNames,
    rawQualitySignalNames,
    finalQualitySignalNames,
    rawBlockingSignalNames: safeNames(input.rawBlockingSignalNames),
    finalBlockingSignalNames: safeNames(input.finalBlockingSignalNames),
    pass,
    status: pass ? "pass" : "fail",
    failureCode: safeFailureCode(input.failureCode),
    remoteDatabaseWritesAttempted: 0,
    r2WritesAttempted: 0,
    cacheWritesAttempted: 0,
    usageLogWritesAttempted: 0,
    geminiCallsAttempted,
  };
}

export async function writeRedactedStrictSmokeReport(
  outputPath: string,
  report: StrictSmokeReport,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** SELECT-only boundary for the one table used by the real smoke. */
export async function loadStrictSmokeRows(
  supabase: StrictSmokeSupabaseClient,
  playerId = normalizeName(STRICT_SMOKE_TARGET_NICKNAME),
  platform: string = STRICT_SMOKE_TARGET_PLATFORM,
): Promise<StrictSmokeRow[]> {
  const query = supabase
    .from("processed_match_telemetry")
    .select("match_id,player_id,platform,data,updated_at,created_at")
    .eq("player_id", playerId)
    .eq("platform", platform)
    .order("updated_at", { ascending: false });
  const result = await query.limit(STRICT_SMOKE_QUERY_LIMIT);
  if (result.error) throw new StrictSmokeError("supabase_select", "processed telemetry select failed");
  return Array.isArray(result.data) ? result.data.filter(isRecord) as StrictSmokeRow[] : [];
}

function candidateMetadata(
  row: StrictSmokeRow,
  fullResult: PlainRecord,
): Pick<RecentMatchCandidate<PlainRecord>, "createdAt" | "matchType" | "gameMode" | "mapName"> {
  const matchInfo = isRecord(fullResult.matchInfo) ? fullResult.matchInfo : {};
  const rowData = isRecord(row.data) ? row.data : {};
  return {
    createdAt: firstText(
      fullResult.createdAt,
      fullResult.created_at,
      fullResult.date,
      matchInfo.date,
      row.created_at,
      row.updated_at,
      rowData.createdAt,
      rowData.created_at,
    ),
    matchType: firstText(
      fullResult.matchType,
      fullResult.match_type,
      matchInfo.matchType,
      row.match_type,
      rowData.matchType,
      rowData.match_type,
    ),
    gameMode: firstText(
      fullResult.gameMode,
      fullResult.game_mode,
      fullResult.mode,
      matchInfo.gameMode,
      matchInfo.mode,
      row.game_mode,
      rowData.gameMode,
      rowData.game_mode,
    ),
    mapName: firstText(
      fullResult.mapName,
      fullResult.map_name,
      fullResult.map,
      matchInfo.mapId,
      matchInfo.map,
      row.map_name,
      rowData.mapName,
      rowData.map_name,
    ),
  };
}

export type StrictSmokeValidatedCandidate = RecentMatchCandidate<PlainRecord> & {
  rowIndex: number;
};

/**
 * Validate each row against its own storage identity. In particular, this
 * intentionally does not add a missing match ID to the embedded result.
 */
export function buildStrictSmokeCandidates(
  rows: readonly StrictSmokeRow[],
  playerId = normalizeName(STRICT_SMOKE_TARGET_NICKNAME),
  platform: string = STRICT_SMOKE_TARGET_PLATFORM,
): { accepted: StrictSmokeValidatedCandidate[]; eligible: StrictSmokeValidatedCandidate[] } {
  const accepted: StrictSmokeValidatedCandidate[] = [];
  rows.forEach((row, rowIndex) => {
    const fullResult = getValidFullResultForMatch(row, {
      matchId: row.match_id as string,
      playerId,
      platform: normalizePlatform(platform),
      minResultVersion: RESULT_VERSION,
    });
    if (!fullResult || !isRecord(fullResult)) return;
    const metadata = candidateMetadata(row, fullResult);
    accepted.push({
      id: row.match_id as string,
      ...metadata,
      sourceIndex: rowIndex,
      value: fullResult,
      rowIndex,
    });
  });

  return {
    accepted,
    // Mirror the summary route's current canonical population contract. The
    // marker must live on fullResult itself, while row.data remains separate
    // evidence so wrapper-level custom/event telemetry cannot be discarded.
    eligible: accepted.filter((candidate) => {
      if (Number(candidate.value.populationEvidenceVersion) !== POPULATION_EVIDENCE_VERSION) {
        return false;
      }
      const row = rows[candidate.rowIndex] || {};
      const rowData = isRecord(row.data) ? row.data : {};
      return isAiSummaryEligibleMatch({
        ...row,
        ...candidate.value,
        data: rowData,
        fullResult: candidate.value,
      });
    }),
  };
}

function strictJsonText(value: unknown): string {
  if (typeof value !== "string") throw new StrictSmokeError("provider_response", "provider response was not text");
  return value;
}

function extractJsonObject(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new StrictSmokeError("json_invalid", "provider JSON was invalid");
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new StrictSmokeError("json_invalid", "provider JSON was invalid");
    }
  }
}

function requireNonEmptyString(record: PlainRecord, key: string): void {
  if (typeof record[key] !== "string" || !record[key].trim()) {
    throw new StrictSmokeError("json_shape", "provider JSON shape was invalid");
  }
}

export function parseStrictSingleMatchJson(text: string): PlainRecord {
  const parsed = extractJsonObject(text);
  if (!isRecord(parsed)) throw new StrictSmokeError("json_shape", "provider JSON shape was invalid");
  ["coach", "signature", "signatureSub", "finalVerdict"].forEach((key) => requireNonEmptyString(parsed, key));

  if (!Array.isArray(parsed.briefFeedback) || parsed.briefFeedback.length !== 3
      || parsed.briefFeedback.some((item) => typeof item !== "string" || !item.trim())) {
    throw new StrictSmokeError("json_shape", "provider JSON shape was invalid");
  }
  if (!Array.isArray(parsed.actionItems)
      || parsed.actionItems.length === 0
      || parsed.actionItems.some((item) => !isRecord(item))) {
    throw new StrictSmokeError("json_shape", "provider JSON shape was invalid");
  }
  parsed.actionItems.forEach((item) => {
    requireNonEmptyString(item, "icon");
    requireNonEmptyString(item, "title");
    requireNonEmptyString(item, "desc");
  });
  return parsed;
}

function allQualitySignalNames(): string[] {
  return Object.keys(collectAiCoachingQualitySignals(""));
}

function createAbortError(): StrictSmokeError {
  return new StrictSmokeError("provider_timeout", "provider deadline exceeded");
}

async function generateWithDeadline(
  generate: StrictSmokeGenerate,
  request: StrictSmokeGenerateRequest,
): Promise<StrictSmokeGeminiResult | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(createAbortError());
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const providerPromise = Promise.resolve(generate({ ...request, signal: controller.signal }));
    return await Promise.race([providerPromise, abortPromise]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

function reportInputFromState(input: {
  timestamp: string;
  model: string;
  accepted: readonly StrictSmokeValidatedCandidate[];
  eligible: readonly StrictSmokeValidatedCandidate[];
  latest: readonly RecentMatchCandidate<PlainRecord>[];
  best: readonly RecentMatchCandidate<PlainRecord>[];
  jsonKeys?: readonly string[];
  rawSignals?: AiCoachingQualitySignals;
  finalSignals?: AiCoachingQualitySignals;
  pass: boolean;
  failureCode?: string | null;
  geminiCallsAttempted: number;
}): StrictSmokeReport {
  const rawSignals = input.rawSignals || collectAiCoachingQualitySignals("");
  const finalSignals = input.finalSignals || collectAiCoachingQualitySignals("");
  return buildRedactedStrictSmokeReport({
    timestamp: input.timestamp,
    model: input.model,
    acceptedCurrentRowCount: input.accepted.length,
    eligibleCurrentRowCount: input.eligible.length,
    latestCount: input.latest.length,
    bestCount: input.best.length,
    latestMatchFingerprints: input.latest.map((candidate) => candidate.id).filter((id): id is string => Boolean(id)),
    bestMatchFingerprints: input.best.map((candidate) => candidate.id).filter((id): id is string => Boolean(id)),
    chosenMatchFingerprint: input.best[0]?.id ?? null,
    resultVersion: RESULT_VERSION,
    jsonKeys: input.jsonKeys,
    qualitySignalNames: allQualitySignalNames(),
    rawQualitySignalNames: Object.keys(rawSignals),
    finalQualitySignalNames: Object.keys(finalSignals),
    rawBlockingSignalNames: getAiCoachingBlockingSignalNames(rawSignals),
    finalBlockingSignalNames: getAiCoachingBlockingSignalNames(finalSignals),
    pass: input.pass,
    failureCode: input.failureCode,
    geminiCallsAttempted: input.geminiCallsAttempted,
  });
}

async function maybeWriteReport(output: string | null | undefined, report: StrictSmokeReport): Promise<void> {
  if (!output) return;
  await writeRedactedStrictSmokeReport(output, report);
}

export async function runStrictGeminiV73Smoke(options: StrictSmokeRunOptions): Promise<StrictSmokeRunResult> {
  const timestamp = options.now ? options.now() : new Date().toISOString();
  const model = safeModel(options.model || GEMINI_MODELS_TO_TRY[0]);
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs || 0) > 0
    ? Math.floor(options.timeoutMs as number)
    : STRICT_SMOKE_TIMEOUT_MS;
  const playerId = normalizeName(STRICT_SMOKE_TARGET_NICKNAME);
  const platform = normalizePlatform(STRICT_SMOKE_TARGET_PLATFORM);
  let stage = "select";
  let rows: StrictSmokeRow[] = [];
  let accepted: StrictSmokeValidatedCandidate[] = [];
  let eligible: StrictSmokeValidatedCandidate[] = [];
  let latest: Array<RecentMatchCandidate<PlainRecord>> = [];
  let best: Array<RecentMatchCandidate<PlainRecord>> = [];
  let geminiCallsAttempted = 0;
  let rawSignals: AiCoachingQualitySignals | undefined;
  let finalSignals: AiCoachingQualitySignals | undefined;
  let jsonKeys: string[] = [];

  try {
    if (options.rows) rows = Array.from(options.rows);
    else if (options.supabase) rows = await loadStrictSmokeRows(options.supabase, playerId, platform);
    else throw new StrictSmokeError("supabase_select", "a Supabase read boundary is required");

    stage = "validate";
    ({ accepted, eligible } = buildStrictSmokeCandidates(rows, playerId, platform));
    const selection = selectRecentMatches(eligible, { limit: STRICT_SMOKE_LATEST_LIMIT });
    latest = selection.selected;
    if (latest.length === 0) throw new StrictSmokeError("no_current_selection", "no current match passed selection");

    best = selectBestMatches(latest, { limit: STRICT_SMOKE_BEST_LIMIT });
    if (best.length === 0) throw new StrictSmokeError("no_best_selection", "no best match passed selection");

    stage = "provider";
    const chosen = best[0]?.value;
    if (!chosen) throw new StrictSmokeError("no_best_selection", "no best match passed selection");
    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
      matchData: chosen,
      coachingStyle: options.coachingStyle || "spicy",
    });

    // This is intentionally the sole provider boundary invocation. There is
    // no fallback model and no second attempt after a timeout or parse error.
    geminiCallsAttempted = 1;
    const providerResult = await generateWithDeadline(options.generate, {
      model,
      prompt: fullPrompt,
      signal: new AbortController().signal,
      timeoutMs,
    });
    const rawText = typeof providerResult === "string" ? providerResult : strictJsonText(providerResult.text);
    rawSignals = collectAiCoachingQualitySignals(rawText);

    stage = "json";
    const sanitizedText = sanitizeAiCoachingLanguageText(
      sanitizeBackupCoachingText(rawText, backupContext),
    );
    const parsed = parseStrictSingleMatchJson(sanitizedText);
    jsonKeys = redactJsonKeys(Object.keys(parsed));
    finalSignals = collectAiCoachingQualitySignals(JSON.stringify(parsed));

    stage = "quality";
    if (hasBlockingAiCoachingQualityIssue(rawSignals)
        || hasBlockingAiCoachingQualityIssue(finalSignals)) {
      throw new StrictSmokeError("quality_gate", "coaching quality gate failed");
    }

    const report = reportInputFromState({
      timestamp,
      model,
      accepted,
      eligible,
      latest,
      best,
      jsonKeys,
      rawSignals,
      finalSignals,
      pass: true,
      geminiCallsAttempted,
    });
    await maybeWriteReport(options.output, report);
    return {
      acceptedCurrentRowCount: accepted.length,
      eligibleCurrentRowCount: eligible.length,
      latestCount: latest.length,
      bestCount: best.length,
      latestMatchFingerprints: report.latestMatchFingerprints,
      bestMatchFingerprints: report.bestMatchFingerprints,
      chosenMatchFingerprint: report.chosenMatchFingerprint,
      jsonKeys,
      qualitySignals: { raw: rawSignals, final: finalSignals },
      report,
      matchFingerprint: hashMatchFingerprint,
    };
  } catch (error) {
    const failureCode = error instanceof StrictSmokeError
      ? error.code
      : stage === "provider" ? "provider_error" : stage === "json" ? "json_invalid" : "smoke_failed";
    const report = reportInputFromState({
      timestamp,
      model,
      accepted,
      eligible,
      latest,
      best,
      jsonKeys,
      rawSignals,
      finalSignals,
      pass: false,
      failureCode,
      geminiCallsAttempted,
    });
    await maybeWriteReport(options.output, report);
    if (error instanceof Error) {
      (error as Error & { strictSmokeReport?: StrictSmokeReport }).strictSmokeReport = report;
      throw error;
    }
    const wrapped = new StrictSmokeError(failureCode);
    wrapped.report = report;
    throw wrapped;
  }
}

export function createSupabaseReadClient(env: NodeJS.ProcessEnv = process.env): StrictSmokeSupabaseClient {
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new StrictSmokeError("configuration", "Supabase configuration is missing");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as StrictSmokeSupabaseClient;
}

export function resolveStrictSmokeModel(env: NodeJS.ProcessEnv = process.env): string {
  return safeModel(
    env.GEMINI_STRICT_V73_MODEL
      || GEMINI_MODELS_TO_TRY[0],
  );
}

export function createGeminiReadAdapter(
  env: NodeJS.ProcessEnv = process.env,
  modelName = resolveStrictSmokeModel(env),
): StrictSmokeGenerate {
  const apiKey = env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new StrictSmokeError("configuration", "Gemini configuration is missing");
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.45,
    },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
  });

  return async ({ prompt, signal, timeoutMs }) => {
    const result = await model.generateContent(prompt, { signal, timeout: timeoutMs });
    return { text: result.response.text(), model: modelName };
  };
}

function getArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export async function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StrictSmokeRunResult> {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config();
  const model = resolveStrictSmokeModel(env);
  const output = getArg(argv, "--output") || STRICT_SMOKE_DEFAULT_OUTPUT;
  const supabase = createSupabaseReadClient(env);
  const generate = createGeminiReadAdapter(env, model);
  return runStrictGeminiV73Smoke({ supabase, generate, model, output });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisPath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === thisPath) {
  main().catch((error: unknown) => {
    const code = error instanceof StrictSmokeError ? error.code : "smoke_failed";
    console.error(`strict v73 Gemini smoke failed (${code}); see the redacted local report.`);
    process.exitCode = 1;
  });
}
