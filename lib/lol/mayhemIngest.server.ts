import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { createSourceDownloader, sha256, validClientPatch } from "./augments/ingest";
import { downloadMayhemDataset } from "./mayhemDataset";
import { prepareReviewedMayhemDataset, type MayhemOfficialAugment } from "./mayhemReviewedDataset";

const SOURCE = "arammayhem";
const JOB = "mayhem-external:arammayhem";
const LEASE = "ops:lol-mayhem-external:arammayhem";
const signal = () => AbortSignal.timeout(10_000);
const boundedFetch: typeof fetch = (url, options) => fetch(url, { ...options,
  signal: options?.signal ? AbortSignal.any([options.signal, signal()]) : signal() });
const errorCode = (error: unknown) => error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "dataset_sync_failed";

export async function ingestMayhemDataset(options: { apply: boolean; patch?: string }) {
  if (options.patch && !validClientPatch(options.patch)) throw new Error("invalid_patch");
  if (options.apply && (process.env.LOL_MAYHEM_DATASET_ENABLED !== "true" || process.env.LOL_PERSISTENCE_ENABLED !== "true")) throw new Error("dataset_sync_disabled");
  const startedAt = new Date().toISOString();
  const dataset = await downloadMayhemDataset().catch(async error => {
    if (options.apply) {
      const db = createServiceRoleSupabase(boundedFetch);
      const lease = await db.rpc("acquire_lol_collection_lease", { p_key: LEASE, p_ttl_seconds: 120 }).abortSignal(signal());
      const token = lease.data?.[0]?.lease_token;
      if (token) {
        try {
          const previous = await db.from("lol_data_sync_status").select("consecutive_failures").eq("job_key", JOB).abortSignal(signal()).maybeSingle();
          const saved = await db.from("lol_data_sync_status").upsert({ job_key: JOB, last_checked_at: startedAt, last_error_code: errorCode(error), consecutive_failures: (previous.data?.consecutive_failures ?? 0) + 1 }).abortSignal(signal());
          if (saved.error) console.warn("[lol-mayhem] status_write_failed");
        } finally { await db.rpc("release_lol_collection_lease", { p_key: LEASE, p_token: token }).abortSignal(signal()); }
      }
    }
    throw error;
  });
  const sourceCounts = { augments: dataset.rates.length, combos: dataset.combos.length };
  let counts = sourceCounts;
  if (!options.apply) return { dryRun: true, releaseId: dataset.releaseId, batchHash: dataset.batchHash, ...counts, ...dataset.metadata };
  const db = createServiceRoleSupabase(boundedFetch);
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await db.rpc(name, args).abortSignal(signal());
    if (result.error) throw new Error("dataset_database_error");
    return result.data as T;
  }
  const leases = await rpc<Array<{ lease_token: string }>>("acquire_lol_collection_lease", { p_key: LEASE, p_ttl_seconds: 120 });
  const token = leases[0]?.lease_token;
  if (!token) throw new Error("dataset_lease_busy");
  let previousFailures = 0;
  try {
    const previousStatus = await db.from("lol_data_sync_status").select("consecutive_failures").eq("job_key", JOB).abortSignal(signal()).maybeSingle();
    previousFailures = previousStatus.data?.consecutive_failures ?? 0;
    const publication = await db.from("lol_augment_publication").select("client_patch").eq("singleton", true).abortSignal(signal()).maybeSingle();
    if (publication.error) throw new Error("dataset_database_error");
    const patch = options.patch ?? publication.data?.client_patch;
    if (!patch || !validClientPatch(patch)) throw new Error("official_patch_missing");
    const [patches, mappings, latest] = await Promise.all([
      db.from("lol_game_patches").select("client_patch,display_patch,ddragon_version").in("display_patch", [...new Set([dataset.metadata.sourcePatch])]).abortSignal(signal()),
      db.from("lol_mayhem_augment_mappings").select("external_id,client_patch,platform_id,status,evidence,reviewed_at").eq("source", SOURCE).order("external_id").order("client_patch").limit(1000).abortSignal(signal()),
      db.from("lol_mayhem_dataset_releases").select("mapping_revision,metadata").eq("source", SOURCE).eq("verified_client_patch", patch).order("id", { ascending: false }).limit(1).abortSignal(signal()),
    ]);
    if (patches.error || mappings.error || latest.error) throw new Error("dataset_database_error");
    if (mappings.data.length >= 1000) throw new Error("mapping_catalog_too_large");
    const sourcePatch = patches.data.find(row => row.display_patch === dataset.metadata.sourcePatch)?.client_patch;
    if (!sourcePatch) throw new Error("source_patch_unregistered");
    const target = await db.from("lol_game_patches").select("ddragon_version").eq("client_patch", patch).abortSignal(signal()).single();
    const version = target.data?.ddragon_version;
    if (target.error || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !version.startsWith(`${patch}.`)) throw new Error("champion_version_unverified");
    const championUrl = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`;
    const rawChampions = await createSourceDownloader((url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(8_000) }))(championUrl, true, 4 * 1024 * 1024);
    const championData: unknown = JSON.parse(rawChampions);
    const rows = (championData as { data?: Record<string, { id?: unknown; key?: unknown }> })?.data;
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new Error("invalid_champion_catalog");
    const champions = new Map(Object.values(rows).map(row => [row.id, Number(row.key)]));
    const combos = dataset.combos.map(combo => {
      const championId = champions.get(combo.championId);
      if (championId === undefined || !Number.isSafeInteger(championId) || championId <= 0) throw new Error("unknown_champion");
      return { ...combo, championId };
    });
    const scopes = [...new Set([patch, sourcePatch])];
    const [states, texts] = await Promise.all([
      db.from("lol_augment_patch_states").select("platform_id,client_patch,rarity,enabled,in_pool,is_internal,state").in("client_patch", scopes).eq("mode_name", "KIWI").limit(1000).abortSignal(signal()),
      db.from("lol_augment_localizations").select("platform_id,client_patch,locale,name,display_text").in("client_patch", scopes).in("locale", ["ko_kr", "en_us"]).limit(1000).abortSignal(signal()),
    ]);
    if (states.error || texts.error || states.data.length >= 1000 || texts.data.length >= 1000) throw new Error("official_archive_catalog_missing");
    const officials: Record<string, MayhemOfficialAugment[]> = {};
    for (const scope of scopes) officials[scope] = states.data.filter(row => row.client_patch === scope && !row.is_internal).map(row => {
      const ko = texts.data.find(text => text.client_patch === scope && text.platform_id === row.platform_id && text.locale === "ko_kr");
      const en = texts.data.find(text => text.client_patch === scope && text.platform_id === row.platform_id && text.locale === "en_us");
      if (!ko?.name || !en?.name || !ko.display_text) throw new Error("official_archive_catalog_missing");
      return { id: row.platform_id, name: ko.name, nameEn: en.name, text: ko.display_text, rarity: row.rarity, enabled: row.enabled, inPool: row.in_pool, internal: row.is_internal, state: row.state, icon: null, notice: null, isNew: false };
    });
    const reviewed = prepareReviewedMayhemDataset({ dataset, patch, sourcePatch, combos, officials, mappings: mappings.data });
    if (!reviewed.rates.length || !reviewed.combos.length) throw new Error("reviewed_dataset_empty");
    const archiveBody = JSON.stringify(reviewed.archive), archiveHash = sha256(archiveBody);
    if (Buffer.byteLength(archiveBody) > 4 * 1024 * 1024) throw new Error("reviewed_archive_too_large");
    counts = { augments: reviewed.rates.length, combos: reviewed.combos.length };
    const mappingHash = sha256(JSON.stringify(mappings.data));
    const prior = latest.data[0];
    const mappingRevision = prior?.metadata?.mappingHash === mappingHash && prior?.metadata?.archiveHash === archiveHash ? prior.mapping_revision : (prior?.mapping_revision ?? 0) + 1;
    const rates = reviewed.rates.map(rate => ({ externalId: rate.externalId, pickRate: rate.pickRate, pickRateRank: rate.pickRateRank, sourceClientPatch: sourcePatch }));
    const prefix = `external/${SOURCE}/batches/${dataset.batchHash}`;
    const files = Object.fromEntries(Object.entries(dataset.raw).map(([kind, file]) => [kind, {
      path: `external/${SOURCE}/objects/${file.hash}.json`, url: file.url, hash: file.hash,
      bytes: Buffer.byteLength(file.body), etag: file.etag, lastModified: file.lastModified,
    }]));
    files.champions = { path: `external/${SOURCE}/objects/${sha256(rawChampions)}.json`, url: championUrl, hash: sha256(rawChampions), bytes: Buffer.byteLength(rawChampions), etag: null, lastModified: null };
    const rawManifest = JSON.stringify({ source: SOURCE, releaseId: dataset.releaseId, files, license: dataset.metadata.license, attribution: dataset.metadata.attribution });
    const captureHash = sha256(rawManifest);
    const rawManifestPath = `${prefix}/captures/${captureHash}/manifest.json`;
    const manifestPath = `${prefix}/captures/${captureHash}/normalized/${patch}/v2-m${mappingRevision}.json`;
    const mappingSnapshot = mappings.data.map(({ external_id, client_patch, platform_id, status, reviewed_at }) => ({ external_id, client_patch, platform_id, status, reviewed_at }));
    const metadata = { ...dataset.metadata, sourceClientPatch: sourcePatch, ...counts, counts, captureHash, mappingSnapshot, rawManifestPath, normalizerVersion: 2, mappingRevision, mappingHash, archiveHash, archiveBytes: Buffer.byteLength(archiveBody), archiveSummary: reviewed.summary, sourceCounts,
      championVersion: version, championCatalogHash: sha256(rawChampions), leaseToken: token };
    const normalized = JSON.stringify({ ...metadata, leaseToken: undefined, mappings: mappings.data, rates, combos: reviewed.combos, archive: reviewed.archive });
    const storage = db.storage.from("lol-augment-snapshots");
    for (const [path, body] of [...Object.entries(dataset.raw).map(([kind, file]) => [files[kind].path, file.body]), [files.champions.path, rawChampions], [rawManifestPath, rawManifest], [manifestPath, normalized]]) {
      await rpc("renew_lol_mayhem_dataset_lease", { p_token: token });
      const upload = await storage.upload(path, body, { contentType: "application/json", upsert: false });
      if (upload.error && String(upload.error.statusCode) !== "409") throw new Error("dataset_storage_error");
    }
    await rpc("renew_lol_mayhem_dataset_lease", { p_token: token });
    const id = await rpc<number>("ingest_lol_mayhem_dataset", { p_patch: patch, p_batch_hash: dataset.batchHash, p_release_id: dataset.releaseId,
      p_manifest_path: manifestPath, p_metadata: metadata, p_rates: rates, p_combos: reviewed.combos });
    return { dryRun: false, id, patch, batchHash: dataset.batchHash, ...counts, status: "awaiting_review" };
  } catch (error) {
    const saved = await db.from("lol_data_sync_status").upsert({ job_key: JOB, last_checked_at: startedAt, last_error_code: errorCode(error),
      consecutive_failures: previousFailures + 1, counts }).abortSignal(signal());
    if (saved.error) console.warn("[lol-mayhem] status_write_failed");
    throw error;
  } finally {
    await db.rpc("release_lol_collection_lease", { p_key: LEASE, p_token: token }).abortSignal(signal());
  }
}
