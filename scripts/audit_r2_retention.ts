/** Diagnostic branch only: SELECT, LIST and GET; no database or R2 writes. */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash, publicEncrypt, randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sealRecoveryArchive } from './r2_recovery_archive';
import { parseTelemetryPayload } from '../lib/pubg-analysis/telemetryContract';
import { createTelemetryPublicIdentity, type TelemetryPublicIdentity } from '../lib/pubg-analysis/telemetryIdentity';

type Row = Record<string, unknown>;
type ObjectEntry = { key: string; bytes: number; etag: string; modified: string };
const tables: Array<[string, string, string]> = [
  ['match_master_telemetry', 'match_id,storage_path,telemetry_version,created_at', 'match_id'],
  ['telemetry_map_cache_entries', 'id,match_id,platform,player_id,mode,telemetry_version,storage_path,status,created_at,updated_at', 'id'],
  ['processed_match_telemetry', 'match_id,player_id,platform,created_at,updated_at', 'match_id,player_id,platform'],
  ['pubg_player_matches', 'match_id,player_id,account_id,platform,played_at', 'match_id,player_id,platform'],
  ['pubg_player_match_discovery', 'match_id,account_id,platform,state,first_seen_at,last_seen_at', 'match_id,account_id,platform'],
  ['match_stats_raw', 'id,match_id,player_id,platform,created_at', 'id'],
  ['global_benchmarks', 'id,match_id,player_id,platform,source,filter_version,calculation_version', 'id'],
  ['match_ai_coaching_cache', 'id,match_id,player_id,platform,created_at', 'id'],
  ['attachments', 'id,r2_key', 'id'],
  ['board_image_objects', 'id,storage_key', 'id'],
  ['bonus_items', 'id,r2_key', 'id'],
  ['crate_item_assets', 'id,r2_key', 'id'],
  ['crate_items', 'id,r2_key', 'id'],
  ['crate_templates', 'id,r2_key', 'id'],
  ['prime_parcel_items', 'id,r2_key', 'id'],
  ['support_attachments', 'id,storage_key', 'id'],
];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function objectGroup(key: string): string {
  const parts = key.split('/');
  return parts.length === 1 ? '(root)' : parts[0] === 'telemetry-map' ? parts.slice(0, 2).join('/') : parts[0];
}
export function describeBody(body: Buffer): Row {
  const zipped = body[0] === 0x1f && body[1] === 0x8b;
  const decoded = zipped ? gunzipSync(body, { maxOutputLength: 134217728 }) : body;
  const parsed: unknown = JSON.parse(decoded.toString('utf8'));
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
  const events: Row[] | null = Array.isArray(parsed) ? parsed : Array.isArray(record.events) ? record.events : Array.isArray(record.telemetry) ? record.telemetry : null;
  const types: Record<string, number> = {};
  if (events) for (const event of events) {
    const name = event && typeof event === 'object' ? String(event._T ?? '(unknown)') : '(invalid)';
    types[name] = (types[name] ?? 0) + 1;
  }
  let mapContractValid: boolean | undefined;
  if (record.identity && record.startTime && Array.isArray(record.zoneEvents)) {
    try {
      parseTelemetryPayload(parsed, createTelemetryPublicIdentity(record.identity as TelemetryPublicIdentity));
      mapContractValid = true;
    } catch { mapContractValid = false; }
  }
  const participants: Array<{ playerHash: string; accountHash?: string; platform?: unknown }> = [];
  const matchDefinitions: Row[] = [];
  if (events) for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event._T === 'LogMatchDefinition') matchDefinitions.push(event);
    if (event._T === 'LogMatchStart' && Array.isArray(event.characters)) {
      for (const value of event.characters) {
        const character = value && typeof value === 'object' ? ('character' in value ? value.character : value) as Row : null;
        if (character && typeof character.name === 'string') participants.push({
          playerHash: sha(character.name.toLowerCase()),
          accountHash: typeof character.accountId === 'string' ? sha(character.accountId).slice(0, 32) : undefined,
          platform: character.platform,
        });
      }
    }
  }
  return {
    gzip: zipped, compressedBytes: body.length, decodedBytes: decoded.length,
    sha256: sha(body), gzip9Bytes: gzipSync(decoded, { level: 9 }).length,
    kind: Array.isArray(parsed) ? 'array' : typeof parsed,
    keys: Object.keys(record), identity: record.identity, projection: record.projection,
    format: record.analyzeFormat ?? record.formatVersion, version: record.version ?? record.v,
    mapContractValid, participants, matchDefinitions,
    matchId: record.matchId, player_id: record.player_id, matchInfo: record.matchInfo, stats: record.stats,
    eventCount: events?.length, eventTypes: types, eventsSha256: events ? sha(JSON.stringify(events)) : undefined,
    firstEventTime: events?.find(event => event && typeof event === 'object' && event._D)?._D,
    lastEventTime: events?.findLast(event => event && typeof event === 'object' && event._D)?._D,
  };
}

