import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import type { MayhemDatasetAdminData, MayhemDatasetRelease, PublicMayhemDataset } from "./mayhemDatasetView";
import { getCachedLolAugmentCatalog } from "./augments/catalog.server";
import { mappingSources, type MappingPreview } from "./mayhemMappingReview";

export const MAYHEM_DATASET_TAG = "lol-mayhem-dataset";
const signal = () => AbortSignal.timeout(10_000);

export async function getMayhemDatasetAdmin(): Promise<MayhemDatasetAdminData> {
  const db = createServiceRoleSupabase();
  const [releases, publications, mappings, sync, texts, states] = await Promise.all([
    db.from("lol_mayhem_dataset_releases").select("id,verified_client_patch,upstream_release_id,status,fetched_at,metadata").order("id", { ascending: false }).limit(20).abortSignal(signal()),
    db.from("lol_mayhem_dataset_publications").select("client_patch,release_id,previous_release_id,published_at").limit(100).abortSignal(signal()),
    db.from("lol_mayhem_augment_mappings").select("external_id,client_patch,platform_id,evidence,status").order("reviewed_at", { ascending: false }).limit(1000).abortSignal(signal()),
    db.from("lol_data_sync_status").select("job_key,last_checked_at,last_success_at,last_error_code,consecutive_failures,counts").limit(20).abortSignal(signal()),
    db.from("lol_augment_localizations").select("platform_id,client_patch,name").eq("locale", "ko_kr").limit(1000).abortSignal(signal()),
    db.from("lol_augment_patch_states").select("platform_id,client_patch").eq("in_pool", true).eq("enabled", true).eq("is_internal", false).limit(1000).abortSignal(signal()),
  ]);
  if ([releases, publications, mappings, sync, texts, states].some(result => result.error)) throw new Error("dataset_database_error");
  if (texts.data!.length >= 1000 || states.data!.length >= 1000 || mappings.data!.length >= 1000) throw new Error("dataset_admin_too_large");
  const active = new Set(states.data!.map(row => `${row.client_patch}:${row.platform_id}`));
  return {
    releases: releases.data!.map(row => ({ ...row, metadata: {
      unknown_count: row.metadata?.unknown_count, unknownExternalIds: row.metadata?.unknownExternalIds,
      sourceStatsDate: row.metadata?.sourceStatsDate, sourcePatch: row.metadata?.sourcePatch, sourceClientPatch: row.metadata?.sourceClientPatch, augments: row.metadata?.augments, combos: row.metadata?.combos, archiveSummary: row.metadata?.archiveSummary,
    } })) as MayhemDatasetRelease[],
    publications: publications.data!, mappings: mappings.data!, sync: sync.data!,
    augments: texts.data!.filter(row => active.has(`${row.client_patch}:${row.platform_id}`)).map(row => ({ platformId: row.platform_id, name: row.name ?? `증강 ${row.platform_id}`, patch: row.client_patch })),
  };
}

export async function getMayhemSnapshotFile(id: number, kind: "augments" | "combos") {
  const db = createServiceRoleSupabase();
  const release = await db.from("lol_mayhem_dataset_releases").select("metadata").eq("id", id).abortSignal(signal()).single();
  const path: unknown = release.data?.metadata?.rawManifestPath;
  if (release.error || typeof path !== "string" || !/^external\/arammayhem\/batches\/[a-f0-9]{64}\/captures\/[a-f0-9]{64}\/manifest\.json$/.test(path)) throw new Error("invalid_manifest");
  const bucket = db.storage.from("lol-augment-snapshots");
  const manifest = await bucket.download(path);
  if (manifest.error || manifest.data.size > 4 * 1024 * 1024) throw new Error("invalid_manifest");
  const json = JSON.parse(await manifest.data.text());
  const filePath: unknown = json.files?.[kind]?.path;
  if (typeof filePath !== "string" || !/^external\/arammayhem\/objects\/[a-f0-9]{64}\.json$/.test(filePath)) throw new Error("invalid_manifest");
  const file = await bucket.download(filePath);
  if (file.error || file.data.size > 4 * 1024 * 1024) throw new Error("invalid_snapshot");
  return file.data.text();
}

