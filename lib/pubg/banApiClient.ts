import { isBanAccountId, isBanPlatform, normalizeBanRawType, normalizeBanStatus, type BanPlatform, type BanStatus } from "./banStatus";

export type BanApiErrorCode = "invalid_input" | "missing_credentials" | "network_error" | "timeout" | "upstream_http" | "rate_limited" | "invalid_shape";

export class BanApiError extends Error {
  readonly code: BanApiErrorCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly platform: BanPlatform | null;
  constructor(code: BanApiErrorCode, fields: { status?: number | null; retryAfterSeconds?: number | null; platform?: BanPlatform | null } = {}) {
    super("PUBG ban API request failed");
    this.name = "BanApiError";
    this.code = code;
    this.status = fields.status ?? null;
    this.retryAfterSeconds = fields.retryAfterSeconds ?? null;
    this.platform = fields.platform ?? null;
  }
}

export type BanApiStatus = {
  platform: BanPlatform;
  accountId: string;
  rawType: string | null;
  status: BanStatus;
};

export type BanApiBatchResult = {
  platform: BanPlatform;
  requestedAccountIds: string[];
  statuses: BanApiStatus[];
  missingAccountIds: string[];
};

export type BanApiClientOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  trackRateLimit?: (headers: Headers) => void;
};

function uniqueAccountIds(platform: BanPlatform, values: readonly unknown[]): string[] {
  if (!isBanPlatform(platform)) throw new BanApiError("invalid_input", { platform: null });
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isBanAccountId(value)) throw new BanApiError("invalid_input", { platform });
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function chunkBanAccountIds(platform: BanPlatform, values: readonly unknown[], size = 10): string[][] {
  const ids = uniqueAccountIds(platform, values);
  if (!Number.isInteger(size) || size < 1 || size > 10) throw new BanApiError("invalid_input", { platform });
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
  return batches;
}

function retryAfterSeconds(headers: Headers): number | null {
  const value = headers.get("Retry-After")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  }
  const resetEpoch = Number(headers.get("X-RateLimit-Reset") || headers.get("X-Ratelimit-Reset"));
  return Number.isFinite(resetEpoch) ? Math.max(0, Math.ceil(resetEpoch - Date.now() / 1000)) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBatchPayload(payload: unknown, platform: BanPlatform, requestedAccountIds: readonly string[]): BanApiBatchResult {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new BanApiError("invalid_shape", { platform });
  const requested = new Set(requestedAccountIds);
  const seen = new Set<string>();
  const statuses: BanApiStatus[] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || !isBanAccountId(item.id) || !requested.has(item.id) || seen.has(item.id) || !isRecord(item.attributes)) {
      throw new BanApiError("invalid_shape", { platform });
    }
    seen.add(item.id);
    // A missing banType is an unknown observation, never a successful none.
    const rawType = normalizeBanRawType(item.attributes.banType);
    statuses.push({ platform, accountId: item.id, rawType, status: normalizeBanStatus(rawType) });
  }
  return {
    platform,
    requestedAccountIds: [...requestedAccountIds],
    statuses,
    missingAccountIds: requestedAccountIds.filter((id) => !seen.has(id)),
  };
}

function apiBaseUrl(value: string | undefined): string {
  const raw = (value || "https://api.pubg.com").trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new BanApiError("invalid_input"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.pubg.com" || url.username || url.password || url.port || url.pathname !== "/") {
    throw new BanApiError("invalid_input");
  }
  return url.href.slice(0, -1);
}

export async function fetchBanStatusBatch(
  platform: BanPlatform,
  accountIds: readonly unknown[],
  options: BanApiClientOptions = {},
): Promise<BanApiBatchResult> {
  const requestedAccountIds = uniqueAccountIds(platform, accountIds);
  if (!requestedAccountIds.length || requestedAccountIds.length > 10) throw new BanApiError("invalid_input", { platform });
  const apiKey = (options.apiKey ?? process.env.PUBG_API_KEY ?? "").split(" ")[0].trim();
  if (!apiKey) throw new BanApiError("missing_credentials", { platform });
  const base = apiBaseUrl(options.baseUrl);
  const url = new URL(`/shards/${platform}/players`, `${base}/`);
  url.searchParams.set("filter[playerIds]", requestedAccountIds.join(","));
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs as number) : 8_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    let response: Response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new BanApiError("timeout", { platform });
      throw new BanApiError("network_error", { platform });
    }
    try { options.trackRateLimit?.(response.headers); } catch { /* observability only */ }
    if (response.status === 429) throw new BanApiError("rate_limited", { platform, status: 429, retryAfterSeconds: retryAfterSeconds(response.headers) });
    if (!response.ok) throw new BanApiError("upstream_http", { platform, status: response.status });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new BanApiError("invalid_shape", { platform, status: response.status }); }
    return parseBatchPayload(payload, platform, requestedAccountIds);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBanStatuses(
  platform: BanPlatform,
  accountIds: readonly unknown[],
  options: BanApiClientOptions = {},
): Promise<BanApiBatchResult> {
  const batches = chunkBanAccountIds(platform, accountIds);
  const all: BanApiStatus[] = [];
  const missing: string[] = [];
  for (const batch of batches) {
    const result = await fetchBanStatusBatch(platform, batch, options);
    all.push(...result.statuses);
    missing.push(...result.missingAccountIds);
  }
  const requestedAccountIds = batches.flat();
  return { platform, requestedAccountIds, statuses: all, missingAccountIds: missing };
}

export function extractBanType(item: unknown): string | null {
  if (!isRecord(item) || !isRecord(item.attributes)) return null;
  return normalizeBanRawType(item.attributes.banType);
}
