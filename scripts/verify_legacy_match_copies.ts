import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseArgs } from "node:util";
import { bodySha256, decodeLegacyCopy, LEGACY_COPY_KEY, parseLegacyCopyTargets, proveLegacyCopy, type LegacyCopyTarget } from "../lib/pubg-analysis/liveLegacyCopyProof";
import { buildSharedTelemetrySourceKey, parseSharedTelemetrySource } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { readLegacyCopyRecords, sealLegacyCopyManifest, type LegacyCopyManifest } from "../lib/pubg-analysis/legacyCopyManifest";
import { filterTelemetryEvents } from "../lib/pubg-analysis/telemetryContract";
import { parseTelemetryPayload } from "../lib/pubg-analysis/telemetryPayload";
import { buildTelemetryPlayerKey } from "../lib/pubg-analysis/telemetryCacheKey";
import { TELEMETRY_VERSION } from "../lib/pubg-analysis/constants";
import { inspectDeletionKey } from "../lib/pubg-analysis/r2DeletionGuard";
import { recalculateReplayPayload, assertReplayMatchesRecalculation } from "./verify_archived_match_reads";
import { runRestoreLegacyPlayerMatches, playerMatchRecordMatchesLiveRow } from "./restore_legacy_player_matches";
import { openRecoveryBytes, sealRecoveryBytes } from "./r2_recovery_archive";
import type { PlayerMatchRecord } from "../lib/pubg/playerMatches";

type ObjectRead = { body: Buffer; etag: string; contentEncoding?: string; contentType?: string };
type Proof = { target: LegacyCopyTarget; etags: [string, string]; sha256: string; manifest: LegacyCopyManifest; bytes: number };
const RECORD_FIELDS = "player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible,knocks,survival_time";
const MAX_BYTES = 32 * 1024 * 1024;
const TOTAL_BYTES = 128 * 1024 * 1024;

