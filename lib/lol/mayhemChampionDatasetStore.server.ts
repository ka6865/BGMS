import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { createSourceDownloader } from "./augments/ingest";
import {
  CHAMPION_DATASET_COHORT, CHAMPION_DATASET_MAX_FILE_BYTES, CHAMPION_DATASET_PREFIX, CHAMPION_DATASET_SOURCE,
  normalizeChampionAugments, validateChampionStatsFile,
  type ChampionCandidateInput, type ChampionDatasetAdminData, type ChampionDatasetManifest,
  type ChampionDatasetReadiness, type ChampionManifestFile, type ChampionStatsFile, type PublicChampionStats,
} from "./mayhemChampionDataset";

export const MAYHEM_CHAMPION_DATASET_TAG = "lol-mayhem-champion-dataset";
const signal = () => AbortSignal.timeout(10_000);
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const manifestKeys = ["schemaVersion", "source", "cohort", "clientPatch", "upstreamVersion", "sourceDataDate", "catalogHash", "expectedChampionIds", "files", "attribution", "rightsBasis", "normalizerVersion"];
const fileKeys = ["championId", "rawPath", "rawHash", "rawBytes", "normalizedPath", "normalizedHash", "normalizedBytes"];
const objectPath = (hash: string) => `${CHAMPION_DATASET_PREFIX}/objects/${hash}.json`;

export function getChampionDatasetReadiness(): ChampionDatasetReadiness {
  const env = process.env;
  return {
    apiKeyConfigured: Boolean(env.LOL_MAYHEM_STATS_API_KEY?.trim()),
    reuseConfirmed: env.LOL_MAYHEM_STATS_REUSE_CONFIRMED === "true"
      && (env.LOL_MAYHEM_STATS_REUSE_BASIS?.trim().length ?? 0) >= 10
      && (env.LOL_MAYHEM_STATS_ATTRIBUTION?.trim().length ?? 0) >= 1,
    enabled: env.LOL_MAYHEM_CHAMPION_DATASET_ENABLED === "true",
    persistenceEnabled: env.LOL_PERSISTENCE_ENABLED === "true",
  };
}

function requireReady() {
  const readiness = getChampionDatasetReadiness();
  if (!readiness.apiKeyConfigured || !readiness.reuseConfirmed || !readiness.enabled || !readiness.persistenceEnabled) {
    throw new Error("stats_dataset_not_ready");
  }
}

function validManifest(value: unknown): ChampionDatasetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stats_manifest_invalid");
  const m = value as Record<string, unknown>;
  if (Object.keys(m).length !== manifestKeys.length || manifestKeys.some(key => !(key in m))
    || m.schemaVersion !== 1 || m.source !== CHAMPION_DATASET_SOURCE || m.cohort !== CHAMPION_DATASET_COHORT
    || typeof m.clientPatch !== "string" || !/^(15|16)\.[1-9][0-9]?$/.test(m.clientPatch)
    || typeof m.upstreamVersion !== "string" || !m.upstreamVersion.startsWith(`${m.clientPatch}.`) || !/^\d+\.\d+\.\d+$/.test(m.upstreamVersion)
    || typeof m.sourceDataDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.sourceDataDate)
    || typeof m.catalogHash !== "string" || !/^[a-f0-9]{64}$/.test(m.catalogHash)
    || !Array.isArray(m.expectedChampionIds) || m.expectedChampionIds.length < 1 || m.expectedChampionIds.length > 300
    || !Array.isArray(m.files) || m.files.length !== m.expectedChampionIds.length
    || typeof m.attribution !== "string" || !m.attribution.trim() || m.attribution.length > 512
    || typeof m.rightsBasis !== "string" || m.rightsBasis.trim().length < 10 || m.rightsBasis.length > 2048
    || m.normalizerVersion !== 1) throw new Error("stats_manifest_invalid");
  const ids = m.expectedChampionIds as unknown[];
  if (ids.some(id => !Number.isSafeInteger(id) || Number(id) <= 0 || Number(id) > 99999)
    || ids.some((id, index) => index > 0 && Number(ids[index - 1]) >= Number(id))) throw new Error("stats_manifest_invalid");
  const files = m.files as ChampionManifestFile[];
  if (files.some(file => !file || typeof file !== "object" || Object.keys(file).length !== fileKeys.length
    || fileKeys.some(key => !(key in file)) || !Number.isSafeInteger(file.championId)
    || typeof file.rawHash !== "string" || !/^[a-f0-9]{64}$/.test(file.rawHash)
    || typeof file.normalizedHash !== "string" || !/^[a-f0-9]{64}$/.test(file.normalizedHash)
    || file.rawPath !== objectPath(file.rawHash) || file.normalizedPath !== objectPath(file.normalizedHash)
    || !Number.isSafeInteger(file.rawBytes) || file.rawBytes < 1 || file.rawBytes > CHAMPION_DATASET_MAX_FILE_BYTES
    || !Number.isSafeInteger(file.normalizedBytes) || file.normalizedBytes < 1 || file.normalizedBytes > CHAMPION_DATASET_MAX_FILE_BYTES)
    || files.some((file, index) => file.championId !== ids[index])) throw new Error("stats_manifest_invalid");
  return m as unknown as ChampionDatasetManifest;
}

