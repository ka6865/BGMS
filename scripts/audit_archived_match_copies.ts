/** Offline-first R2 copy comparison. Reads only local evidence and never mutates R2 or a database. */
import { open, chmod, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ARCHIVED_COPY_LIMITS,
  compareArchivedMatchCopies,
  validateFreshReadManifestHeader,
  type ArchivedCopyComparisonSummary,
  type FreshArchivedBody,
} from "../lib/pubg-analysis/archivedCopyComparison";

const MAX_SNAPSHOT_BYTES = 96 * 1024 * 1024;
const MAX_PLAN_BYTES = 32 * 1024 * 1024;
const MAX_CLASSIFIED_BYTES = 64 * 1024 * 1024;
const MAX_SAMPLE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_FRESH_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 256 * 1024 * 1024;
const PRIVATE_MASK = 0o077;
const USAGE = "Usage: tsx scripts/audit_archived_match_copies.ts --snapshot PRIVATE.json --plan PRIVATE.json --classified PRIVATE.json [--sample-snapshot PRIVATE.json ...] [--fresh-bytes PRIVATE.json] [--manifest PRIVATE.json]";

type JsonInput = { value: unknown; bytes: number };
type Options = {
  snapshot?: string;
  plan?: string;
  classified?: string;
  sampleSnapshot?: string[];
  freshBytes?: string;
  manifest?: string;
  help?: boolean;
};

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("archived-copy-input-size-bound");
    if (process.platform !== "win32" && (metadata.mode & PRIVATE_MASK) !== 0) {
      throw new Error("archived-copy-input-permission");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readPrivateJson(path: string, maxBytes: number): Promise<JsonInput> {
  let bytes: Buffer;
  try { bytes = await readPrivateFile(path, maxBytes); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("archived-copy-")) throw error;
    throw new Error("archived-copy-input-read-failed");
  }
  try { return { value: JSON.parse(bytes.toString("utf8")) as unknown, bytes: bytes.length }; }
  catch { throw new Error("archived-copy-input-json-invalid"); }
}

function parseOptions(args: string[]): Options {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      snapshot: { type: "string" },
      plan: { type: "string" },
      classified: { type: "string" },
      "sample-snapshot": { type: "string", multiple: true },
      "fresh-bytes": { type: "string" },
      manifest: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  return {
    snapshot: parsed.values.snapshot,
    plan: parsed.values.plan,
    classified: parsed.values.classified,
    sampleSnapshot: parsed.values["sample-snapshot"],
    freshBytes: parsed.values["fresh-bytes"],
    manifest: parsed.values.manifest,
    help: parsed.values.help,
  };
}

function addInputBytes(current: number, next: number): number {
  const total = current + next;
  if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("archived-copy-total-input-bound");
  return total;
}

function isContainedPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readFreshBodies(path: string, now = Date.now()): Promise<{ bodies: FreshArchivedBody[]; inputBytes: number }> {
  const manifestInput = await readPrivateJson(path, MAX_FRESH_MANIFEST_BYTES);
  const header = validateFreshReadManifestHeader(manifestInput.value, now);
  const directory = resolve(dirname(path));
  const bodies: FreshArchivedBody[] = [];
  const seenKeys = new Set<string>();
  const seenPaths = new Set<string>();
  let inputBytes = manifestInput.bytes;
  let bodyBytes = 0;
  for (const row of header.rows) {
    if (isAbsolute(row.file as string)) throw new Error("archived-copy-fresh-file-path-invalid");
    const bodyPath = resolve(directory, row.file as string);
    if (!isContainedPath(directory, bodyPath) || seenKeys.has(row.key as string) || seenPaths.has(bodyPath)) {
      throw new Error("archived-copy-fresh-file-path-invalid");
    }
    seenKeys.add(row.key as string);
    seenPaths.add(bodyPath);
    const bytes = await readPrivateFile(bodyPath, ARCHIVED_COPY_LIMITS.maxFreshBodyBytes);
    if (bytes.length !== row.bytes) throw new Error("archived-copy-fresh-body-size-conflict");
    inputBytes = addInputBytes(inputBytes, bytes.length);
    bodyBytes += bytes.length;
    if (bodyBytes > 128 * 1024 * 1024) throw new Error("archived-copy-fresh-total-size-bound");
    bodies.push({
      key: row.key as string,
      etag: row.etag as string,
      bytes: row.bytes as number,
      body: bytes,
      ...(typeof row.contentEncoding === "string" ? { contentEncoding: row.contentEncoding } : {}),
    });
  }
  return { bodies, inputBytes };
}

async function writePrivateManifest(path: string, value: unknown): Promise<void> {
  let created = false;
  try {
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await chmod(path, 0o600);
  } catch (error) {
    if (created) await unlink(path).catch(() => undefined);
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("archived-copy-manifest-already-exists");
    }
    throw new Error("archived-copy-private-manifest-write-failed");
  }
}

export async function runArchivedMatchCopyAudit(args = process.argv.slice(2)):
Promise<ArchivedCopyComparisonSummary | { help: string }> {
  let options: Options;
  try { options = parseOptions(args); }
  catch { throw new Error("archived-copy-arguments-invalid"); }
  if (options.help) return { help: USAGE };
  if (!options.snapshot || !options.plan || !options.classified) throw new Error("archived-copy-required-input-missing");
  const samples = options.sampleSnapshot ?? [];
  if (samples.length > 8) throw new Error("archived-copy-sample-bound");

  let inputBytes = 0;
  const snapshot = await readPrivateJson(options.snapshot, MAX_SNAPSHOT_BYTES);
  inputBytes = addInputBytes(inputBytes, snapshot.bytes);
  const plan = await readPrivateJson(options.plan, MAX_PLAN_BYTES);
  inputBytes = addInputBytes(inputBytes, plan.bytes);
  const classified = await readPrivateJson(options.classified, MAX_CLASSIFIED_BYTES);
  inputBytes = addInputBytes(inputBytes, classified.bytes);
  const sampleInputs: unknown[] = [];
  for (const samplePath of samples) {
    const sample = await readPrivateJson(samplePath, MAX_SAMPLE_SNAPSHOT_BYTES);
    inputBytes = addInputBytes(inputBytes, sample.bytes);
    sampleInputs.push(sample.value);
  }

  let freshBodies: FreshArchivedBody[] = [];
  if (options.freshBytes) {
    const fresh = await readFreshBodies(options.freshBytes);
    inputBytes = addInputBytes(inputBytes, fresh.inputBytes);
    freshBodies = fresh.bodies;
  }
  const result = compareArchivedMatchCopies({
    snapshot: snapshot.value,
    plan: plan.value,
    classified: classified.value,
    sampleSnapshots: sampleInputs,
    freshBodies,
  });
  if (options.manifest) {
    await writePrivateManifest(options.manifest, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      summary: result.summary,
      pairs: result.privateRows,
    });
  }
  return result.summary;
}

const directRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directRun) {
  runArchivedMatchCopyAudit().then((summary) => {
    if ("help" in summary) console.log(summary.help);
    else console.log(JSON.stringify(summary));
  }).catch((error: unknown) => {
    const code = error instanceof Error && /^archived-copy-[a-z-]+$/.test(error.message)
      ? error.message : "archived-copy-audit-failed";
    console.error(`Read-only archived-copy comparison failed (${code}).`);
    process.exitCode = 1;
  });
}
