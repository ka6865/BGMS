/**
 * Safely gzip existing JSON objects in bounded R2 batches.
 *
 * Dry-run reads a bounded sample and measures actual gzip output. Apply saves
 * each original locally before an ETag-conditional replacement, verifies the
 * exact bytes, and only rolls back conditionally against the replacement ETag.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config as loadDotenv } from "dotenv";
import { gunzipSync, gzipSync } from "node:zlib";
import { compressJsonText } from "../lib/pubg-analysis/r2Service";
import { inspectDeletionKey } from "../lib/pubg-analysis/r2DeletionGuard";
import { sealRecoveryBytes } from "./r2_recovery_archive";

export const RECOMPRESS_BATCH_LIMIT = 20;
export const RECOMPRESS_CONCURRENCY = 2;

const DEFAULT_MAX_PAGES = 1;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_OBJECTS = 5000;
const MAX_DURATION_MS = 15 * 60_000;
const MAX_CONCURRENCY = 4;
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

export type RecompressCandidate = { key: string; sizeBytes: number };

export type RecompressResult = {
  scannedObjects: number; scannedBytes: number; prefixBytes: number; pages: number;
  truncated: boolean; nextCursor: string | null; inventoryOnly: boolean;
  groups: RecompressGroup[]; inventory?: InventoryObject[];
  jsonObjects: number; skippedByGuard: number; objectsRead: number; gzipCount: number;
  alreadyCompressed: number; notWorthCompressing: number; estimatedSavedBytes: number;
  processed: number; savedBytes: number; recoveryBytes: number; estimatedRecoveryBytes: number;
  netSavedBytes: number; durableBackupKeys: string[]; conflicts: number; ambiguous: number;
  failed: Array<{ key: string; code: string }>;
  dryRun: boolean;
};

type S3Like = { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> };
type InventoryObject = { key: string; sizeBytes: number; etag?: string; lastModified?: string; storageClass?: string };
type RecompressGroup = { group: string; objects: number; bytes: number; jsonObjects: number };
type ObjectHeaders = { ContentType?: string; ContentEncoding?: string; CacheControl?: string; ContentDisposition?: string; ContentLanguage?: string; Expires?: Date; WebsiteRedirectLocation?: string; StorageClass?: string; Metadata?: Record<string, string> };
type ReadObject = { bytes: Buffer; etag?: string; headers: ObjectHeaders };
type CursorPayload = { version: 1; prefix: string; startAfter: string };

export function isRecompressTarget(key: string): boolean {
  return inspectDeletionKey(key).allowed && key.toLowerCase().endsWith(".json");
}

function positiveInt(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`invalid-argument:${name}`);
  }
  return value;
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, prefix: string): CursorPayload | undefined {
  if (!value) return undefined;
  if (value.length > 8_000) throw new Error("invalid-argument:cursor-too-large");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorPayload;
    if (parsed.version !== 1 || parsed.prefix !== prefix || typeof parsed.startAfter !== "string" || parsed.startAfter.length > 1024) throw new Error();
    return parsed;
  } catch {
    throw new Error("invalid-argument:cursor");
  }
}

function responseHeaders(value: Record<string, unknown>): ObjectHeaders {
  const headers: ObjectHeaders = {};
  for (const key of ["ContentType", "ContentEncoding", "CacheControl", "ContentDisposition", "ContentLanguage", "WebsiteRedirectLocation", "StorageClass"] as const) {
    const item = value[key];
    if (typeof item === "string") headers[key] = item;
  }
  if (value.Expires instanceof Date) headers.Expires = value.Expires;
  if (value.Metadata && typeof value.Metadata === "object") {
    headers.Metadata = { ...(value.Metadata as Record<string, string>) };
  }
  return headers;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && ["timeout", "object_too_large", "empty_body", "list_cursor_missing", "missing_etag", "verify_etag_mismatch", "verify_bytes_mismatch", "recovery_backup_verify_failed", "apply_budget_reserved_for_recovery"].includes(error.message)) {
    return error.message;
  }
  const value = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = value?.$metadata?.httpStatusCode;
  if (status === 412 || value?.name === "PreconditionFailed" || value?.Code === "PreconditionFailed") return "precondition_failed";
  if (value?.name === "AbortError" || value?.name === "TimeoutError") return "timeout";
  if (typeof status === "number" && status >= 500) return "upstream_5xx";
  if (typeof status === "number" && status >= 400) return `upstream_${status}`;
  const code = value?.name ?? value?.Code ?? value?.code;
  if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(code)) return code.toLowerCase();
  return "request_failed";
}

function throwIfDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("timeout");
}

async function sendBounded<T>(
  client: S3Like,
  command: unknown,
  deadline: number,
  requestTimeoutMs: number,
): Promise<T> {
  throwIfDeadline(deadline);
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()));
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([client.send(command, { abortSignal: controller.signal }) as Promise<T>, timedOut]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readObject(
  client: S3Like,
  bucket: string,
  key: string,
  deadline: number,
  requestTimeoutMs: number,
  maxObjectBytes: number,
  ifMatch?: string,
): Promise<ReadObject> {
  const requestDeadline = Math.min(deadline, Date.now() + requestTimeoutMs);
  const response = await sendBounded<Record<string, unknown>>(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key, ...(ifMatch ? { IfMatch: ifMatch } : {}) }),
    requestDeadline,
    requestTimeoutMs,
  );
  if (!response.Body || typeof (response.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
    throw new Error("empty_body");
  }
  const controller = new AbortController();
  const chunks: Buffer[] = [];
  let total = 0;
  const bodyStream = response.Body as { destroy?: (error?: Error) => void };
  const timer = setTimeout(() => {
    controller.abort();
    bodyStream.destroy?.(new Error("timeout"));
  }, Math.max(1, requestDeadline - Date.now()));
  try {
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      if (controller.signal.aborted || Date.now() >= requestDeadline) throw new Error("timeout");
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxObjectBytes) throw new Error("object_too_large");
      chunks.push(bytes);
    }
  } catch (error) {
    if (controller.signal.aborted || Date.now() >= requestDeadline) throw new Error("timeout");
    bodyStream.destroy?.();
    throw error;
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) await (response.Body as { destroy?: (error?: Error) => void }).destroy?.();
  }
  return {
    bytes: Buffer.concat(chunks, total),
    etag: typeof response.ETag === "string" ? response.ETag : undefined,
    headers: responseHeaders(response),
  };
}

function putHeaders(headers: ObjectHeaders, compressed: boolean): Record<string, unknown> {
  return {
    ...(headers.ContentType ? { ContentType: headers.ContentType } : {}),
    ...(compressed ? { ContentEncoding: "gzip" } : headers.ContentEncoding ? { ContentEncoding: headers.ContentEncoding } : {}),
    ...(headers.CacheControl ? { CacheControl: headers.CacheControl } : {}),
    ...(headers.ContentDisposition ? { ContentDisposition: headers.ContentDisposition } : {}),
    ...(headers.ContentLanguage ? { ContentLanguage: headers.ContentLanguage } : {}),
    ...(headers.Expires ? { Expires: headers.Expires } : {}),
    ...(headers.WebsiteRedirectLocation ? { WebsiteRedirectLocation: headers.WebsiteRedirectLocation } : {}),
    ...(headers.StorageClass ? { StorageClass: headers.StorageClass } : {}),
    ...(headers.Metadata ? { Metadata: headers.Metadata } : {}),
  };
}

async function persistRecoveryOriginal(
  backupDir: string,
  bucket: string,
  key: string,
  original: ReadObject,
): Promise<string> {
  if (!original.etag) throw new Error("missing_etag");
  const root = resolve(backupDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(`${bucket}\0${key}`).digest("hex");
  const originalPath = resolve(root, `${digest}.original`);
  const file = await open(originalPath, "wx", 0o600);
  try {
    await file.writeFile(original.bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const manifestPath = resolve(root, "manifest.jsonl");
  const manifest = await open(manifestPath, "a", 0o600);
  try {
    await manifest.writeFile(`${JSON.stringify({
      version: 1,
      bucket,
      key,
      etag: original.etag,
      originalPath,
      headers: original.headers,
      recordedAt: new Date().toISOString(),
    })}\n`);
    await manifest.sync();
  } finally {
    await manifest.close();
  }
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return originalPath;
}

export async function runR2Recompression(options: {
  apply?: boolean;
  limit?: number;
  maxObjects?: number;
  maxPages?: number;
  pageSize?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
  maxObjectBytes?: number;
  concurrency?: number;
  prefix?: string;
  cursor?: string;
  startAfter?: string;
  inventoryOnly?: boolean;
  json?: boolean;
  recoveryDir?: string;
  durableRecoveryPrefix?: string;
  env?: Record<string, string | undefined>;
  client?: S3Like;
  createClient?: (config: { endpoint: string; accessKeyId: string; secretAccessKey: string }) => S3Like;
  write?: (message: string) => void;
} = {}): Promise<RecompressResult> {
  const apply = options.apply === true;
  const write = options.json ? (() => undefined) : options.write ?? ((message: string) => console.info(message));
  const prefix = options.prefix ?? "";
  if (typeof prefix !== "string" || prefix.length > 1024 || prefix.includes("\0")) throw new Error("invalid-argument:prefix");
  const limit = positiveInt(options.limit ?? options.maxObjects, "limit", RECOMPRESS_BATCH_LIMIT, MAX_OBJECTS);
  if (options.limit !== undefined && options.maxObjects !== undefined && options.limit !== options.maxObjects) {
    throw new Error("invalid-argument:limit");
  }
  const maxPages = positiveInt(options.maxPages, "max-pages", DEFAULT_MAX_PAGES, MAX_PAGES);
  const pageSize = positiveInt(options.pageSize, "page-size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const maxDurationMs = positiveInt(options.maxDurationMs, "max-duration-ms", DEFAULT_MAX_DURATION_MS, MAX_DURATION_MS);
  const requestTimeoutMs = positiveInt(options.requestTimeoutMs, "request-timeout-ms", DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_DURATION_MS);
  const maxObjectBytes = positiveInt(options.maxObjectBytes, "max-object-bytes", DEFAULT_MAX_OBJECT_BYTES, MAX_OBJECT_BYTES);
  const concurrency = positiveInt(options.concurrency, "concurrency", RECOMPRESS_CONCURRENCY, MAX_CONCURRENCY);
  if (options.recoveryDir && !isAbsolute(options.recoveryDir)) throw new Error("invalid-argument:recovery-dir-must-be-absolute");
  const durableRecoveryPrefix = options.durableRecoveryPrefix;
  if (durableRecoveryPrefix !== undefined && (!durableRecoveryPrefix.startsWith("backups/r2-recompression/")
    || durableRecoveryPrefix.includes("..") || durableRecoveryPrefix.includes("\\")
    || durableRecoveryPrefix.includes("\0") || !durableRecoveryPrefix.endsWith("/"))) {
    throw new Error("invalid-argument:durable-recovery-prefix");
  }
  if (options.startAfter !== undefined && (options.startAfter.length > 1024 || options.startAfter.includes("\0"))) {
    throw new Error("invalid-argument:start-after");
  }
  const decodedCursor = decodeCursor(options.cursor, prefix);
  if (decodedCursor && (!decodedCursor.startAfter.startsWith(prefix) || (options.startAfter && decodedCursor.startAfter !== options.startAfter))) {
    throw new Error("invalid-argument:start-after-cursor-mismatch");
  }
  const env = options.env ?? process.env;
  const recoverySecret = env.R2_RECOVERY_ARCHIVE_KEY;
  if (apply && !durableRecoveryPrefix) throw new Error("durable-recovery-prefix-required");
  if ((apply || durableRecoveryPrefix) && !recoverySecret?.trim()) throw new Error("r2-recovery-secret-missing");
  const endpoint = env.CLOUDFLARE_R2_ENDPOINT?.trim();
  const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.CLOUDFLARE_R2_BUCKET_NAME?.trim();
  if (!options.client && (!endpoint || !accessKeyId || !secretAccessKey || !bucket)) {
    throw new Error("r2-recompress-credentials-missing");
  }
  if (!bucket) throw new Error("r2-recompress-credentials-missing");

  const s3: S3Like = options.client ?? options.createClient?.({ endpoint: endpoint!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! })
    ?? new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      forcePathStyle: true,
      maxAttempts: 1,
    });
  const deadline = Date.now() + maxDurationMs;
  const recoveryReserveMs = apply ? Math.min(requestTimeoutMs, Math.max(1, Math.floor(maxDurationMs * 0.25))) : 0;
  const mutationDeadline = deadline - recoveryReserveMs;
  const result: RecompressResult = {
    scannedObjects: 0,
    scannedBytes: 0,
    prefixBytes: 0,
    pages: 0,
    truncated: false,
    nextCursor: null,
    inventoryOnly: options.inventoryOnly === true,
    groups: [],
    ...(options.inventoryOnly ? { inventory: [] } : {}),
    jsonObjects: 0,
    skippedByGuard: 0,
    objectsRead: 0,
    gzipCount: 0,
    alreadyCompressed: 0,
    notWorthCompressing: 0,
    estimatedSavedBytes: 0,
    processed: 0,
    savedBytes: 0,
    recoveryBytes: 0,
    estimatedRecoveryBytes: 0,
    netSavedBytes: 0,
    durableBackupKeys: [],
    conflicts: 0,
    ambiguous: 0,
    failed: [],
    dryRun: !apply,
  };

  const startAfter = decodedCursor?.startAfter ?? options.startAfter;
  const candidates: RecompressCandidate[] = [];
  const inventoryCandidates: InventoryObject[] = [];
  const groupMap = new Map<string, RecompressGroup>();
  let token: string | undefined;
  let finished = false;
  let lastListedKey: string | undefined;
  while (!finished && result.pages < maxPages
    && (options.inventoryOnly ? inventoryCandidates.length : candidates.length) < limit) {
    throwIfDeadline(deadline);
    const page = await sendBounded<{
      Contents?: Array<{ Key?: string; Size?: number; ETag?: string; LastModified?: Date; StorageClass?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    }>(s3, new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      ContinuationToken: token,
      ...(!token && startAfter ? { StartAfter: startAfter } : {}),
      MaxKeys: options.inventoryOnly ? Math.min(pageSize, limit - inventoryCandidates.length) : pageSize,
    }), deadline, requestTimeoutMs);
    result.pages += 1;
    for (const item of page.Contents ?? []) {
      result.scannedObjects += 1;
      result.prefixBytes += Math.max(0, item.Size ?? 0);
      result.scannedBytes += Math.max(0, item.Size ?? 0);
      const key = item.Key ?? "";
      if (!key) continue;
      lastListedKey = key;
      const entry: InventoryObject = {
        key,
        sizeBytes: Math.max(0, item.Size ?? 0),
        ...(item.ETag ? { etag: item.ETag } : {}),
        ...(item.LastModified instanceof Date ? { lastModified: item.LastModified.toISOString() } : {}),
        ...(item.StorageClass ? { storageClass: item.StorageClass } : {}),
      };
      const directories = key.split("/").slice(0, -1);
      const groupName = directories.length ? directories.slice(0, 2).join("/") : "(root)";
      const group = groupMap.get(groupName) ?? { group: groupName, objects: 0, bytes: 0, jsonObjects: 0 };
      group.objects += 1;
      group.bytes += entry.sizeBytes;
      groupMap.set(groupName, group);
      if (!inspectDeletionKey(key).allowed) {
        result.skippedByGuard += 1;
      } else if (isRecompressTarget(key)) {
        result.jsonObjects += 1;
        group.jsonObjects += 1;
        if (!options.inventoryOnly) candidates.push({ key, sizeBytes: entry.sizeBytes });
      }
      if (options.inventoryOnly) inventoryCandidates.push(entry);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) throw new Error("list_cursor_missing");
    finished = !page.IsTruncated;
    const foundLimit = options.inventoryOnly ? inventoryCandidates.length >= limit : candidates.length >= limit;
    if (foundLimit) break;
  }
  result.groups = [...groupMap.values()].sort((left, right) => left.group.localeCompare(right.group));

  const entries = options.inventoryOnly ? inventoryCandidates : candidates;
  const selected = options.inventoryOnly ? [] : candidates.slice(0, limit);
  const selectedInventory = options.inventoryOnly ? inventoryCandidates.slice(0, limit) : [];
  const moreListed = Boolean(token) || !finished || entries.length > limit;
  result.truncated = moreListed;
  if (options.inventoryOnly) result.inventory = selectedInventory;

  const processOne = async (candidate: RecompressCandidate): Promise<boolean> => {
    try {
      throwIfDeadline(deadline);
      result.objectsRead += 1;
      const original = await readObject(s3, bucket, candidate.key, apply ? mutationDeadline : deadline, requestTimeoutMs, maxObjectBytes);
      const isGzip = (original.bytes.length >= 2 && original.bytes[0] === 0x1f && original.bytes[1] === 0x8b)
        || original.headers.ContentEncoding?.toLowerCase().split(",").map((part) => part.trim()).includes("gzip");
      if (isGzip) {
        result.alreadyCompressed += 1;
        return true;
      }
      if (original.headers.ContentEncoding && original.headers.ContentEncoding.toLowerCase() !== "identity") {
        result.failed.push({ key: candidate.key, code: "unsupported_content_encoding" });
        return false;
      }
      if (!original.etag) {
        result.failed.push({ key: candidate.key, code: "missing_etag" });
        return false;
      }
      const text = original.bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(original.bytes)) {
        result.failed.push({ key: candidate.key, code: "invalid_utf8" });
        return false;
      }
      try {
        JSON.parse(text);
      } catch {
        result.failed.push({ key: candidate.key, code: "invalid_json" });
        return false;
      }
      const compressed = compressJsonText(text);
      if (compressed.length >= original.bytes.length) {
        result.notWorthCompressing += 1;
        return true;
      }
      const estimated = original.bytes.length - compressed.length;
      const recoveryPayload = durableRecoveryPrefix ? Buffer.from(JSON.stringify({
        version: 1,
        bucket,
        key: candidate.key,
        etag: original.etag,
        headers: original.headers,
        originalSha256: createHash("sha256").update(original.bytes).digest("hex"),
        originalBase64: original.bytes.toString("base64"),
      })) : undefined;
      const sealedRecovery = recoveryPayload
        ? sealRecoveryBytes(gzipSync(recoveryPayload), recoverySecret!)
        : undefined;
      if (sealedRecovery) {
        if (estimated <= sealedRecovery.length) {
          result.notWorthCompressing += 1;
          return true;
        }
        result.estimatedRecoveryBytes += sealedRecovery.length;
      }
      result.gzipCount += 1;
      result.estimatedSavedBytes += estimated;
      if (!apply) return true;

      if (Date.now() >= mutationDeadline) throw new Error("apply_budget_reserved_for_recovery");
      await persistRecoveryOriginal(options.recoveryDir ?? resolve(".r2-recompression-backups", new Date().toISOString().replace(/[:.]/g, "-")), bucket, candidate.key, original);
      if (Date.now() >= mutationDeadline) throw new Error("apply_budget_reserved_for_recovery");
      const backupKey = `${durableRecoveryPrefix}${createHash("sha256").update(`${bucket}\0${candidate.key}\0${original.etag}\0${randomUUID()}`).digest("hex")}.enc`;
      result.durableBackupKeys.push(backupKey);
      // Count before the request: a lost response may still have stored this immutable object.
      result.recoveryBytes += sealedRecovery!.length;
      try {
        const backupPut = await sendBounded<{ ETag?: string }>(s3, new PutObjectCommand({
          Bucket: bucket,
          Key: backupKey,
          Body: sealedRecovery!,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
        }), mutationDeadline, requestTimeoutMs);
        if (!backupPut.ETag) throw new Error("missing_etag");
        const backupRead = await readObject(s3, bucket, backupKey, mutationDeadline, requestTimeoutMs,
          Math.min(200 * 1024 * 1024, maxObjectBytes * 2 + 64 * 1024), backupPut.ETag);
        if (backupRead.etag !== backupPut.ETag || !backupRead.bytes.equals(sealedRecovery!)) {
          throw new Error("recovery_backup_verify_failed");
        }
      } catch (error) {
        result.failed.push({ key: candidate.key, code: `recovery_backup_${safeErrorCode(error)}` });
        return false;
      }
      if (Date.now() >= mutationDeadline) throw new Error("apply_budget_reserved_for_recovery");
      let replacementEtag: string | undefined;
      try {
        const putResult = await sendBounded<{ ETag?: string }>(s3, new PutObjectCommand({
          Bucket: bucket,
          Key: candidate.key,
          Body: compressed,
          ...putHeaders(original.headers, true),
          IfMatch: original.etag,
        }), mutationDeadline, requestTimeoutMs);
        replacementEtag = putResult.ETag;
        if (!replacementEtag) {
          result.ambiguous += 1;
          result.failed.push({ key: candidate.key, code: "put_missing_etag_ambiguous_backup_preserved" });
          return false;
        }
      } catch (error) {
        if (safeErrorCode(error) === "precondition_failed") {
          result.conflicts += 1;
          return true;
        }
        result.ambiguous += 1;
        result.failed.push({ key: candidate.key, code: `put_ambiguous_${safeErrorCode(error)}_backup_preserved` });
        return false;
      }

      try {
        const verified = await readObject(s3, bucket, candidate.key, mutationDeadline, requestTimeoutMs, maxObjectBytes, replacementEtag);
        if (!verified.etag || verified.etag !== replacementEtag) throw new Error("verify_etag_mismatch");
        const restoredBytes = verified.bytes[0] === 0x1f && verified.bytes[1] === 0x8b
          ? gunzipSync(verified.bytes, { maxOutputLength: maxObjectBytes })
          : verified.bytes;
        if (!restoredBytes.equals(original.bytes)) throw new Error("verify_bytes_mismatch");
      } catch (error) {
        try {
          await sendBounded(s3, new PutObjectCommand({
            Bucket: bucket,
            Key: candidate.key,
            Body: original.bytes,
            ...putHeaders(original.headers, false),
            IfMatch: replacementEtag,
          }), deadline, requestTimeoutMs);
          result.failed.push({ key: candidate.key, code: `verify_failed_rollback_attempted_${safeErrorCode(error)}` });
        } catch (rollbackError) {
          if (safeErrorCode(rollbackError) === "precondition_failed") result.conflicts += 1;
          result.failed.push({ key: candidate.key, code: `verify_failed_rollback_not_applied_${safeErrorCode(rollbackError)}` });
        }
        return false;
      }
      result.processed += 1;
      result.savedBytes += estimated;
      return true;
    } catch (error) {
      result.failed.push({ key: candidate.key, code: safeErrorCode(error) });
      return false;
    }
  };

  const outcomes = Array.from({ length: selected.length }, () => false);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < selected.length) {
      const index = nextIndex++;
      outcomes[index] = await processOne(selected[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));

  let cursorKey: string | undefined;
  if (options.inventoryOnly) {
    cursorKey = selectedInventory.at(-1)?.key ?? (moreListed ? lastListedKey : undefined);
  } else {
    for (let index = 0; index < outcomes.length; index += 1) {
      if (!outcomes[index]) break;
      cursorKey = selected[index].key;
    }
    if (outcomes.every(Boolean) && !entries.length) cursorKey = startAfter;
    if (outcomes.every(Boolean) && entries.length <= limit && moreListed) cursorKey = lastListedKey ?? cursorKey;
  }
  if (result.failed.length > 0) result.truncated = true;
  result.netSavedBytes = apply
    ? result.savedBytes - result.recoveryBytes
    : result.estimatedSavedBytes - result.estimatedRecoveryBytes;
  if (result.truncated) {
    cursorKey ??= startAfter;
    if (cursorKey) result.nextCursor = encodeCursor({ version: 1, prefix, startAfter: cursorKey });
  }

  write(`목록: ${result.scannedObjects}개 / ${result.pages}페이지 / ${result.prefixBytes} bytes${result.truncated ? " (일부 페이지)" : " (완료)"}`);
  write(`JSON ${result.jsonObjects}개, 실제 읽기 ${result.objectsRead}개, gzip 대상 ${result.gzipCount}개, 예상 절감 ${result.estimatedSavedBytes} bytes`);
  if (result.alreadyCompressed) write(`이미 gzip: ${result.alreadyCompressed}개`);
  if (result.notWorthCompressing) write(`압축 이득 없음: ${result.notWorthCompressing}개`);
  if (result.processed) write(`교체 검증 완료 ${result.processed}개 / 절감 ${result.savedBytes} bytes`);
  if (durableRecoveryPrefix) write(`복구 백업 ${result.durableBackupKeys.length}개 / ${apply ? result.recoveryBytes : result.estimatedRecoveryBytes} bytes / 순절감 ${result.netSavedBytes} bytes`);
  if (result.conflicts) write(`동시 변경 충돌: ${result.conflicts}개`);
  if (result.ambiguous) write(`결과 불명확(원본 백업 보존): ${result.ambiguous}개`);
  if (result.failed.length) write(`실패 ${result.failed.length}개 (오류 상세나 URL은 출력하지 않음)`);
  if (result.nextCursor) write(`다음 cursor: ${result.nextCursor}`);
  if (!apply) write("dry-run: 선택된 JSON을 읽어 실제 gzip 예상 절감량을 계산했습니다. 객체는 변경하지 않았습니다.");
  return result;
}

type CliArgs = NonNullable<Parameters<typeof runR2Recompression>[0]>;

export function parseRecompressionArgs(args: string[]): CliArgs {
  const values = new Map<string, string>();
  let apply = false;
  let dryRun = false;
  let inventoryOnly = false;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const [rawName, inlineValue] = args[i].split("=", 2);
    if (!rawName.startsWith("--")) throw new Error("invalid-argument:unexpected-value");
    const name = rawName.slice(2);
    if (["apply", "dry-run", "inventory-only", "json"].includes(name)) {
      if (inlineValue !== undefined) throw new Error(`invalid-argument:${name}`);
      if (name === "apply") apply = true;
      else if (name === "dry-run") dryRun = true;
      else if (name === "inventory-only") inventoryOnly = true;
      else json = true;
      continue;
    }
    const value = inlineValue ?? args[++i];
    if (!value || value.startsWith("--") || values.has(name)) throw new Error(`invalid-argument:${name}`);
    if (!["prefix", "limit", "max-objects", "maxObjects", "max-pages", "maxPages", "page-size", "pageSize", "max-duration-ms", "maxDurationMs", "concurrency", "max-object-bytes", "maxObjectBytes", "cursor", "start-after", "recovery-dir", "durable-recovery-prefix"].includes(name)) {
      throw new Error(`invalid-argument:${name}`);
    }
    values.set(name, value);
  }
  if (apply && dryRun) throw new Error("invalid-argument:apply-dry-run-conflict");
  const numeric = (names: string[], max: number) => {
    const present = names.filter((name) => values.has(name));
    if (present.length > 1) throw new Error(`invalid-argument:${names[0]}`);
    const value = present.length ? values.get(present[0]) : undefined;
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`invalid-argument:${names[0]}`);
    return positiveInt(Number(value), names[0], 1, max);
  };
  const recoveryDir = values.get("recovery-dir");
  if (recoveryDir && !isAbsolute(recoveryDir)) throw new Error("invalid-argument:recovery-dir-must-be-absolute");
  return {
    apply, prefix: values.get("prefix"),
    limit: numeric(["limit", "max-objects", "maxObjects"], MAX_OBJECTS),
    maxPages: numeric(["max-pages", "maxPages"], MAX_PAGES),
    pageSize: numeric(["page-size", "pageSize"], MAX_PAGE_SIZE),
    maxDurationMs: numeric(["max-duration-ms", "maxDurationMs"], MAX_DURATION_MS),
    concurrency: numeric(["concurrency"], MAX_CONCURRENCY),
    maxObjectBytes: numeric(["max-object-bytes", "maxObjectBytes"], MAX_OBJECT_BYTES),
    cursor: values.get("cursor"), startAfter: values.get("start-after"), inventoryOnly, json, recoveryDir,
    durableRecoveryPrefix: values.get("durable-recovery-prefix"),
  };
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  loadDotenv({ path: resolve(process.cwd(), ".env.local"), quiet: true, override: false });
  const wantsJson = process.argv.slice(2).includes("--json");
  try {
    const args = parseRecompressionArgs(process.argv.slice(2));
    runR2Recompression(args).then((result) => {
      if (args.json) console.log(JSON.stringify(result));
      if (result.failed.length > 0) process.exitCode = 1;
    }).catch((error: unknown) => {
      const code = safeErrorCode(error);
      if (args.json) {
        console.log(JSON.stringify({
          scannedObjects: 0, scannedBytes: 0, prefixBytes: 0, pages: 0, groups: [], truncated: false, nextCursor: null,
          savedBytes: 0, estimatedSavedBytes: 0, failed: [{ code }],
        }));
      } else console.error(`R2 재압축 실패: ${code}`);
      process.exitCode = 1;
    });
  } catch (error) {
    const code = safeErrorCode(error);
    if (wantsJson) {
      console.log(JSON.stringify({
        scannedObjects: 0, scannedBytes: 0, prefixBytes: 0, pages: 0, groups: [], truncated: false, nextCursor: null,
        savedBytes: 0, estimatedSavedBytes: 0, failed: [{ code }],
      }));
    } else console.error(`R2 재압축 실패: ${code}`);
    process.exitCode = 2;
  }
}
