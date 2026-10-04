import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  isRecompressTarget,
  parseRecompressionArgs,
  runR2Recompression,
  RECOMPRESS_BATCH_LIMIT,
} from "../scripts/recompress_r2_json";

const env = { CLOUDFLARE_R2_BUCKET_NAME: "test-bucket", R2_RECOVERY_ARCHIVE_KEY: "unit-test-key" };
const durableRecoveryPrefix = "backups/r2-recompression/test/";
const body = (bytes: Buffer) => (async function* () { yield bytes; })();
const commandInput = (command: unknown): Record<string, unknown> => (command as { input: Record<string, unknown> }).input;

type StoredObject = { bytes: Buffer; etag: string; headers: Record<string, unknown> };

function fakeS3(initial: Record<string, StoredObject>, hooks: {
  beforePut?: (key: string, input: Record<string, unknown>) => void;
  afterGet?: (key: string, count: number) => void;
  failPutAfterWrite?: boolean;
  omitPutEtag?: boolean;
  raceBeforePutKey?: string;
  concurrentOnSecondGetKey?: string;
  corruptOnSecondGetKey?: string;
  failBackupPut?: boolean;
  omitBackupEtag?: boolean;
} = {}) {
  const objects = new Map(Object.entries(initial));
  const putInputs: Record<string, unknown>[] = [];
  const getCounts = new Map<string, number>();
  const requests: unknown[] = [];
  const client = {
    async send(command: unknown): Promise<unknown> {
      requests.push(command);
      if (command instanceof ListObjectsV2Command) {
        const input = commandInput(command);
        const entries = [...objects.entries()]
          .filter(([key]) => (!input.Prefix || key.startsWith(String(input.Prefix))) && (!input.StartAfter || key > String(input.StartAfter)))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([Key, value]) => ({ Key, Size: value.bytes.length }));
        if (input.ContinuationToken) return { Contents: [], IsTruncated: false };
        return { Contents: entries.slice(0, Number(input.MaxKeys ?? 1000)), IsTruncated: false };
      }
      if (command instanceof GetObjectCommand) {
        const input = commandInput(command);
        const key = String(input.Key);
        let current = objects.get(key);
        if (!current) throw Object.assign(new Error("not found"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        if (input.IfMatch && input.IfMatch !== current.etag) {
          throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        }
        const count = (getCounts.get(key) ?? 0) + 1;
        getCounts.set(key, count);
        hooks.afterGet?.(key, count);
        if (key === hooks.concurrentOnSecondGetKey && count === 2) {
          objects.set(key, { bytes: Buffer.from("new concurrent value"), etag: '"another-writer"', headers: {} });
          current = objects.get(key)!;
        }
        if (!current) throw new Error("missing mock object");
        if (key === hooks.corruptOnSecondGetKey && count === 2) current.bytes = Buffer.from("corrupt");
        return { Body: body(current.bytes), ETag: current.etag, ...current.headers };
      }
      if (command instanceof PutObjectCommand) {
        const input = commandInput(command);
        const key = String(input.Key);
        putInputs.push(input);
        hooks.beforePut?.(key, input);
        if (input.IfNoneMatch === "*") {
          if (objects.has(key)) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          if (hooks.failBackupPut) throw Object.assign(new Error("backup timeout"), { name: "TimeoutError" });
          const backup = { bytes: Buffer.from(input.Body as Uint8Array), etag: `"backup-${putInputs.length}"`, headers: {} };
          objects.set(key, backup);
          return hooks.omitBackupEtag ? {} : { ETag: backup.etag };
        }
        if (key === hooks.raceBeforePutKey) {
          objects.set(key, { bytes: Buffer.from('{"newer":true}'), etag: '"concurrent-etag"', headers: { ContentType: "application/json" } });
        }
        const current = objects.get(key);
        if (!current || input.IfMatch !== current.etag) {
          throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        }
        const next = {
          bytes: Buffer.from(input.Body as Uint8Array),
          etag: `"etag-${putInputs.length}"`,
          headers: Object.fromEntries(Object.entries(input).filter(([name]) => [
            "ContentType", "ContentEncoding", "CacheControl", "ContentDisposition", "ContentLanguage", "Expires", "WebsiteRedirectLocation", "StorageClass", "Metadata",
          ].includes(name))),
        };
        objects.set(key, next);
        if (hooks.failPutAfterWrite) throw Object.assign(new Error("socket disconnected"), { name: "TimeoutError" });
        return hooks.omitPutEtag ? {} : { ETag: next.etag };
      }
      throw new Error("unexpected command");
    },
  };
  return { client, objects, putInputs, getCounts, requests };
}

function jsonObject(text: string, headers: Record<string, unknown> = {}): StoredObject {
  return { bytes: Buffer.from(text), etag: '"original-etag"', headers: { ContentType: "application/json", ...headers } };
}

describe("R2 recompression target and CLI bounds", () => {
  it("keeps protected assets and non-JSON keys out", () => {
    expect(isRecompressTarget("crates/11010112.webp")).toBe(false);
    expect(isRecompressTarget("telemetry-inventory/2026-07-31.json")).toBe(false);
    expect(isRecompressTarget("telemetry-map/v60/steam/match/hash/lite.json")).toBe(true);
  });

  it("rejects malformed or unbounded CLI values", async () => {
    expect(() => parseRecompressionArgs(["--max-pages=0"])).toThrow("invalid-argument:max-pages");
    expect(() => parseRecompressionArgs(["--unknown=x"])).toThrow("invalid-argument:unknown");
    expect(() => parseRecompressionArgs(["--limit=10", "--max-objects=20"])).toThrow("invalid-argument:limit");
    expect(() => parseRecompressionArgs(["--apply", "--dry-run"])).toThrow("apply-dry-run-conflict");
    expect(() => parseRecompressionArgs(["--recovery-dir=relative/path"])).toThrow("recovery-dir-must-be-absolute");
    expect(parseRecompressionArgs([
      "--inventory-only", "--json", "--prefix=cache/", "--limit=5000", "--max-pages=10",
      "--page-size=500", "--max-duration-ms=30000", "--recovery-dir=/tmp/r2-recovery", "--cursor=YQ",
    ])).toMatchObject({
      inventoryOnly: true, json: true, prefix: "cache/", limit: 5000, maxPages: 10, pageSize: 500,
      maxDurationMs: 30000, recoveryDir: "/tmp/r2-recovery", cursor: "YQ",
    });
    expect(parseRecompressionArgs([`--durable-recovery-prefix=${durableRecoveryPrefix}`]).durableRecoveryPrefix).toBe(durableRecoveryPrefix);
    await expect(runR2Recompression({ env, client: fakeS3({}).client, durableRecoveryPrefix: "cache/" })).rejects.toThrow("invalid-argument:durable-recovery-prefix");
    await expect(runR2Recompression({ env, client: fakeS3({}).client, apply: true })).rejects.toThrow("durable-recovery-prefix-required");
    await expect(runR2Recompression({ env: { CLOUDFLARE_R2_BUCKET_NAME: "test-bucket" }, client: fakeS3({}).client, apply: true, durableRecoveryPrefix })).rejects.toThrow("r2-recovery-secret-missing");
  });

  it("uses safe default limits", () => {
    expect(RECOMPRESS_BATCH_LIMIT).toBe(20);
  });
});

describe("bounded listing and measured dry-run", () => {
  it("stops at the page bound and returns an opaque continuation cursor", async () => {
    let listCalls = 0;
    const client = {
      async send(command: unknown) {
        if (command instanceof GetObjectCommand) return { Body: body(Buffer.from('{"a":"value"}')), ETag: '"one"' };
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        listCalls += 1;
        return {
          Contents: [{ Key: "cache/one.json", Size: 20 }, { Key: "cache/two.json", Size: 30 }],
          IsTruncated: true,
          NextContinuationToken: "opaque-page-token",
        };
      },
    };
    const result = await runR2Recompression({
      env, client, prefix: "cache/", maxPages: 1, pageSize: 2, limit: 1,
      write: () => undefined,
    });
    expect(listCalls).toBe(1);
    expect(result.scannedObjects).toBe(2);
    expect(result.prefixBytes).toBe(50);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBeTruthy();
    const cursor = JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString());
    expect(cursor).toEqual({ version: 1, prefix: "cache/", startAfter: "cache/one.json" });
    expect(result.nextCursor!.length).toBeLessThan(8_000);
    let resumedInput: Record<string, unknown> | undefined;
    await runR2Recompression({
      env, prefix: "cache/", cursor: result.nextCursor ?? undefined, maxPages: 1, write: () => undefined,
      client: { async send(command: unknown) {
        resumedInput = commandInput(command);
        return { Contents: [], IsTruncated: false };
      } },
    });
    expect(resumedInput?.StartAfter).toBe("cache/one.json");
  });

  it("reads a bounded sample, measures real gzip savings, and skips existing gzip", async () => {
    const large = JSON.stringify({ rows: Array.from({ length: 200 }, (_, index) => ({ index, value: "repeat-value".repeat(8) })) });
    const alreadyGzipped = gzipSync(Buffer.from(large));
    const s3 = fakeS3({
      "cache/large.json": jsonObject(large),
      "cache/gzip.json": { bytes: alreadyGzipped, etag: '"gzip-etag"', headers: { ContentType: "application/json", ContentEncoding: "gzip" } },
      "cache/image.webp": jsonObject(large),
    });
    const result = await runR2Recompression({ env, client: s3.client, prefix: "cache/", maxPages: 1, limit: 2, write: () => undefined });
    expect(result.objectsRead).toBe(2);
    expect(result.gzipCount).toBe(1);
    expect(result.alreadyCompressed).toBe(1);
    expect(result.estimatedSavedBytes).toBeGreaterThan(0);
    expect(result.processed).toBe(0);
    expect(s3.putInputs).toHaveLength(0);
  });

  it("estimates encrypted recovery overhead in dry-run without remote writes", async () => {
    const large = JSON.stringify({ rows: Array.from({ length: 100 }, (_, index) => ({ index, value: "repeat".repeat(20) })) });
    const s3 = fakeS3({ "cache/large.json": jsonObject(large) });
    const result = await runR2Recompression({ env, client: s3.client, prefix: "cache/", durableRecoveryPrefix, write: () => undefined });
    expect(result.estimatedRecoveryBytes).toBeGreaterThan(36);
    expect(result.netSavedBytes).toBe(result.estimatedSavedBytes - result.estimatedRecoveryBytes);
    expect(s3.putInputs).toHaveLength(0);
  });

  it("advances past an already-gzipped sample so later plain JSON is reachable", async () => {
    const plain = JSON.stringify({ data: "compress-me".repeat(500) });
    const s3 = fakeS3({
      "cache/01-gzip.json": { bytes: gzipSync(Buffer.from(plain)), etag: '"gzip"', headers: { ContentEncoding: "gzip" } },
      "cache/02-plain.json": jsonObject(plain),
    });
    const first = await runR2Recompression({ env, client: s3.client, prefix: "cache/", limit: 1, write: () => undefined });
    expect(first.alreadyCompressed).toBe(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await runR2Recompression({
      env, client: s3.client, prefix: "cache/", cursor: first.nextCursor ?? undefined, limit: 1, write: () => undefined,
    });
    expect(second.gzipCount).toBe(1);
    expect(second.estimatedSavedBytes).toBeGreaterThan(0);
  });

  it("reports zero planned savings when the recovery copy outweighs compression", async () => {
    const original = jsonObject(JSON.stringify({ data: "small".repeat(10) }));
    const s3 = fakeS3({ "cache/tiny.json": original });
    const result = await runR2Recompression({ env, client: s3.client, prefix: "cache/", durableRecoveryPrefix, write: () => undefined });
    expect(result).toMatchObject({ notWorthCompressing: 1, estimatedSavedBytes: 0, estimatedRecoveryBytes: 0, netSavedBytes: 0 });
    expect(s3.putInputs).toHaveLength(0);
    expect(s3.objects.get("cache/tiny.json")?.bytes).toEqual(original.bytes);
  });

  it("keeps the checkpoint before the first failed key so the next run retries it", async () => {
    const large = JSON.stringify({ data: "keep".repeat(400) });
    const s3 = fakeS3({
      "cache/01-good.json": jsonObject(large),
      "cache/02-invalid.json": jsonObject("not-json"),
    });
    const first = await runR2Recompression({ env, client: s3.client, prefix: "cache/", limit: 2, write: () => undefined });
    expect(first.failed).toEqual([{ key: "cache/02-invalid.json", code: "invalid_json" }]);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()).startAfter).toBe("cache/01-good.json");
    const retry = await runR2Recompression({
      env, client: s3.client, prefix: "cache/", cursor: first.nextCursor ?? undefined, limit: 1, write: () => undefined,
    });
    expect(retry.failed[0]?.key).toBe("cache/02-invalid.json");
  });

  it("inventory-only reports list metadata and performs no GET", async () => {
    const s3 = fakeS3({
      "cache/one.json": jsonObject('{"small":1}'),
      "cache/image.webp": jsonObject("image bytes"),
    });
    const result = await runR2Recompression({
      env, client: s3.client, prefix: "cache/", inventoryOnly: true, limit: 2, json: true,
      write: () => undefined,
    });
    expect(result.inventory).toHaveLength(2);
    expect(result.inventory?.map((item) => item.key)).toEqual(["cache/image.webp", "cache/one.json"]);
    expect(result.objectsRead).toBe(0);
    expect(s3.requests.some((command) => command instanceof GetObjectCommand)).toBe(false);
    expect(result.groups).toEqual([{ group: "cache", objects: 2, bytes: 22, jsonObjects: 1 }]);
  });
});

