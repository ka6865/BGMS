import "server-only";
import { createHash } from "node:crypto";
import { MAYHEM_EXTERNAL_ID_PATTERN } from "./mayhemDatasetView";

const BASE_URL = "https://arammayhem.com";
const INDEX_URL = `${BASE_URL}/data/v1/index.json`;
const AUGMENTS_URL = `${BASE_URL}/data/v1/latest/augments.json`;
const COMBOS_URL = `${BASE_URL}/data/v1/latest/combos.json`;
const DATA_URL = `${BASE_URL}/data/`;
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const ATTRIBUTION = "Data: arammayhem.com";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_JSON_NODES = 250_000;
const MAX_JSON_DEPTH = 64;

export type MayhemRawFile = {
  url: string;
  body: string;
  hash: string;
  etag: string | null;
  lastModified: string | null;
};

export type MayhemDataset = {
  batchHash: string;
  releaseId: string;
  raw: { index: MayhemRawFile; augments: MayhemRawFile; combos: MayhemRawFile };
  rates: Array<{ externalId: string; pickRate: number | null; pickRateRank: number | null; sourcePatch: string }>;
  combos: Array<{ comboId: number; championId: string; augmentIds: string[]; types: string[]; sourceUrl: string }>;
  metadata: { sourceStatsDate: string | null; sourcePatch: string; statsDateSource: string | null; license: string; attribution: string };
};

type SourceErrorCode =
  | "source_fetch_failed" | "source_forbidden" | "source_http_error" | "source_redirect"
  | "source_content_type" | "source_too_large" | "source_empty" | "source_read_failed"
  | "source_invalid_utf8" | "source_invalid_json" | "source_invalid_schema"
  | "source_release_mismatch" | "source_patch_mismatch" | "source_metadata_mismatch";

class SourceError extends Error {
  constructor(code: SourceErrorCode) {
    super(code);
    this.name = "SourceError";
  }
}

function fail(code: SourceErrorCode): never {
  throw new SourceError(code);
}

function safeJsonTree(root: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail("source_invalid_schema");
    if (Array.isArray(value)) {
      if (count + stack.length + value.length > MAX_JSON_NODES) fail("source_invalid_schema");
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else if (value !== null && typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) fail("source_invalid_schema");
      const keys = Object.keys(value);
      if (count + stack.length + keys.length > MAX_JSON_NODES) fail("source_invalid_schema");
      for (const key of keys) {
        if (unsafeKeys.has(key.toLowerCase())) fail("source_invalid_schema");
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("source_invalid_schema");
  }
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, max: number, min = 1): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("source_invalid_schema");
  return value;
}

function requiredString(value: unknown, pattern: RegExp, maxLength = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    fail("source_invalid_schema");
  }
  return value;
}

function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("source_invalid_schema");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail("source_invalid_schema");
  return value;
}

function optionalStatsDateSource(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value !== "release" && value !== "estimated") fail("source_invalid_schema");
  return value;
}

function reconcile<T extends string>(left: T | null, right: T | null): T | null {
  if (left !== null && right !== null && left !== right) fail("source_metadata_mismatch");
  return left ?? right;
}

function parseJson(raw: MayhemRawFile): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw.body) as unknown;
  } catch {
    return fail("source_invalid_json");
  }
  safeJsonTree(value);
  return record(value);
}

function validateIndex(index: Record<string, unknown>): { releaseId: string; patch: string; patchMetadata: Record<string, unknown> | null } {
  if (index.schemaVersion !== 1 || index.apiVersion !== "v1") fail("source_invalid_schema");
  const releaseId = requiredString(index.releaseId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const license = record(index.license);
  if (license.name !== "CC BY 4.0" || license.url !== LICENSE_URL || license.attribution !== ATTRIBUTION
    || license.attributionUrl !== `${BASE_URL}/` || license.terms !== DATA_URL) fail("source_invalid_schema");
  const latest = record(index.latest);
  const patch = requiredString(latest.patch, /^\d{1,3}\.\d{1,3}$/);
  if (index.latestPatch !== patch || latest.folder !== "latest") fail("source_invalid_schema");
  const files = record(latest.files);
  if (record(files.augments).json !== AUGMENTS_URL || record(files.combos).json !== COMBOS_URL) fail("source_invalid_schema");
  let patchMetadata: Record<string, unknown> | null = null;
  if (index.patches !== undefined) {
    const patches = boundedArray(index.patches, 128, 0).map(record);
    const matches = patches.filter(item => item.patch === patch);
    if (matches.length > 1) fail("source_invalid_schema");
    patchMetadata = matches[0] ?? null;
  }
  return { releaseId, patch, patchMetadata };
}

function validateDataHeader(document: Record<string, unknown>) {
  if (document.schemaVersion !== 1 || document.source !== DATA_URL || document.attribution !== ATTRIBUTION
    || document.licenseUrl !== LICENSE_URL || typeof document.license !== "string"
    || document.license.length > 256 || !/^CC BY 4\.0(?:\b|:)/.test(document.license) || /[<>\u0000-\u001f\u007f]/.test(document.license)) {
    fail("source_invalid_schema");
  }
}

function safeComboUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) fail("source_invalid_schema");
  try {
    const parsed = new URL(value);
    if (parsed.origin !== BASE_URL || parsed.username || parsed.password || parsed.hash) fail("source_invalid_schema");
  } catch (error) {
    if (error instanceof SourceError) throw error;
    return fail("source_invalid_schema");
  }
  return value;
}

function nullableRate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) fail("source_invalid_schema");
  return value;
}

function nullableRank(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("source_invalid_schema");
  return value;
}

function jsonContentType(value: string | null): boolean {
  return value !== null && /^application\/(?:json|[a-z0-9.+-]+\+json)\s*(?:;|$)/i.test(value);
}