async function readText(db: ReturnType<typeof createServiceRoleSupabase>, path: string, maxBytes: number) {
  if (!new RegExp(`^${CHAMPION_DATASET_PREFIX.replaceAll("/", "\\/")}/(?:objects/[a-f0-9]{64}\\.json|captures/[a-f0-9]{64}/manifest\\.json)$`).test(path)) throw new Error("stats_manifest_invalid");
  const result = await db.storage.from("lol-augment-snapshots").download(path);
  if (result.error || !result.data || result.data.size < 1 || result.data.size > maxBytes) throw new Error("stats_snapshot_invalid");
  return result.data.text();
}

async function officialCatalog(db: ReturnType<typeof createServiceRoleSupabase>, patch: string) {
  const [patchResult, stateResult] = await Promise.all([
    db.from("lol_game_patches").select("ddragon_version").eq("client_patch", patch).abortSignal(signal()).single(),
    db.from("lol_augment_patch_states").select("platform_id").eq("client_patch", patch).eq("mode_name", "KIWI").eq("in_pool", true)
      .order("platform_id").limit(1000).abortSignal(signal()),
  ]);
  if (patchResult.error || stateResult.error || !stateResult.data || stateResult.data.length < 1 || stateResult.data.length >= 1000) throw new Error("stats_official_catalog_missing");
  const version = patchResult.data?.ddragon_version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !version.startsWith(`${patch}.`)) throw new Error("stats_champion_catalog_missing");
  const augmentIds = stateResult.data.map(row => row.platform_id);
  const catalogHash = sha(JSON.stringify(augmentIds));
  let parsed: unknown;
  try {
    const download = createSourceDownloader((url, init) => fetch(url, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal()]) : signal(),
    }));
    parsed = JSON.parse(await download(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, true, CHAMPION_DATASET_MAX_FILE_BYTES));
  } catch { throw new Error("stats_champion_catalog_missing"); }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("stats_champion_catalog_missing");
  const championIds = Object.values(data as Record<string, { key?: unknown }>).map(item => typeof item?.key === "string" ? Number(item.key) : NaN).sort((a, b) => a - b);
  if (!championIds.length || championIds.length > 300 || championIds.some((id, i) => !Number.isSafeInteger(id) || id <= 0 || (i > 0 && championIds[i - 1] === id))) throw new Error("stats_champion_catalog_missing");
  return { championIds, augmentIds, catalogHash };
}

async function readVerifiedManifest(db: ReturnType<typeof createServiceRoleSupabase>, input: {
  captureHash: string; manifestPath: string; patch: string; upstreamVersion: string; sourceDataDate: string; catalogHash: string;
  metadata?: ChampionDatasetManifest;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.captureHash)
    || input.manifestPath !== `${CHAMPION_DATASET_PREFIX}/captures/${input.captureHash}/manifest.json`) throw new Error("stats_manifest_invalid");
  const body = await readText(db, input.manifestPath, 1024 * 1024);
  if (sha(body) !== input.captureHash) throw new Error("stats_manifest_hash_mismatch");
  let manifest: ChampionDatasetManifest;
  try { manifest = validManifest(JSON.parse(body)); } catch { throw new Error("stats_manifest_invalid"); }
  if (manifest.clientPatch !== input.patch || manifest.upstreamVersion !== input.upstreamVersion
    || manifest.sourceDataDate !== input.sourceDataDate || manifest.catalogHash !== input.catalogHash
    || (input.metadata && !isDeepStrictEqual(manifest, validManifest(input.metadata)))) throw new Error("stats_manifest_mismatch");
  return manifest;
}

