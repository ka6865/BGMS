const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODE_PATTERN = /^[a-z0-9-]+$/;

export const RAW_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
export const RAW_SOURCE_TOTAL_MAX_BYTES = 96 * 1024 * 1024;

export function validatePlatform(value: string): "steam" | "kakao" {
  const platform = value.trim().toLowerCase();
  if (platform !== "steam" && platform !== "kakao") throw new Error("invalid_platform");
  return platform;
}

export function validateMode(value: string): string {
  const mode = value.trim().toLowerCase();
  if (mode.length === 0 || mode.length > 64 || !MODE_PATTERN.test(mode)) throw new Error("invalid_mode");
  return mode;
}

export function validateMatchIds(values: readonly string[], max = 3): string[] {
  const ids = values.map((value) => value.trim().toLowerCase());
  if (ids.length < 1 || ids.length > max) throw new Error("raw_acquisition_candidate_cap_exceeded");
  if (ids.some((id) => !UUID_PATTERN.test(id))) throw new Error("invalid_match_id");
  if (new Set(ids).size !== ids.length) throw new Error("duplicate_match_id");
  return ids;
}

export function assertHttpsHost(value: string, allowed: RegExp, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed.test(url.hostname)) {
    throw new Error(`${label}_host_rejected`);
  }
  return url;
}

export async function readJsonBodyWithinLimit(
  response: Response,
  options: { maxBytes: number; remainingBytes?: number; label: string },
): Promise<{ value: any; bytes: number }> {
  const contentLength = Number(response.headers.get("content-length"));
  const remaining = options.remainingBytes ?? Number.POSITIVE_INFINITY;
  if (Number.isFinite(contentLength) && (contentLength > options.maxBytes || contentLength > remaining)) {
    await response.body?.cancel("byte cap");
    throw new Error(`${options.label}_byte_cap`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${options.label}_body_missing`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > options.maxBytes || bytes > remaining) {
        await reader.cancel("byte cap");
        throw new Error(`${options.label}_byte_cap`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return { value: JSON.parse(text), bytes };
}