export async function getMayhemMappingPreview(id: number): Promise<MappingPreview> {
  const data = await getMayhemDatasetAdmin();
  const release = data.releases.find(row => row.id === id);
  if (!release) throw new Error("mapping_release_unavailable");
  if (release.metadata.unknown_count && !Array.isArray(release.metadata.unknownExternalIds)) throw new Error("mapping_ids_unavailable");
  const patches = [...new Set([release.verified_client_patch, release.metadata.sourceClientPatch].filter((patch): patch is string => !!patch))];
  const [augments, combos, catalogs] = await Promise.all([
    getMayhemSnapshotFile(id, "augments"), getMayhemSnapshotFile(id, "combos"),
    Promise.all(patches.map(async patch => ({ patch, catalog: await getCachedLolAugmentCatalog(patch) }))),
  ]);
  const sources = mappingSources(JSON.parse(augments), JSON.parse(combos), release.metadata.unknownExternalIds ?? [], release.upstream_release_id);
  return {
    releaseId: id, sources,
    patches: catalogs.map(({ patch, catalog }) => ({ patch, purpose: patches.length === 1 ? "선택률·추천 조합" : patch === release.verified_client_patch ? "추천 조합" : "전체 선택률",
      externalIds: sources.filter(row => patches.length === 1 || !row.uses.length || row.uses.includes(patch === release.verified_client_patch ? "combos" : "rates")).map(row => row.externalId), augments: catalog?.view.augments ?? [] })),
    mappings: data.mappings.map(({ external_id, client_patch, platform_id, status }) => ({ external_id, client_patch, platform_id, status })),
  };
}

export const getMayhemDatasetPublication = unstable_cache(async (patch: string) => {
  const { data, error } = await createServiceRoleSupabase().from("lol_mayhem_dataset_publications")
    .select("release_id,published_at").eq("source", "arammayhem").eq("client_patch", patch).abortSignal(signal()).maybeSingle();
  if (error) throw new Error("dataset_database_error");
  return data;
}, ["lol-mayhem-publication-v1"], { revalidate: 60, tags: [MAYHEM_DATASET_TAG] });

const getPayload = unstable_cache(async (id: number) => {
  const db = createServiceRoleSupabase();
  const [release, rates] = await Promise.all([
    db.from("lol_mayhem_dataset_releases").select("metadata").eq("id", id).eq("status", "approved").abortSignal(signal()).single(),
    db.from("lol_mayhem_augment_pick_rates").select("platform_id,pick_rate,pick_rate_rank").eq("release_id", id).order("pick_rate", { ascending: false, nullsFirst: false }).limit(1000).abortSignal(signal()),
  ]);
  if (release.error || rates.error || rates.data.length >= 1000) throw new Error("dataset_unavailable");
  const combos: Array<{ external_combo_id: number; champion_id: number; editorial_tags: string[]; source_url: string }> = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const result = await db.from("lol_mayhem_combos").select("external_combo_id,champion_id,editorial_tags,source_url")
      .eq("release_id", id).order("external_combo_id").range(offset, offset + 999).abortSignal(signal());
    if (result.error) throw new Error("dataset_unavailable");
    combos.push(...result.data);
    if (result.data.length < 1000) break;
    if (offset === 9000) throw new Error("dataset_too_large");
  }
  const members: Array<{ external_combo_id: number; platform_id: number; position: number }> = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const result = await db.from("lol_mayhem_combo_augments").select("external_combo_id,platform_id,position")
      .eq("release_id", id).order("external_combo_id").order("position").range(offset, offset + 999).abortSignal(signal());
    if (result.error) throw new Error("dataset_unavailable");
    members.push(...result.data);
    if (result.data.length < 1000) break;
    if (offset === 49000) throw new Error("dataset_too_large");
  }
  const byCombo = new Map<number, number[]>();
  for (const member of members) {
    const ids = byCombo.get(member.external_combo_id) ?? [];
    ids.push(member.platform_id); byCombo.set(member.external_combo_id, ids);
  }
  return { archiveAvailable: release.data.metadata.normalizerVersion >= 2 && /^[a-f0-9]{64}$/.test(release.data.metadata.archiveHash ?? ""), sourceStatsDate: release.data.metadata.sourceStatsDate ?? null, sourcePatch: release.data.metadata.sourcePatch ?? null, statsDateSource: release.data.metadata.statsDateSource ?? null,
    rates: rates.data.map(row => ({ augmentId: row.platform_id, pickRate: row.pick_rate === null ? null : Number(row.pick_rate), rank: row.pick_rate_rank })),
    combos: combos.map(row => {
      if (!/^https:\/\/arammayhem\.com\//.test(row.source_url) || !byCombo.get(row.external_combo_id)?.length) throw new Error("dataset_invalid_combo");
      return { id: row.external_combo_id, championId: row.champion_id, augmentIds: byCombo.get(row.external_combo_id)!, types: row.editorial_tags, sourceUrl: row.source_url };
    }) };
}, ["lol-mayhem-payload-v1"], { revalidate: 3600 });

export async function getPublicMayhemDataset(patch: string): Promise<PublicMayhemDataset | null> {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return null;
  const publication = await getMayhemDatasetPublication(patch);
  if (!publication) return null;
  return { patch, publishedAt: publication.published_at, ...await getPayload(publication.release_id) };
}