async function verifyReleaseObjects(db: ReturnType<typeof createServiceRoleSupabase>, manifest: ChampionDatasetManifest) {
  const catalog = await officialCatalog(db, manifest.clientPatch);
  if (catalog.catalogHash !== manifest.catalogHash || JSON.stringify(catalog.championIds) !== JSON.stringify(manifest.expectedChampionIds)) throw new Error("stats_catalog_changed");
  const allowed = new Set(catalog.augmentIds);
  for (const file of manifest.files) {
    const [raw, normalizedBody] = await Promise.all([
      readText(db, file.rawPath, CHAMPION_DATASET_MAX_FILE_BYTES),
      readText(db, file.normalizedPath, CHAMPION_DATASET_MAX_FILE_BYTES),
    ]);
    if (sha(raw) !== file.rawHash || Buffer.byteLength(raw) !== file.rawBytes
      || sha(normalizedBody) !== file.normalizedHash || Buffer.byteLength(normalizedBody) !== file.normalizedBytes) throw new Error("stats_snapshot_hash_mismatch");
    let stats: ChampionStatsFile;
    let rawValue: unknown;
    try { stats = validateChampionStatsFile(JSON.parse(normalizedBody)); rawValue = JSON.parse(raw); } catch { throw new Error("stats_snapshot_invalid"); }
    if (stats.championId !== file.championId || stats.clientPatch !== manifest.clientPatch || stats.upstreamVersion !== manifest.upstreamVersion
      || stats.sourceDataDate !== manifest.sourceDataDate || stats.catalogHash !== manifest.catalogHash
      || JSON.stringify(normalizeChampionAugments(rawValue, {
        clientPatch: manifest.clientPatch, championId: file.championId, allowedAugmentIds: allowed,
        upstreamVersion: manifest.upstreamVersion, sourceDataDate: manifest.sourceDataDate, fetchedAt: stats.fetchedAt, catalogHash: manifest.catalogHash,
      })) !== JSON.stringify(stats)) throw new Error("stats_snapshot_invalid");
  }
}

export async function createChampionDatasetCandidate(input: ChampionCandidateInput): Promise<number> {
  const readiness = getChampionDatasetReadiness();
  if (!readiness.apiKeyConfigured || !readiness.enabled || !readiness.persistenceEnabled) throw new Error("stats_dataset_not_ready");
  if ((process.env.LOL_MAYHEM_STATS_REUSE_BASIS?.trim().length ?? 0) < 10 || !process.env.LOL_MAYHEM_STATS_ATTRIBUTION?.trim()) throw new Error("stats_collection_basis_missing");
  if (!input || !/^[a-f0-9]{64}$/.test(input.captureHash) || !/^[a-f0-9]{64}$/.test(input.catalogHash)
    || !/^[0-9a-f-]{36}$/i.test(input.leaseToken)) throw new Error("stats_candidate_invalid");
  const db = createServiceRoleSupabase();
  await readVerifiedManifest(db, { ...input, patch: input.clientPatch });
  const { leaseToken, ...candidate } = input;
  const { data, error } = await db.rpc("ingest_lol_mayhem_champion_dataset", { p_candidate: candidate, p_token: leaseToken });
  if (error || !Number.isSafeInteger(Number(data)) || Number(data) <= 0) throw new Error("stats_candidate_save_failed");
  return Number(data);
}