async function main() {
  const started = new Date().toISOString();
  const deadline = Date.now() + 540000;
  const env = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error('missing-audit-configuration');
    return value;
  };
  const encryptionKey = randomBytes(32).toString('base64');
  const wrappedKey = publicEncrypt({ key: await readFile('scripts/r2-retention-audit-public.txt'), oaepHash: 'sha256' }, Buffer.from(encryptionKey));
  const client = new S3Client({ region: 'auto', endpoint: env('CLOUDFLARE_R2_ENDPOINT'),
    credentials: { accessKeyId: env('CLOUDFLARE_R2_ACCESS_KEY_ID'), secretAccessKey: env('CLOUDFLARE_R2_SECRET_ACCESS_KEY') },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 10000, requestTimeout: 20000 }), maxAttempts: 2,
  });
  const bucket = env('CLOUDFLARE_R2_BUCKET_NAME');
  const validationOnly = process.env.RETENTION_VALIDATION_ONLY === 'true';
  const supabaseUrl = validationOnly ? '' : env('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = validationOnly ? '' : env('SUPABASE_SERVICE_ROLE_KEY');
  const checkBudget = () => { if (Date.now() > deadline) throw new Error('audit-duration-bound'); };
  const objects: ObjectEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    checkBudget();
    if (pages >= 100) throw new Error('audit-inventory-page-bound');
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: cursor }), { abortSignal: AbortSignal.timeout(25000) });
    for (const item of page.Contents ?? []) {
      if (!item.Key || item.Size === undefined || !item.ETag || !item.LastModified) throw new Error('incomplete-object-metadata');
      objects.push({ key: item.Key, bytes: item.Size, etag: item.ETag, modified: item.LastModified.toISOString() });
    }
    pages++;
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !cursor) throw new Error('incomplete-object-cursor');
  } while (cursor);
  if (new Set(objects.map(item => item.key)).size !== objects.length) throw new Error('inventory-pagination-conflict');
  console.log(`Complete inventory: ${objects.length} objects, ${pages} pages.`);
  const database: Record<string, Row[]> = {};
  for (const [table, select, order] of validationOnly ? [] : tables) {
    const rows: Row[] = [];
    for (let offset = 0; ; offset += 1000) {
      checkBudget();
      if (offset >= 200000) throw new Error('audit-database-page-bound');
      const url = new URL(`/rest/v1/${table}`, supabaseUrl);
      url.searchParams.set('select', select);
      url.searchParams.set('order', order.split(',').map(column => `${column}.asc`).join(','));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('limit', '1000');
      const response = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`audit-database-read-failed:${table}:${response.status}`);
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw new Error('invalid-database-page');
      rows.push(...page as Row[]);
      if (page.length < 1000) break;
    }
    database[table] = rows;
    console.log(`Read ${table}: ${rows.length} metadata rows.`);
  }
  const inventoryArchives: Row[] = [];
  const manifests = validationOnly ? [] : objects.filter(item => item.key.startsWith('telemetry-inventory/'));
  if (manifests.length > 500) throw new Error('audit-manifest-bound');
  let manifestIndex = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (manifestIndex < manifests.length) {
      const item = manifests[manifestIndex++];
      checkBudget();
      try {
        if (item.bytes > 65536) throw new Error('manifest-size-bound');
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.key, IfMatch: item.etag }), { abortSignal: AbortSignal.timeout(25000) });
        if (!response.Body || response.ContentLength !== item.bytes || response.ETag !== item.etag) throw new Error('manifest-conflict');
        const body = Buffer.from(await response.Body.transformToByteArray());
        if (body.length !== item.bytes || body.length > 65536) throw new Error('manifest-body-bound');
        const decoded = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body, { maxOutputLength: 2097152 }) : body;
        const parsed = JSON.parse(decoded.toString('utf8'));
        if (parsed.version !== 1 || !Array.isArray(parsed.objects) || parsed.objects.some((entry: Row) => typeof entry.storagePath !== 'string' && typeof entry.storage_path !== 'string')) throw new Error('manifest-unknown-format');
        inventoryArchives.push({ key: item.key, etag: item.etag, sha256: sha(body), objects: parsed.objects });
      } catch { inventoryArchives.push({ key: item.key, error: 'manifest-read-or-parse-failed' }); }
    }
  }));
  console.log(`Read ${inventoryArchives.length} archived inventory manifests.`);
  const samples: Row[] = [];
  const selected = new Map<string, ObjectEntry>();
  const sampleGroups = new Map<string, ObjectEntry[]>();
  for (const item of objects) {
    if (!item.key.endsWith('.json') || !['(root)', 'telemetry-map/v60', 'telemetry-map/v61', 'telemetry-map/v62'].includes(objectGroup(item.key))) continue;
    const group = `${objectGroup(item.key)}/${item.key.endsWith('_analyze.json') ? 'analysis' : 'map'}`;
    const groupObjects = sampleGroups.get(group) ?? [];
    groupObjects.push(item); sampleGroups.set(group, groupObjects);
  }
  for (const group of sampleGroups.values()) {
    group.sort((a, b) => a.modified.localeCompare(b.modified));
    for (const item of [...group.slice(0, 2), ...group.slice(-2)]) selected.set(item.key, item);
  }
  const matchGroups = new Map<string, ObjectEntry[]>();
  for (const item of objects.filter(value => value.key.startsWith('telemetry-map/') && value.key.endsWith('_analyze.json'))) {
    const id = item.key.split('/').slice(0, 4).join('/');
    const group = matchGroups.get(id) ?? []; group.push(item); matchGroups.set(id, group);
  }
  for (const version of ['v60', 'v61', 'v62']) {
    const pair = [...matchGroups.entries()].find(([key, entries]) => key.includes(`/${version}/`) && entries.length >= 2);
    if (pair) for (const item of pair[1].slice(0, 3)) selected.set(item.key, item);
  }
  if (validationOnly) {
    selected.clear();
    const targetFile = JSON.parse(await readFile('scripts/r2-retention-audit-targets.json', 'utf8')) as { targets: Array<{ keyHash: string; etag: string; bytes: number }> };
    if (!Array.isArray(targetFile.targets) || targetFile.targets.length > 120) throw new Error('audit-content-bound');
    for (const target of targetFile.targets) {
      const item = objects.find(object => sha(object.key) === target.keyHash);
      if (!item || item.etag !== target.etag || item.bytes !== target.bytes) throw new Error('audit-target-conflict');
      selected.set(item.key, item);
    }
  }
  for (const item of [...selected.values()].slice(0, validationOnly ? 120 : 40)) {
    checkBudget();
    if (item.bytes > 33554432) { samples.push({ key: item.key, error: 'sample-size-bound' }); continue; }
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.key, IfMatch: item.etag }), { abortSignal: AbortSignal.timeout(25000) });
      if (!response.Body || response.ContentLength !== item.bytes || response.ETag !== item.etag) throw new Error('sample-metadata-conflict');
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > 33554432) throw new Error('sample-size-bound');
        chunks.push(Buffer.from(chunk));
      }
      if (length !== item.bytes) throw new Error('sample-incomplete-body');
      samples.push({ key: item.key, etag: item.etag, ...describeBody(Buffer.concat(chunks)) });
    } catch { samples.push({ key: item.key, error: 'sample-read-or-parse-failed' }); }
  }
  const groups: Record<string, { objects: number; bytes: number }> = {};
  for (const item of objects) {
    const group = groups[objectGroup(item.key)] ?? { objects: 0, bytes: 0 };
    group.objects++; group.bytes += item.bytes; groups[objectGroup(item.key)] = group;
  }
  const ended = new Date().toISOString();
  const report = { started, ended,
    complete: !inventoryArchives.some(manifest => manifest.error) && !samples.some(sample => sample.error),
    inventoryComplete: true, databaseMetadataComplete: !validationOnly,
    validationOnly,
    readOnly: true, pages, objects: objects.length,
    bytes: objects.reduce((sum, item) => sum + item.bytes, 0), groups,
    tableRows: Object.fromEntries(Object.entries(database).map(([table, rows]) => [table, rows.length])),
    samples: samples.length, sampleFailures: samples.filter(sample => sample.error).length,
    manifests: inventoryArchives.length, manifestFailures: inventoryArchives.filter(manifest => manifest.error).length,
    atomicSnapshot: false,
  };
  const output = env('RUNNER_TEMP');
  const plaintext = join(output, 'r2-retention-private.json.gz');
  await writeFile(plaintext, gzipSync(JSON.stringify({ report, objects, database, inventoryArchives, samples })), { mode: 0o600, flag: 'wx' });
  try { await sealRecoveryArchive(plaintext, join(output, 'r2-retention-private.enc'), encryptionKey); }
  finally { await unlink(plaintext); }
  await writeFile(join(output, 'r2-retention-wrapped-key.enc'), wrappedKey, { mode: 0o600, flag: 'wx' });
  await writeFile(join(output, 'r2-retention-summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  client.destroy();
}
if (process.argv[1]?.endsWith('audit_r2_retention.ts')) main().catch((error: unknown) => {
  const safeMessage = error instanceof Error && /^audit-[a-z-]+(?::[a-z_]+:\d+)?$/.test(error.message) ? error.message : 'audit-read-failed';
  console.error(`Read-only retention audit failed (${safeMessage}); no storage or database mutations performed.`);
  process.exitCode = 1;
});
