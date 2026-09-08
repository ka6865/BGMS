const ALLOWED_HOSTS = new Set([
  "gall.dcinside.com",
  "openapi.naver.com",
  "www.googleapis.com",
]);
const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 6_000;

export type HttpDeps = {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
};

const cleanupByResponse = new WeakMap<Response, () => void>();

function rejectUrl(url: URL): void {
  if (
    url.protocol !== "https:" || url.username || url.password || url.port
    || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("source_url_rejected");
  }
}

function timeoutSignal(parent: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parent.reason ?? new Error("source_aborted"));
  const timer = setTimeout(() => controller.abort(new Error("source_timeout")), REQUEST_TIMEOUT_MS);
  if (parent.aborted) abortParent();
  else parent.addEventListener("abort", abortParent, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortParent);
    },
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return new Error(reason instanceof Error && reason.message === "source_timeout" ? "source_timeout" : "source_aborted");
}

/** Fetch only one of the explicit public providers; redirects and credentials are never followed. */
export async function fetchSource(url: URL, init: RequestInit, deps: HttpDeps): Promise<Response> {
  rejectUrl(url);
  const request = timeoutSignal(deps.signal);
  try {
    const response = await deps.fetchImpl(url, { ...init, redirect: "error", signal: request.signal });
    if (!response.ok) {
      request.cleanup();
      throw new Error(`source_http_${response.status}`);
    }
    cleanupByResponse.set(response, request.cleanup);
    return response;
  } catch (error) {
    request.cleanup();
    if (request.signal.aborted) throw abortError(request.signal);
    throw error;
  }
}

/** Read a bounded response body without retaining or logging the source document. */
export async function readSourceText(response: Response): Promise<string> {
  const cleanup = cleanupByResponse.get(response);
  try {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let output = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error("source_too_large");
        }
        output += decoder.decode(chunk.value, { stream: true });
      }
      return output + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } finally {
    cleanupByResponse.delete(response);
    cleanup?.();
  }
}

export async function fetchSourceText(url: URL, init: RequestInit, deps: HttpDeps): Promise<string> {
  return readSourceText(await fetchSource(url, init, deps));
}

export async function fetchSourceJson(url: URL, init: RequestInit, deps: HttpDeps): Promise<unknown> {
  const text = await fetchSourceText(url, init, deps);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("source_invalid_json");
  }
}
