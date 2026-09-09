import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import type { RunSnapshot, Stage } from "../lib/community-agent/types";

const RUN_PATH = "/api/admin/agent/community/run";
const CLEANUP_PATH = "/api/admin/agent/community/cleanup";
const REQUEST_TIMEOUT_MS = 55_000;
const STAGES = ["dc", "naver", "youtube", "select", "draft", "verify"] as const satisfies readonly Stage[];
const RUN_STATUSES = new Set<RunSnapshot["status"]>([
  "collecting", "selected", "drafted", "ready", "deferred", "failed", "published",
]);
type StageStatus = NonNullable<RunSnapshot["stages"][Stage]>["status"];

const STAGE_STATUSES = new Set<StageStatus>(["running", "completed", "failed"]);

export type CommunityWorkerOptions = {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
};

export type CommunityWorkerResult = { status: string; postId: number | null };

type WorkerRun = Pick<RunSnapshot, "id" | "status" | "stages" | "postId">;

class HttpFailure extends Error {}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function resultFrom(run: WorkerRun): CommunityWorkerResult {
  return { status: run.status, postId: run.postId };
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

export function validateCommunityWorkerBaseUrl(value: string): string {
  const input = value.trim();
  if (!input || input.includes("?") || input.includes("#")) throw new Error("community-agent-app-url-invalid");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("community-agent-app-url-invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("community-agent-app-url-invalid");
  }
  return url.origin;
}

function requiredSecret(value: string): string {
  const secret = value.trim();
  if (!secret) throw new Error("community-agent-worker-secret-missing");
  return secret;
}

function parseRun(value: unknown, key: "result" | "run"): WorkerRun {
  const body = record(value, "community-agent-response-invalid");
  const source = record(body[key], "community-agent-response-invalid");
  const id = source.id;
  const status = source.status;
  const stages = source.stages;
  const postId = source.postId;
  if (typeof id !== "string" || id.length === 0 || typeof status !== "string" || !RUN_STATUSES.has(status as RunSnapshot["status"])) {
    throw new Error("community-agent-response-invalid");
  }
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) throw new Error("community-agent-response-invalid");
  if (postId !== null && postId !== undefined && (typeof postId !== "number" || !Number.isSafeInteger(postId) || postId < 0)) {
    throw new Error("community-agent-response-invalid");
  }
  for (const stage of STAGES) {
    const state = (stages as Record<string, unknown>)[stage];
    if (state === undefined) continue;
    const stateRecord = record(state, "community-agent-response-invalid");
    if (typeof stateRecord.status !== "string" || !STAGE_STATUSES.has(stateRecord.status as StageStatus)) {
      throw new Error("community-agent-response-invalid");
    }
  }
  return {
    id,
    status: status as RunSnapshot["status"],
    stages: stages as RunSnapshot["stages"],
    postId: typeof postId === "number" ? postId : null,
  };
}

function parseCleanupResult(value: unknown): CommunityWorkerResult {
  const body = record(value, "community-agent-response-invalid");
  const result = record(body.result, "community-agent-response-invalid");
  for (const key of ["excerpts", "drafts", "runs"] as const) {
    if (typeof result[key] !== "number" || !Number.isSafeInteger(result[key]) || result[key] < 0) {
      throw new Error("community-agent-response-invalid");
    }
  }
  return { status: "cleaned", postId: null };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  secret: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new HttpFailure(`community-agent-request-failed-${response.status}`);
    return await response.json() as unknown;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("community-agent-request-timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function canRecover(error: unknown): boolean {
  return !(error instanceof HttpFailure) && !(error instanceof SyntaxError);
}

function isTerminal(run: WorkerRun): boolean {
  return run.status === "deferred" || run.status === "failed" || run.status === "published";
}

function stageStatus(run: WorkerRun, stage: Stage): "running" | "completed" | "failed" | null {
  const state = run.stages[stage];
  return state?.status ?? null;
}

/**
 * Runs the server-owned community state machine. The worker supplies only the
 * fixed action union and a persisted run ID; it never sends provider data.
 */
export async function runCommunityWorker({
  baseUrl,
  secret,
  fetchImpl = fetch,
}: CommunityWorkerOptions): Promise<CommunityWorkerResult> {
  const origin = validateCommunityWorkerBaseUrl(baseUrl);
  const workerSecret = requiredSecret(secret);
  const runUrl = endpoint(origin, RUN_PATH);
  const call = (method: "GET" | "POST", body?: Record<string, unknown>) => requestJson(
    fetchImpl,
    runUrl,
    workerSecret,
    method,
    body,
  );
  const readRun = (runId: string) => requestJson(
    fetchImpl,
    `${runUrl}?runId=${encodeURIComponent(runId)}`,
    workerSecret,
    "GET",
  );

  let run = parseRun(await call("POST", { action: "start", dryRun: false }), "result");
  if (isTerminal(run)) return resultFrom(run);

  for (const stage of STAGES) {
    if (isTerminal(run)) return resultFrom(run);
    if (run.status === "ready") break;

    const before = stageStatus(run, stage);
    if (before === "completed") continue;
    if (before === "running" || before === "failed") return resultFrom(run);

    try {
      run = parseRun(await call("POST", { action: "step", runId: run.id, stage }), "result");
    } catch (error) {
      if (!canRecover(error)) throw error;
      run = parseRun(await readRun(run.id), "run");
      if (isTerminal(run)) return resultFrom(run);
      if (run.status === "ready") break;
      // A transport failure gets one status read. Only a persisted completion
      // authorizes the next stage; an active/failed/missing stage stays put.
      if (stageStatus(run, stage) !== "completed") return resultFrom(run);
      continue;
    }

    if (isTerminal(run)) return resultFrom(run);
    if (run.status === "ready") break;
    const after = stageStatus(run, stage);
    if (after === "running" || after === "failed") return resultFrom(run);
  }

  if (run.status !== "ready") return resultFrom(run);
  return resultFrom(run); // Publication requires a separate human decision.
}

/** Invokes only retention cleanup; it cannot start, step, or publish a run. */
export async function runCommunityCleanup({
  baseUrl,
  secret,
  fetchImpl = fetch,
}: CommunityWorkerOptions): Promise<CommunityWorkerResult> {
  const origin = validateCommunityWorkerBaseUrl(baseUrl);
  const workerSecret = requiredSecret(secret);
  return parseCleanupResult(await requestJson(
    fetchImpl,
    endpoint(origin, CLEANUP_PATH),
    workerSecret,
    "POST",
  ));
}

function isExpectedNonFailure(result: CommunityWorkerResult): boolean {
  return !["failed", "invalid_bot", "not_ready"].includes(result.status);
}

export async function runCommunityWorkerCli(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommunityWorkerResult> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--cleanup-only")) {
    throw new Error("community-agent-cli-arguments-invalid");
  }
  const options = {
    baseUrl: env.COMMUNITY_AGENT_APP_URL ?? "",
    secret: env.COMMUNITY_AGENT_WORKER_SECRET ?? "",
  };
  return args[0] === "--cleanup-only" ? runCommunityCleanup(options) : runCommunityWorker(options);
}

async function main(): Promise<void> {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
  try {
    const result = await runCommunityWorkerCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!isExpectedNonFailure(result)) process.exitCode = 1;
  } catch {
    process.stderr.write("community-agent worker failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
