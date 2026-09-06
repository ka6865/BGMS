import { trackPubgRateLimit } from "@/lib/pubg-analysis/pubgApiTracker";

const DEFAULT_TOTAL_TIMEOUT_MS = 25_000;
const DEFAULT_READ_TIMEOUT_MS = 8_000;

export type PlayerApiErrorCode =
  | "aborted"
  | "deadline_exceeded"
  | "timeout"
  | "network_error"
  | "upstream_5xx"
  | "upstream_http"
  | "invalid_content_type"
  | "empty_body"
  | "truncated_json"
  | "invalid_json"
  | "invalid_shape";

export interface PlayerApiErrorFields {
  stage: string;
  errorCode: PlayerApiErrorCode;
  upstreamStatus: number | null;
  contentType: string | null;
  responseBytes: number | null;
  durationMs: number;
  retryAfterSeconds: number | null;
}

/** Structured upstream failure. The message never contains URL/body data. */
export class PlayerApiError extends Error implements PlayerApiErrorFields {
  readonly stage: string;
  readonly errorCode: PlayerApiErrorCode;
  readonly upstreamStatus: number | null;
  readonly contentType: string | null;
  readonly responseBytes: number | null;
  readonly durationMs: number;
  readonly retryAfterSeconds: number | null;

  constructor(fields: PlayerApiErrorFields) {
    super("PUBG player API request failed");
    this.name = "PlayerApiError";
    this.stage = fields.stage;
    this.errorCode = fields.errorCode;
    this.upstreamStatus = fields.upstreamStatus;
    this.contentType = fields.contentType;
    this.responseBytes = fields.responseBytes;
    this.durationMs = fields.durationMs;
    this.retryAfterSeconds = fields.retryAfterSeconds;
  }
}

export interface PlayerApiReadOptions<T> {
  stage: string;
  validate: (payload: unknown) => payload is T;
  timeoutMs?: number;
}

export interface PlayerApiClientOptions {
  headers: HeadersInit;
  signal: AbortSignal;
  totalTimeoutMs?: number;
}

export interface PlayerApiClient {
  readonly signal: AbortSignal;
  read<T>(url: string, options: PlayerApiReadOptions<T>): Promise<T>;
  dispose(): void;
}

type ErrorDetails = Partial<Pick<
  PlayerApiErrorFields,
  "upstreamStatus" | "contentType" | "responseBytes" | "retryAfterSeconds"
>>;