async function rejectResponse(response: Response, code: SourceErrorCode): Promise<never> {
  try { await response.body?.cancel(); } catch { /* response is already closed */ }
  return fail(code);
}

async function downloadRaw(url: string, fetcher: typeof fetch): Promise<MayhemRawFile> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    return fail("source_fetch_failed");
  }
  if (response.status === 403) return rejectResponse(response, "source_forbidden");
  if (!response.ok) return rejectResponse(response, "source_http_error");
  if (response.redirected) return rejectResponse(response, "source_redirect");
  if (response.url) {
    try {
      if (new URL(response.url).href !== url) return rejectResponse(response, "source_redirect");
    } catch {
      return rejectResponse(response, "source_redirect");
    }
  }
  if (!jsonContentType(response.headers.get("content-type"))) return rejectResponse(response, "source_content_type");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_FILE_BYTES)) {
    return rejectResponse(response, "source_too_large");
  }
  if (!response.body) fail("source_empty");

  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if ([etag, lastModified].some(value => value !== null && (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)))) {
    fail("source_invalid_schema");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) fail("source_too_large");
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    return fail("source_read_failed");
  } finally {
    try { await reader.cancel(); } catch { /* reader is already closed */ }
  }

  const bytes = Buffer.concat(chunks, size);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("source_invalid_utf8");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) fail("source_too_large");
  return { url, body, hash: createHash("sha256").update(bytes).digest("hex"), etag, lastModified };
}

export async function downloadMayhemDataset(fetcher: typeof fetch = fetch): Promise<MayhemDataset> {
  const indexRaw = await downloadRaw(INDEX_URL, fetcher);
  const index = parseJson(indexRaw);
  const initial = validateIndex(index);

  const augmentsRaw = await downloadRaw(AUGMENTS_URL, fetcher);
  const combosRaw = await downloadRaw(COMBOS_URL, fetcher);
  const indexAgainRaw = await downloadRaw(INDEX_URL, fetcher);
  const indexAgain = validateIndex(parseJson(indexAgainRaw));
  if (indexAgain.releaseId !== initial.releaseId || indexAgain.patch !== initial.patch) fail("source_release_mismatch");

  if ([indexRaw, augmentsRaw, combosRaw].reduce((sum, file) => sum + Buffer.byteLength(file.body, "utf8"), 0) > MAX_BATCH_BYTES) {
    fail("source_too_large");
  }

  const augments = parseJson(augmentsRaw);
  const combosDocument = parseJson(combosRaw);
  validateDataHeader(augments);
  validateDataHeader(combosDocument);

  const augmentsMeta = record(augments.meta);
  const combosMeta = record(combosDocument.meta);
  if (augmentsMeta.releaseId !== initial.releaseId || combosMeta.releaseId !== initial.releaseId) fail("source_release_mismatch");
  const sourcePatch = requiredString(augmentsMeta.patch, /^\d{1,3}\.\d{1,3}$/);
  if (sourcePatch !== initial.patch) fail("source_patch_mismatch");

  const indexDate = optionalDate(initial.patchMetadata?.statsDate);
  const augmentDate = optionalDate(augmentsMeta.statsDate);
  const indexDateSource = optionalStatsDateSource(initial.patchMetadata?.statsDateSource);
  const augmentDateSource = optionalStatsDateSource(augmentsMeta.statsDateSource);
  const sourceStatsDate = reconcile(indexDate, augmentDate);
  const statsDateSource = reconcile(indexDateSource, augmentDateSource);

  const rateRows = boundedArray(augments.rows, MAX_ROWS).map(record);
  const rateIds = new Set<string>();
  const rates = rateRows.map(row => {
    const externalId = requiredString(row.augmentId, MAYHEM_EXTERNAL_ID_PATTERN, 128);
    if (rateIds.has(externalId)) fail("source_invalid_schema");
    rateIds.add(externalId);
    return { externalId, pickRate: nullableRate(row.pickRate), pickRateRank: nullableRank(row.pickRateRank), sourcePatch };
  });

  const comboRows = boundedArray(combosDocument.rows, MAX_ROWS).map(record);
  const comboIds = new Set<number>();
  const combos = comboRows.map(row => {
    const comboId = row.comboId;
    if (typeof comboId !== "number" || !Number.isSafeInteger(comboId) || comboId < 1 || comboIds.has(comboId)) fail("source_invalid_schema");
    comboIds.add(comboId);
    const championId = requiredString(row.championId, /^[A-Za-z][A-Za-z0-9]{0,63}$/);
    const augmentIds = boundedArray(row.augmentIds, 64).map(value => requiredString(value, MAYHEM_EXTERNAL_ID_PATTERN, 128));
    if (new Set(augmentIds).size !== augmentIds.length) fail("source_invalid_schema");
    const types = boundedArray(row.types, 16, 0).map(value => requiredString(value, /^[A-Za-z][A-Za-z0-9_-]{0,31}$/));
    if (new Set(types).size !== types.length) fail("source_invalid_schema");
    return { comboId, championId, augmentIds, types, sourceUrl: safeComboUrl(row.url) };
  });

  const batchHash = createHash("sha256").update(JSON.stringify([
    ["augments", augmentsRaw.hash], ["combos", combosRaw.hash],
  ].sort(([left], [right]) => left.localeCompare(right)))).digest("hex");

  return {
    batchHash,
    releaseId: initial.releaseId,
    raw: { index: indexRaw, augments: augmentsRaw, combos: combosRaw },
    rates,
    combos,
    metadata: { sourceStatsDate, sourcePatch, statsDateSource, license: "CC BY 4.0", attribution: ATTRIBUTION },
  };
}