export async function runLegacyCopyVerification(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    targets: { type: "string" }, output: { type: "string" }, apply: { type: "boolean" },
    "plan-hash": { type: "string" },
  } });
  if (!values.targets || !values.output) throw new Error("live-copy-options-invalid");
  const statHandle = await open(values.targets, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targets: LegacyCopyTarget[];
  try {
    const stat = await statHandle.stat();
    if (!stat.isFile() || stat.size > 32768 || (stat.mode & 0o077) !== 0) throw new Error("live-copy-private-target-invalid");
    targets = parseLegacyCopyTargets(JSON.parse(await statHandle.readFile("utf8")));
  } finally { await statHandle.close(); }
  if (values.apply && targets.length !== 1) throw new Error("live-copy-apply-one-pair-only");
  if (values.apply && !/^[a-f0-9]{64}$/.test(values["plan-hash"] || "")) throw new Error("live-copy-preceding-plan-required");
  dotenv.config({ path: process.env.BGMS_ENV_FILE || ".env.local", quiet: true });
  const secret = process.env.R2_RECOVERY_ARCHIVE_KEY || "";
  if (secret.length < 32) throw new Error("live-copy-recovery-secret-missing");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const clean = (v: string | undefined) => (v || "").replace(/[\s'";]+/g, "");
  if (!url || !key || !clean(process.env.CLOUDFLARE_R2_ENDPOINT) || !clean(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID) || !clean(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY)) throw new Error("live-copy-credentials-missing");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
  } });
  const client = new S3Client({ region: "auto", endpoint: clean(process.env.CLOUDFLARE_R2_ENDPOINT), forcePathStyle: true,
    credentials: { accessKeyId: clean(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID), secretAccessKey: clean(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY) },
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, socketTimeout: 10000 }), maxAttempts: 2 });
  const bucket = clean(process.env.CLOUDFLARE_R2_BUCKET_NAME) || "telemetry";
  // Refuse an existing proof destination before any network side effect.
  const proofOutput = await open(values.output, "wx", 0o600);
  const started = Date.now();
  let bytesRead = 0;
  const bound = () => { if (Date.now() - started > 180000) throw new Error("live-copy-duration-bound"); };
  async function get(objectKey: string): Promise<ObjectRead | null> {
    bound();
    let result;
    try { result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { abortSignal: AbortSignal.timeout(20000) }); }
    catch (error) { if ((error as any).$metadata?.httpStatusCode === 404) return null; throw new Error("live-copy-object-read-failed"); }
    if (!result.Body || !result.ETag || result.ContentLength === undefined || result.ContentLength > MAX_BYTES) throw new Error("live-copy-object-bound");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length; bytesRead += chunk.length;
      if (length > MAX_BYTES || bytesRead > TOTAL_BYTES) throw new Error("live-copy-total-body-bound");
      chunks.push(Buffer.from(chunk));
    }
    if (length !== result.ContentLength) throw new Error("live-copy-object-length-conflict");
    return { body: Buffer.concat(chunks), etag: result.ETag, contentEncoding: result.ContentEncoding, contentType: result.ContentType };
  }
  async function facts(target: LegacyCopyTarget) {
    bound();
    const matchId = LEGACY_COPY_KEY.exec(target.originalKeys[0])![1];
    const results = await Promise.all([
      db.from("pubg_player_matches").select(RECORD_FIELDS).eq("match_id", matchId).limit(101),
      db.from("match_master_telemetry").select("storage_path").eq("match_id", matchId).limit(101),
      db.from("telemetry_map_cache_entries").select("storage_path,status,lease_expires_at").eq("match_id", matchId).limit(101),
      db.from("system_settings").select("value").eq("key", "private_players_list").maybeSingle(),
    ]);
    if (results.some(result => result.error) || results.slice(0, 3).some(result => (result.data as any[])?.length >= 101)) throw new Error("live-copy-db-read-incomplete");
    const records = results[0].data as PlayerMatchRecord[];
    const privatePlayers = results[3].data?.value ? JSON.parse(results[3].data.value) : [];
    if (!Array.isArray(privatePlayers)) throw new Error("live-copy-private-list-invalid");
    if (records.some(record => privatePlayers.some(player => (player.platform === "all" || player.platform === record.platform)
      && (player.account_id === record.account_id || (player.lower_nickname || player.nickname?.toLowerCase()) === record.player_id)))) throw new Error("live-copy-private-player");
    const refs = [...results[1].data as any[], ...results[2].data as any[]];
    return { records, referenced: refs.some(row => target.originalKeys.includes(row.storage_path)
      || target.originalKeys.some(objectKey => row.storage_path === objectKey.replace("_analyze.json", ".json"))),
    activeLease: (results[2].data as any[]).some(row => row.status === "writing" || Date.parse(row.lease_expires_at) > Date.now()) };
  }
  async function verifyReplay(manifest: LegacyCopyManifest, body: Buffer): Promise<void> {
    const sourceObject = await get(buildSharedTelemetrySourceKey(manifest.matchId, manifest.platform));
    const source = sourceObject && parseSharedTelemetrySource(decodeLegacyCopy(sourceObject.body), manifest.matchId, manifest.platform);
    if (!source) throw new Error("live-copy-complete-common-source-missing");
    const rawEvents = decodeLegacyCopy(body);
    if (!Array.isArray(rawEvents)) throw new Error("live-copy-legacy-array-invalid");
    const events = filterTelemetryEvents(rawEvents, { mode: "full", teamNames: new Set(), teamAccountIds: new Set() });
    if (!isDeepStrictEqual(events, source.events)) throw new Error("live-copy-complete-common-events-differ");
    for (const record of manifest.records) {
      const participant = source.matchData.included.find((p: any) => p.type === "participant" && p.attributes.stats.playerId === record.account_id);
      if (!participant || participant.attributes.stats.name.toLowerCase() !== record.player_id) throw new Error("live-copy-official-player-conflict");
      const stats = participant.attributes.stats, attr = source.matchData.data.attributes;
      if (stats.kills !== record.kills || Math.floor(stats.damageDealt) !== record.damage || stats.winPlace !== record.win_place
        || attr.mapName !== record.map_name || attr.gameMode !== record.game_mode || Date.parse(attr.createdAt) !== Date.parse(record.played_at)) throw new Error("live-copy-official-stats-conflict");
      const expected = recalculateReplayPayload({ ...source, events }, record.account_id!);
      const params = new URLSearchParams({ matchId: manifest.matchId, platform: manifest.platform, nickname: record.player_id, mode: "lite" });
      bound();
      const response = await fetch(`https://bgms.kr/api/pubg/telemetry?${params}`, { signal: AbortSignal.timeout(45000), redirect: "error" });
      if (!response.ok) throw new Error("live-copy-replay-api-failed");
      const envelope = await response.json(), signed = new URL(envelope.downloadUrl || envelope.url);
      if (signed.protocol !== "https:" || !signed.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("live-copy-replay-host-invalid");
      const map = await fetch(signed, { signal: AbortSignal.timeout(20000), redirect: "error" });
      if (!map.ok) throw new Error("live-copy-replay-body-failed");
      const payload = parseTelemetryPayload(await map.json(), { matchId: manifest.matchId, platform: manifest.platform,
        playerKey: buildTelemetryPlayerKey(record.account_id!), mode: "lite", telemetryVersion: TELEMETRY_VERSION });
      assertReplayMatchesRecalculation(expected, payload);
      const detail = await fetch(`https://bgms.kr/api/pubg/match?${params}`, { signal: AbortSignal.timeout(45000), redirect: "error" });
      if (!detail.ok) throw new Error("live-copy-detail-api-failed");
      const result = await detail.json();
      if ((result.matchId ?? result.match_id) !== manifest.matchId || result.stats?.name?.toLowerCase() !== record.player_id) throw new Error("live-copy-detail-identity-conflict");
    }
    const again = await get(buildSharedTelemetrySourceKey(manifest.matchId, manifest.platform));
    if (!again || bodySha256(again.body) !== bodySha256(sourceObject!.body)) throw new Error("live-copy-common-source-changed");
  }
  const rows: { target: LegacyCopyTarget; blockers: string[]; equalBytes: boolean; arrayBodies: boolean; definitionVerified: boolean; proof?: Proof }[] = [];
  let compacted = 0, savedBytes = 0, uncertainWrites = 0;
  try {
  for (const target of targets) {
    bound();
    const objects = await Promise.all(target.originalKeys.map(get));
    if (objects.some(object => !object)) { rows.push({ target, blockers: ["original-body-missing"], equalBytes: false, arrayBodies: false, definitionVerified: false }); continue; }
    const [left, right] = objects as [ObjectRead, ObjectRead];
    const current = await facts(target);
    const result = proveLegacyCopy({ target, bodies: [left.body, right.body], ...current, secret });
    const row = { target, blockers: result.blockers, equalBytes: result.equalBytes, arrayBodies: result.arrayBodies, definitionVerified: result.definitionVerified } as typeof rows[number];
    if (result.manifest) {
      try {
        await verifyReplay(result.manifest, left.body);
        row.proof = { target, etags: [left.etag, right.etag], sha256: bodySha256(left.body), manifest: result.manifest, bytes: left.body.length + right.body.length };
      } catch (error) {
        row.blockers.push(error instanceof Error && /^live-copy-[a-z-]+$/.test(error.message) ? error.message.slice(10) : "replay-recalculation-unverified");
      }
    }
    rows.push(row);
    if (values.apply && row.proof) {
      const proof = row.proof;
      if (bodySha256(Buffer.from(JSON.stringify(proof))) !== values["plan-hash"]) throw new Error("live-copy-preceding-plan-conflict");
      const aliasKey = `telemetry-source/legacy-aliases/v1/${bodySha256(Buffer.from(target.originalKeys.join("\n")))}.enc`;
      const encrypted = sealLegacyCopyManifest(proof.manifest, secret);
      async function create(objectKey: string, body: Buffer, contentType: string, contentEncoding?: string) {
        bound();
        try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType,
          ...(contentEncoding ? { ContentEncoding: contentEncoding } : {}), IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(20000) }); }
        catch (error) { if ((error as any).$metadata?.httpStatusCode !== 412) throw new Error("live-copy-recovery-write-failed"); }
      }
      await create(proof.manifest.sourceKey, left.body, left.contentType || "application/json", left.contentEncoding);
      await create(aliasKey, encrypted, "application/octet-stream");
      const alias = await get(aliasKey), source = await get(proof.manifest.sourceKey);
      if (!alias || !source || !isDeepStrictEqual(readLegacyCopyRecords(alias.body, source.body, secret), proof.manifest.records)) throw new Error("live-copy-recovery-readback-failed");
      const restore = await runRestoreLegacyPlayerMatches({ aliasKey });
      if (restore.existingRecords !== 2 || restore.plannedInserts !== 0) throw new Error("live-copy-recovery-consumption-unverified");
      // Both original names remain as small authenticated recovery aliases.
      // Keep a durable journal before even the first conditional replacement.
      const journalBytes = sealRecoveryBytes(Buffer.from(JSON.stringify({ proof, aliasKey })), secret);
      if (proof.bytes <= source.body.length + 3 * alias.body.length + journalBytes.length) throw new Error("live-copy-no-positive-net-savings");
      const journalKey = `backups/legacy-copy-compaction/${bodySha256(Buffer.from(JSON.stringify(proof)))}.enc`;
      await writeFile(`${values.output}.journal.enc`, journalBytes, { mode: 0o600, flag: "wx" });
      await create(journalKey, journalBytes, "application/octet-stream");
      const journal = await get(journalKey);
      if (!journal || !isDeepStrictEqual(JSON.parse(openRecoveryBytes(journal.body, secret).toString("utf8")), { proof, aliasKey })) throw new Error("live-copy-journal-readback-failed");
      const latest = await facts(target);
      if (latest.referenced || latest.activeLease || proof.manifest.records.some(expected => {
        const matches = latest.records.filter(row => row.account_id === expected.account_id && row.platform === expected.platform);
        return matches.length !== 1 || !playerMatchRecordMatchesLiveRow(expected, matches[0] as unknown as Record<string, unknown>);
      })) throw new Error("live-copy-predelete-db-conflict");
      const lastObjects = await Promise.all(target.originalKeys.map(get));
      if (lastObjects.some((object, i) => !object || object.etag !== proof.etags[i] || bodySha256(object.body) !== proof.sha256)) throw new Error("live-copy-predelete-object-conflict");
      if (target.originalKeys.some(key => !inspectDeletionKey(key).allowed)) throw new Error("live-copy-protected-key");
      bound();
      for (let i = 0; i < target.originalKeys.length; i++) {
        bound();
        try {
          await client.send(new PutObjectCommand({ Bucket: bucket, Key: target.originalKeys[i], Body: alias.body,
            ContentType: "application/octet-stream", IfMatch: proof.etags[i] }), { abortSignal: AbortSignal.timeout(20000) });
          compacted++;
        } catch (error) {
          if ((error as any).$metadata?.httpStatusCode === 412) throw new Error("live-copy-original-changed-during-compaction");
          uncertainWrites++;
          throw new Error("live-copy-compaction-write-outcome-unknown");
        }
        const replaced = await get(target.originalKeys[i]);
        if (!replaced || bodySha256(replaced.body) !== bodySha256(alias.body)) throw new Error("live-copy-compaction-readback-failed");
        if (!isDeepStrictEqual(readLegacyCopyRecords(replaced.body, source.body, secret), proof.manifest.records)) throw new Error("live-copy-original-alias-consumption-failed");
      }
      await verifyReplay(proof.manifest, source.body);
      const restored = await runRestoreLegacyPlayerMatches({ aliasKey });
      if (restored.existingRecords !== 2 || restored.plannedInserts) throw new Error("live-copy-postdelete-recovery-unverified");
      savedBytes += proof.bytes - source.body.length - 3 * alias.body.length - journal.body.length;
    }
  }
  const blockers: Record<string, number> = {};
  rows.forEach(row => row.blockers.forEach(code => { blockers[code] = (blockers[code] || 0) + 1; }));
  const report = { format: 1, measuredAt: new Date().toISOString(), dryRun: !values.apply,
    examinedPairs: rows.length, exactBytePairs: rows.filter(row => row.equalBytes).length,
    arrayPairs: rows.filter(row => row.arrayBodies).length, definitionVerifiedPairs: rows.filter(row => row.definitionVerified).length,
    eligiblePairs: rows.filter(row => row.proof).length, deletedObjects: 0, compactedObjects: compacted,
    uncertainWrites, netSavedBytes: savedBytes, bytesRead, blockers,
    planHashes: rows.map(row => row.proof ? bodySha256(Buffer.from(JSON.stringify(row.proof))) : null) };
  await proofOutput.writeFile(JSON.stringify({ report, pairs: rows }, null, 2));
  return report;
  } catch (error) {
    const errorCode = error instanceof Error && /^live-copy-[a-z-]+$/.test(error.message) ? error.message : "live-copy-verification-failed";
    await proofOutput.writeFile(JSON.stringify({ failed: true, errorCode, deletedObjects: 0, compactedObjects: compacted, uncertainWrites, pairs: rows }, null, 2));
    throw error;
  } finally { await proofOutput.close(); client.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLegacyCopyVerification().then(report => console.log(JSON.stringify(report))).catch(error => {
    const errorCode = error instanceof Error && /^live-copy-[a-z-]+$/.test(error.message) ? error.message : "live-copy-verification-failed";
    console.error(JSON.stringify({ errorCode })); process.exitCode = 1;
  });
}