function makeError(stage: string, errorCode: PlayerApiErrorCode, startedAt: number, details: ErrorDetails = {}): PlayerApiError {
  return new PlayerApiError({
    stage,
    errorCode,
    upstreamStatus: details.upstreamStatus ?? null,
    contentType: details.contentType ?? null,
    responseBytes: details.responseBytes ?? null,
    durationMs: Math.max(0, Date.now() - startedAt),
    retryAfterSeconds: details.retryAfterSeconds ?? null,
  });
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return mime === "application/json" || mime === "text/json" || mime.endsWith("+json");
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("Retry-After")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

/** Retry only JSON bodies that end while an object/array/string is open. */
function isTruncatedJson(value: string, parseError: unknown): boolean {
  const text = value.trim();
  if (!/^[{\[]|^"/u.test(text)) return false;
  const message = parseError instanceof SyntaxError ? parseError.message : "";
  if (!/(?:unexpected\s+end|unterminated|after\s+(?:property\s+value|array\s+element)|expected\s+[^\n]*(?:\}|\]))/iu.test(message)) return false;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      if (stack.pop() !== (character === "}" ? "{" : "[")) return false;
    }
  }
  return inString || stack.length > 0;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Races fetch/body promises even when a fixture ignores AbortSignal. */
function awaitWithSignal<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function cancelBody(response: Response): void {
  try {
    response.body?.cancel()?.catch(() => undefined);
  } catch {
    // Best effort for mocked/platform-specific Response objects.
  }
}

function retryable(error: PlayerApiError): boolean {
  return ["network_error", "timeout", "upstream_5xx", "empty_body", "truncated_json"]
    .includes(error.errorCode);
}

export function createPlayerApiClient(options: PlayerApiClientOptions): PlayerApiClient {
  const parentSignal = options.signal;
  const controller = new AbortController();
  const state = { parentAborted: false, deadlineExpired: false, disposed: false };
  const totalTimeoutMs = normalizeTimeout(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
  const deadlineAt = Date.now() + totalTimeoutMs;
  const interrupted = () => state.parentAborted || state.deadlineExpired || state.disposed;
  const interruption = (stage: string, startedAt: number) => makeError(
    stage,
    state.deadlineExpired ? "deadline_exceeded" : "aborted",
    startedAt,
  );

  const onParentAbort = () => {
    state.parentAborted = true;
    if (!controller.signal.aborted) controller.abort();
  };
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (totalTimeoutMs <= 0) {
    state.deadlineExpired = true;
    controller.abort();
  } else {
    deadlineTimer = setTimeout(() => {
      if (state.disposed || state.parentAborted || controller.signal.aborted) return;
      state.deadlineExpired = true;
      controller.abort();
    }, totalTimeoutMs);
  }

  // One token is shared by all stage reads, including concurrent reads.
  let retryBudget = 1;
  const claimRetry = () => retryBudget > 0 && (retryBudget -= 1, true);

  const read = async <T>(url: string, readOptions: PlayerApiReadOptions<T>): Promise<T> => {
    const startedAt = Date.now();
    const stage = readOptions.stage.trim() || "unknown";
    const timeoutMs = normalizeTimeout(readOptions.timeoutMs, DEFAULT_READ_TIMEOUT_MS);
    if (interrupted() || controller.signal.aborted) throw interruption(stage, startedAt);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (interrupted() || controller.signal.aborted) throw interruption(stage, startedAt);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        state.deadlineExpired = true;
        if (!controller.signal.aborted) controller.abort();
        throw interruption(stage, startedAt);
      }

      const attemptController = new AbortController();
      const attemptSignal = attemptController.signal;
      let timedOut = false;
      const onClientAbort = () => {
        if (!attemptSignal.aborted) attemptController.abort();
      };
      controller.signal.addEventListener("abort", onClientAbort, { once: true });
      const attemptTimer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, Math.min(timeoutMs, remainingMs));

      try {
        let response: Response;
        try {
          response = await awaitWithSignal(fetch(url, {
            headers: options.headers,
            cache: "no-store",
            signal: attemptSignal,
          }), attemptSignal);
        } catch {
          if (interrupted()) throw interruption(stage, startedAt);
          throw makeError(stage, timedOut ? "timeout" : "network_error", startedAt);
        }

        try {
          trackPubgRateLimit(response.headers);
        } catch {
          // Rate-limit tracking is observability only.
        }
        if (interrupted()) throw interruption(stage, startedAt);

        const status = response.status;
        const contentType = response.headers.get("content-type");
        if (!response.ok) {
          cancelBody(response);
          throw makeError(stage, status >= 500 && status <= 599 ? "upstream_5xx" : "upstream_http", startedAt, {
            upstreamStatus: status,
            contentType,
            retryAfterSeconds: status === 429 ? retryAfterSeconds(response.headers) : null,
          });
        }
        if (!isJsonContentType(contentType)) {
          cancelBody(response);
          throw makeError(stage, "invalid_content_type", startedAt, { upstreamStatus: status, contentType });
        }

        let body: string;
        try {
          body = await awaitWithSignal(response.text(), attemptSignal);
        } catch {
          if (interrupted()) throw interruption(stage, startedAt);
          throw makeError(stage, timedOut ? "timeout" : "network_error", startedAt, {
            upstreamStatus: status,
            contentType,
          });
        }
        const responseBytes = new TextEncoder().encode(body).byteLength;
        if (!body.trim()) throw makeError(stage, "empty_body", startedAt, { upstreamStatus: status, contentType, responseBytes });

        let payload: unknown;
        try {
          payload = JSON.parse(body) as unknown;
        } catch (parseError) {
          throw makeError(stage, isTruncatedJson(body, parseError) ? "truncated_json" : "invalid_json", startedAt, {
            upstreamStatus: status,
            contentType,
            responseBytes,
          });
        }

        let valid = false;
        try {
          valid = readOptions.validate(payload);
        } catch {
          valid = false;
        }
        if (!valid) throw makeError(stage, "invalid_shape", startedAt, { upstreamStatus: status, contentType, responseBytes });
        if (interrupted()) throw interruption(stage, startedAt);
        return payload as T;
      } catch (caught) {
        const error = caught instanceof PlayerApiError ? caught : makeError(stage, "network_error", startedAt);
        if (retryable(error) && attempt === 0 && !interrupted() && claimRetry()) continue;
        throw error;
      } finally {
        clearTimeout(attemptTimer);
        controller.signal.removeEventListener("abort", onClientAbort);
      }
    }
    throw makeError(stage, "network_error", startedAt);
  };

  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    parentSignal.removeEventListener("abort", onParentAbort);
    if (!controller.signal.aborted) controller.abort();
  };

  return { signal: controller.signal, read, dispose };
}