describe("conditional replacement and recovery", () => {
  it("leaves the source unchanged when durable backup creation fails", async () => {
    const source = jsonObject(JSON.stringify({ data: "recovery-first".repeat(200) }));
    const s3 = fakeS3({ "cache/backup-failure.json": source }, { failBackupPut: true });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.failed[0].code).toContain("recovery_backup_timeout");
      expect(s3.putInputs.filter((input) => input.IfMatch)).toHaveLength(0);
      expect(s3.objects.get("cache/backup-failure.json")?.bytes).toEqual(source.bytes);
      expect(result.recoveryBytes).toBeGreaterThan(0);
      expect(result.netSavedBytes).toBe(-result.recoveryBytes);
      expect(result.nextCursor).toBeNull();
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("requires a backup ETag and never replaces source when it is absent", async () => {
    const original = jsonObject(JSON.stringify({ data: "durable".repeat(200) }));
    const s3 = fakeS3({ "cache/no-backup-etag.json": original }, { omitBackupEtag: true });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.failed[0].code).toContain("recovery_backup_missing_etag");
      expect(s3.putInputs.filter((input) => input.IfMatch)).toHaveLength(0);
      expect(s3.objects.get("cache/no-backup-etag.json")?.bytes).toEqual(original.bytes);
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("saves metadata, conditionally replaces, and verifies exact round-trip bytes", async () => {
    const originalText = JSON.stringify({ data: "telemetry".repeat(200) });
    const s3 = fakeS3({ "cache/match.json": jsonObject(originalText, {
      CacheControl: "public,max-age=60",
      ContentDisposition: "inline; filename=match.json",
      Metadata: { source: "worker", revision: "v2" },
    }) });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, prefix: "cache/", recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.processed).toBe(1);
      expect(result.savedBytes).toBeGreaterThan(0);
      expect(result.durableBackupKeys).toHaveLength(1);
      expect(result.recoveryBytes).toBeGreaterThan(36);
      expect(result.netSavedBytes).toBe(result.savedBytes - result.recoveryBytes);
      const backupPutIndex = s3.putInputs.findIndex((input) => input.IfNoneMatch === "*");
      const sourcePutIndex = s3.putInputs.findIndex((input) => input.IfMatch === '"original-etag"');
      expect(backupPutIndex).toBeGreaterThanOrEqual(0);
      expect(sourcePutIndex).toBeGreaterThan(backupPutIndex);
      expect(s3.putInputs[backupPutIndex].IfNoneMatch).toBe("*");
      expect(s3.putInputs[sourcePutIndex].ContentEncoding).toBe("gzip");
      expect(s3.putInputs[sourcePutIndex].CacheControl).toBe("public,max-age=60");
      expect(s3.putInputs[sourcePutIndex].ContentDisposition).toBe("inline; filename=match.json");
      expect(s3.putInputs[sourcePutIndex].Metadata).toEqual({ source: "worker", revision: "v2" });
      const backup = s3.objects.get(result.durableBackupKeys[0]);
      expect(backup?.bytes.subarray(0, 8).toString()).toBe("BGMSR2v1");
      expect(s3.requests.some((request) => request instanceof GetObjectCommand
        && commandInput(request).Key === result.durableBackupKeys[0]
        && commandInput(request).IfMatch === backup?.etag)).toBe(true);
      expect(gunzipSync(s3.objects.get("cache/match.json")!.bytes)).toEqual(Buffer.from(originalText));
      expect(s3.getCounts.get("cache/match.json")).toBe(2);
      const manifest = await readFile(join(recoveryDir, "manifest.jsonl"), "utf8");
      const entry = JSON.parse(manifest.trim());
      expect(entry.etag).toBe('"original-etag"');
      expect(await readFile(entry.originalPath, "utf8")).toBe(originalText);
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("skips an ETag conflict and does not overwrite the concurrent version", async () => {
    const large = JSON.stringify({ rows: "repeated".repeat(400) });
    const s3 = fakeS3({ "cache/race.json": jsonObject(large) }, { raceBeforePutKey: "cache/race.json" });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.conflicts, JSON.stringify(result)).toBe(1);
      expect(result.processed).toBe(0);
      expect(s3.objects.get("cache/race.json")?.etag).toBe('"concurrent-etag"');
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("conditionally restores a failed verification and preserves original headers", async () => {
    const originalText = JSON.stringify({ data: "x".repeat(5000) });
    const s3 = fakeS3({ "cache/verify.json": jsonObject(originalText, { CacheControl: "no-cache", Metadata: { owner: "test" } }) }, {
      corruptOnSecondGetKey: "cache/verify.json",
    });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.processed).toBe(0);
      const sourcePuts = s3.putInputs.filter((input) => input.IfMatch);
      expect(sourcePuts).toHaveLength(2);
      expect(sourcePuts[1].IfMatch).toBe('"etag-2"');
      expect(sourcePuts[1].CacheControl).toBe("no-cache");
      expect(sourcePuts[1].Metadata).toEqual({ owner: "test" });
      expect(s3.objects.get("cache/verify.json")?.bytes).toEqual(Buffer.from(originalText));
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("does not roll back over a concurrent update after verification fails", async () => {
    const originalText = JSON.stringify({ data: "x".repeat(5000) });
    const s3 = fakeS3({ "cache/rollback-race.json": jsonObject(originalText) }, { concurrentOnSecondGetKey: "cache/rollback-race.json" });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.conflicts, JSON.stringify(result)).toBe(1);
      expect(s3.objects.get("cache/rollback-race.json")?.etag).toBe('"another-writer"');
      expect(s3.putInputs.filter((input) => input.IfMatch)[1].IfMatch).toBe('"etag-2"');
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });
});

describe("failure containment", () => {
  it("fails closed for missing ETag and keeps bad JSON untouched", async () => {
    const client = {
      async send(command: unknown) {
        if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: "cache/no-etag.json", Size: 3 }, { Key: "cache/bad.json", Size: 2 }] };
        if (command instanceof GetObjectCommand) {
          const key = String(commandInput(command).Key);
          return { Body: body(Buffer.from(key.includes("bad") ? "{}broken" : "{}")), ...(key.includes("bad") ? { ETag: '"bad-etag"' } : {}) };
        }
        throw new Error("unexpected put");
      },
    };
    const result = await runR2Recompression({ env, client, prefix: "cache/", write: () => undefined });
    expect(result.failed.map(({ code }) => code)).toContain("missing_etag");
    expect(result.failed.map(({ code }) => code)).toContain("invalid_json");
  });

  it("records an ambiguous PUT while preserving the recovery manifest and makes no rollback", async () => {
    const originalText = JSON.stringify({ data: "safe".repeat(500) });
    const s3 = fakeS3({ "cache/ambiguous.json": jsonObject(originalText) }, { failPutAfterWrite: true });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.ambiguous).toBe(1);
      expect(result.failed[0].code).toContain("backup_preserved");
      expect(s3.putInputs.filter((input) => input.IfMatch)).toHaveLength(1);
      expect(await readFile(join(recoveryDir, "manifest.jsonl"), "utf8")).toContain("ambiguous.json");
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("treats a successful PUT without ETag as ambiguous and preserves its backup", async () => {
    const originalText = JSON.stringify({ data: "backup".repeat(500) });
    const s3 = fakeS3({ "cache/no-put-etag.json": jsonObject(originalText) }, { omitPutEtag: true });
    const recoveryDir = await mkdtemp(join(tmpdir(), "r2-recompress-test-"));
    try {
      const result = await runR2Recompression({ env, client: s3.client, apply: true, recoveryDir, durableRecoveryPrefix, write: () => undefined });
      expect(result.ambiguous).toBe(1);
      expect(s3.putInputs.filter((input) => input.IfMatch)).toHaveLength(1);
      expect(await readFile(join(recoveryDir, "manifest.jsonl"), "utf8")).toContain("no-put-etag.json");
    } finally {
      await rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it("enforces the overall timeout and keeps SDK error URLs out of reports", async () => {
    const client = {
      send(_command: unknown, options?: { abortSignal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("https://private.invalid/path?token=secret"), { name: "AbortError" })), { once: true });
        });
      },
    };
    const write: string[] = [];
    await expect(runR2Recompression({ env, client, maxDurationMs: 20, requestTimeoutMs: 10, write: (line) => write.push(line) })).rejects.toThrow("timeout");
    expect(write.join(" ")).not.toContain("private.invalid");
    expect(write.join(" ")).not.toContain("secret");
  });

  it("bounds streaming body reads and aborts the response stream", async () => {
    let streamDestroyed = false;
    const client = {
      async send(command: unknown) {
        if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: "cache/hung.json", Size: 10 }] };
        if (command instanceof GetObjectCommand) {
          let rejectNext: ((error: Error) => void) | undefined;
          const stream = {
            [Symbol.asyncIterator]() { return this; },
            next: () => new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => { rejectNext = reject; }),
            destroy: (error?: Error) => { streamDestroyed = true; rejectNext?.(error ?? new Error("destroyed")); },
          };
          return { Body: stream, ETag: '"etag"' };
        }
        throw new Error("unexpected command");
      },
    };
    const result = await runR2Recompression({ env, client, requestTimeoutMs: 20, maxDurationMs: 100, write: () => undefined });
    expect(result.failed.map(({ code }) => code)).toContain("timeout");
    expect(streamDestroyed).toBe(true);
  });
});