export async function reviewChampionDataset(input: {
  id: number; action: "approve" | "reject" | "publish" | "rollback"; expectedPublication: number | null; reviewedBy: string; reason?: string | null;
}): Promise<void> {
  if (input.action === "approve" || input.action === "publish") {
    requireReady();
    if (input.action === "approve") {
      const db = createServiceRoleSupabase();
      const result = await db.from("lol_mayhem_champion_dataset_releases")
        .select("client_patch,upstream_version,source_data_date,capture_hash,manifest_path,catalog_hash,metadata")
        .eq("id", input.id).eq("status", "pending").abortSignal(signal()).single();
      if (result.error || !result.data) throw new Error("stats_review_conflict");
      const release = result.data;
      const manifest = await readVerifiedManifest(db, {
        captureHash: release.capture_hash, manifestPath: release.manifest_path, patch: release.client_patch,
        upstreamVersion: release.upstream_version, sourceDataDate: release.source_data_date, catalogHash: release.catalog_hash,
        metadata: release.metadata as ChampionDatasetManifest,
      });
      await verifyReleaseObjects(db, manifest);
    }
  }
  const { error } = await createServiceRoleSupabase().rpc("review_lol_mayhem_champion_dataset", {
    p_id: input.id, p_action: input.action, p_expected_publication: input.expectedPublication,
    p_reviewed_by: input.reviewedBy, p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.code === "PT409" ? "stats_review_conflict" : "stats_review_failed");
}

export async function getChampionDatasetAdmin(): Promise<ChampionDatasetAdminData> {
  const db = createServiceRoleSupabase();
  const [releases, publications, sync] = await Promise.all([
    db.from("lol_mayhem_champion_dataset_releases").select("id,status,client_patch,source_data_date,upstream_version,fetched_at,metadata")
      .order("id", { ascending: false }).limit(20).abortSignal(signal()),
    db.from("lol_mayhem_champion_dataset_publications").select("client_patch,release_id,previous_release_id,published_at").limit(100).abortSignal(signal()),
    db.from("lol_data_sync_status").select("job_key,last_checked_at,last_success_at,last_error_code,consecutive_failures,counts").limit(20).abortSignal(signal()),
  ]);
  if (releases.error || publications.error || sync.error) throw new Error("stats_database_error");
  return {
    releases: releases.data.map(row => ({ ...row, metadata: validManifest(row.metadata) })),
    publications: publications.data, sync: sync.data, readiness: getChampionDatasetReadiness(),
  } as ChampionDatasetAdminData;
}

const getPublication = unstable_cache(async (patch: string) => {
  const { data, error } = await createServiceRoleSupabase().from("lol_mayhem_champion_dataset_publications")
    .select("release_id,published_at").eq("source", CHAMPION_DATASET_SOURCE).eq("client_patch", patch).eq("cohort", CHAMPION_DATASET_COHORT)
    .abortSignal(signal()).maybeSingle();
  if (error) throw new Error("stats_database_error");
  return data;
}, ["lol-mayhem-champion-publication-v1"], { revalidate: 60, tags: [MAYHEM_CHAMPION_DATASET_TAG] });

const getPublishedStats = unstable_cache(async (releaseId: number, patch: string, championId: number): Promise<{ stats: ChampionStatsFile; attribution: string } | null> => {
  const db = createServiceRoleSupabase();
  const releaseResult = await db.from("lol_mayhem_champion_dataset_releases")
    .select("upstream_version,source_data_date,capture_hash,manifest_path,catalog_hash,metadata")
    .eq("id", releaseId).eq("client_patch", patch).eq("source", CHAMPION_DATASET_SOURCE).eq("cohort", CHAMPION_DATASET_COHORT).eq("status", "approved")
    .abortSignal(signal()).single();
  if (releaseResult.error || !releaseResult.data) throw new Error("stats_dataset_unavailable");
  const release = releaseResult.data;
  const manifest = await readVerifiedManifest(db, { captureHash: release.capture_hash, manifestPath: release.manifest_path,
    patch, upstreamVersion: release.upstream_version, sourceDataDate: release.source_data_date, catalogHash: release.catalog_hash,
    metadata: release.metadata as ChampionDatasetManifest });
  const file = manifest.files.find(row => row.championId === championId);
  if (!file) return null;
  const body = await readText(db, file.normalizedPath, CHAMPION_DATASET_MAX_FILE_BYTES);
  if (sha(body) !== file.normalizedHash || Buffer.byteLength(body) !== file.normalizedBytes) throw new Error("stats_snapshot_hash_mismatch");
  let stats: ChampionStatsFile;
  try { stats = validateChampionStatsFile(JSON.parse(body)); } catch { throw new Error("stats_snapshot_invalid"); }
  if (stats.championId !== championId || stats.clientPatch !== patch || stats.upstreamVersion !== release.upstream_version
    || stats.sourceDataDate !== release.source_data_date || stats.catalogHash !== release.catalog_hash) throw new Error("stats_snapshot_invalid");
  return { stats, attribution: manifest.attribution };
}, ["lol-mayhem-champion-stats-v1"], { revalidate: 3600 });

export async function getPublicChampionStats(patch: string, championId: number): Promise<PublicChampionStats | null> {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true" || !getChampionDatasetReadiness().reuseConfirmed) return null;
  const publication = await getPublication(patch);
  if (!publication) return null;
  const stats = await getPublishedStats(publication.release_id, patch, championId);
  return stats ? { ...stats.stats, attribution: stats.attribution, publishedAt: publication.published_at } : null;
}
