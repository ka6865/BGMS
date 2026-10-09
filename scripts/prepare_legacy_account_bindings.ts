import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseLegacyCopyTargets, LEGACY_COPY_KEY } from "../lib/pubg-analysis/liveLegacyCopyProof";
import { proveLegacyAccountBinding, buildLegacyAccountBindingSql, type LegacyAccountBinding } from "../lib/pubg-analysis/legacyAccountBinding";
import { sealRecoveryBytes, openRecoveryBytes } from "./r2_recovery_archive";

/** Read-only planner. Executing the prepared SQL is a separate, explicit operator action. */
export async function prepareLegacyAccountBindings(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    targets: { type: "string" }, output: { type: "string" }, pair: { type: "string" }, "durable-backup": { type: "boolean" },
  } });
  if (!values.targets || !values.output) throw new Error("legacy-binding-options-invalid");
  const handle = await open(values.targets, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targets;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32768 || (stat.mode & 0o077)) throw new Error("legacy-binding-private-target-required");
    targets = parseLegacyCopyTargets(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
  if (values.pair !== undefined) {
    const pair = Number(values.pair);
    if (!Number.isInteger(pair) || pair < 1 || pair > targets.length) throw new Error("legacy-binding-pair-invalid");
    targets = [targets[pair - 1]];
  }
  dotenv.config({ path: process.env.BGMS_ENV_FILE || ".env.local", quiet: true });
  if (process.env.BGMS_RECOVERY_ENV_FILE) dotenv.config({ path: process.env.BGMS_RECOVERY_ENV_FILE, quiet: true });
  const secret = process.env.R2_RECOVERY_ARCHIVE_KEY || "";
  if (secret.length < 32 || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("legacy-binding-credentials-missing");
  let readBytes = 0;
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
      const chunks: Buffer[] = [];
      if (!response.body) throw new Error("legacy-binding-read-incomplete");
      const reader = response.body.getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        readBytes += chunk.length;
        if (readBytes > 24 * 1024 * 1024) throw new Error("legacy-binding-read-bound");
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
      return new Response(Buffer.concat(chunks), { status: response.status, headers });
    } },
  });
  const ids = [...new Set(targets.map(target => LEGACY_COPY_KEY.exec(target.originalKeys[0])![1]))];
  const results = await Promise.all([
    db.from("pubg_player_matches").select("*").in("match_id", ids).limit(201),
    db.from("processed_match_telemetry").select("*").in("match_id", ids).limit(201),
  ]);
  if (results.some(result => result.error || !result.data || result.data.length >= 201)) throw new Error("legacy-binding-read-incomplete");
  const matches = results[0].data!, processed = results[1].data!;
  const bindings: LegacyAccountBinding[] = [];
  let alreadyLinked = 0;
  for (const target of targets) for (const key of target.originalKeys) {
    const parsed = LEGACY_COPY_KEY.exec(key)!;
    const rows = matches.filter(row => row.match_id === parsed[1] && row.player_id === parsed[2]);
    if (rows.length !== 1) throw new Error("legacy-binding-evidence-conflict");
    const before = rows[0], original = { ...before, account_id: null };
    const proof = proveLegacyAccountBinding(original, processed, [...matches.filter(row => row !== before), original]);
    bindings.push(proof);
  }
  // Existing bindings are validated against the same cached evidence; never overwritten.
  const pending = bindings.filter(binding => {
    const current = matches.find(row => row.match_id === binding.before.match_id && row.platform === binding.before.platform
      && row.player_id === binding.before.player_id)!;
    if (current.account_id === null) return true;
    if (current.account_id !== binding.accountId) throw new Error("legacy-binding-existing-account-conflict");
    alreadyLinked++; return false;
  });
  const journal = gzipSync(Buffer.from(JSON.stringify({ format: 1, measuredAt: new Date().toISOString(), bindings: pending })), { level: 9 });
  const encrypted = sealRecoveryBytes(journal, secret);
  if (encrypted.length > 4 * 1024 * 1024) throw new Error("legacy-binding-backup-bound");
  const backup = await open(values.output + ".enc", "wx", 0o600);
  try { await backup.writeFile(encrypted); await backup.sync(); } finally { await backup.close(); }
  if (!openRecoveryBytes(await readFile(values.output + ".enc"), secret).equals(journal)) throw new Error("legacy-binding-backup-conflict");
  let durableBackupReadback = false;
  if (values["durable-backup"] && pending.length) {
    const clean = (value: string | undefined) => (value || "").replace(/[\s'";]+/g, "");
    const endpoint = clean(process.env.CLOUDFLARE_R2_ENDPOINT), accessKeyId = clean(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID);
    const secretAccessKey = clean(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);
    if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("legacy-binding-r2-credentials-missing");
    const client = new S3Client({ region: "auto", endpoint, forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, socketTimeout: 10000 }) });
    try {
      const bucket = clean(process.env.CLOUDFLARE_R2_BUCKET_NAME) || "telemetry";
      const key = `backups/legacy-account-bindings/${createHash("sha256").update(encrypted).digest("hex")}.enc`;
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: encrypted,
        ContentType: "application/octet-stream", IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(20000) });
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(20000) });
      if (!result.Body || result.ContentLength !== encrypted.length || encrypted.length > 4 * 1024 * 1024)
        throw new Error("legacy-binding-durable-backup-conflict");
      if (!Buffer.from(await result.Body.transformToByteArray()).equals(encrypted)) throw new Error("legacy-binding-durable-backup-conflict");
      durableBackupReadback = true;
    } finally { client.destroy(); }
  }
  if (pending.length) {
    const output = await open(values.output, "wx", 0o600);
    try { await output.writeFile(buildLegacyAccountBindingSql(pending)); await output.sync(); } finally { await output.close(); }
  }
  return { dryRun: true, targetPairs: targets.length, verifiedRecords: bindings.length, plannedLinks: pending.length,
    alreadyLinked, databaseWrites: 0, telemetryObjectsChanged: 0,
    durableBackupReadback, protectedBackupObjectsWritten: durableBackupReadback ? 1 : 0, backupBytes: encrypted.length, readBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareLegacyAccountBindings().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ errorCode: error instanceof Error && /^legacy-binding-[a-z-]+$/.test(error.message)
      ? error.message : "legacy-binding-preparation-failed" }));
    process.exitCode = 1;
  });
}
