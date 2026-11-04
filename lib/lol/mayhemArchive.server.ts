import "server-only";
import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { getMayhemDatasetPublication } from "./mayhemDatasetStore.server";
import { parseMayhemArchive } from "./mayhemArchive";

const payload = unstable_cache(async (id: number, patch: string) => {
  const db = createServiceRoleSupabase();
  const result = await db.from("lol_mayhem_dataset_releases").select("manifest_path,metadata,verified_client_patch").eq("id", id).eq("status", "approved").abortSignal(AbortSignal.timeout(10000)).single();
  if (result.error || !result.data || result.data.verified_client_patch !== patch) throw new Error("mayhem_archive_unavailable");
  const { metadata, manifest_path: path } = result.data;
  if (metadata.normalizerVersion !== 2 || typeof metadata.archiveHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.archiveHash)
    || typeof path !== "string" || !/^external\/arammayhem\/batches\/[a-f0-9]{64}\/captures\/[a-f0-9]{64}\/normalized\/(15|16)\.[1-9][0-9]?\/v2-m[1-9][0-9]*\.json$/.test(path)
    || !path.endsWith(`/normalized/${patch}/v2-m${metadata.mappingRevision}.json`)) throw new Error("mayhem_archive_unavailable");
  const file = await db.storage.from("lol-augment-snapshots").download(path);
  if (file.error || !file.data || file.data.size > 8 * 1024 * 1024) throw new Error("mayhem_archive_unavailable");
  const json = JSON.parse(await file.data.text()), archive = JSON.stringify(json.archive);
  if (typeof archive !== "string" || Buffer.byteLength(archive) > 4 * 1024 * 1024 || Buffer.byteLength(archive) !== metadata.archiveBytes
    || createHash("sha256").update(archive).digest("hex") !== metadata.archiveHash) throw new Error("mayhem_archive_integrity");
  return parseMayhemArchive(json.archive, patch);
}, ["lol-mayhem-reviewed-archive-v1"], { revalidate: 3600 });

export async function getPublicMayhemArchive(patch: string) {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return null;
  const publication = await getMayhemDatasetPublication(patch);
  return publication ? { archive: await payload(publication.release_id, patch), publishedAt: publication.published_at } : null;
}
