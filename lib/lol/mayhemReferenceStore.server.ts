import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { getLolChampions } from "./champions.server";
import { parseChampionTierSource } from "./mayhemChampionTiers";
import { parsePatchAugmentRanking } from "./mayhemPatchRankings";
import { normalizeItemRatingSnapshot } from "./mayhemReferenceSource.server";
import { filterMayhemItemComponents } from "./mayhemItems";
import { archiveClientPatch, compareReferencePatches, referencePath, REFERENCE_MAX_BYTES, REFERENCE_SOURCES,
  validReferenceKind, validReferencePatch, type ReferenceCandidate, type ReferenceKind, type ReferencePayloads,
  type ReferencePublication, type ReferenceRelease } from "./mayhemReference";

export const MAYHEM_REFERENCE_TAG = "lol-mayhem-references";
export const referencePersistenceEnabled = () => process.env.LOL_PERSISTENCE_ENABLED === "true" && process.env.LOL_MAYHEM_REFERENCE_DATASET_ENABLED === "true";
export const referencePublicEnabled = () => referencePersistenceEnabled() && process.env.LOL_MAYHEM_REFERENCE_PUBLIC_ENABLED === "true";
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const signal = () => AbortSignal.timeout(10_000);
const db = () => createServiceRoleSupabase((url, init) => fetch(url, { ...init,
  signal: init?.signal ? AbortSignal.any([init.signal, signal()]) : signal() }));
const failure = () => new Error("reference_snapshot_invalid");

export function normalizeReference<K extends ReferenceKind>(kind: K, raw: string, patch: string, championId: number): ReferencePayloads[K] {
  if (typeof raw !== "string" || Buffer.byteLength(raw) < 1 || Buffer.byteLength(raw) > REFERENCE_MAX_BYTES) throw failure();
  if (!validReferenceKind(kind) || !validReferencePatch(patch) || !Number.isSafeInteger(championId)
    || (kind === "item_ratings" ? championId < 1 || championId > 99999 : championId !== 0)) throw failure();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw failure(); }
  const payload = kind === "champion_tiers" ? parseChampionTierSource(value)
    : kind === "item_ratings" ? normalizeItemRatingSnapshot(value, championId)
    : parsePatchAugmentRanking(value, `${Number(patch.split(".")[0]) + 10}.${patch.split(".")[1]}`);
  if ((kind === "augment_rankings" ? archiveClientPatch(payload.patch) : payload.patch) !== patch) throw failure();
  return payload as ReferencePayloads[K];
}

function validRelease(row: ReferenceRelease) {
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || !validReferenceKind(row.kind)
    || row.source !== REFERENCE_SOURCES[row.kind] || !validReferencePatch(row.client_patch)
    || !Number.isSafeInteger(row.champion_id) || (row.kind === "item_ratings" ? row.champion_id < 1 || row.champion_id > 99999 : row.champion_id !== 0)
    || !/^[a-f0-9]{64}$/.test(row.raw_hash) || !/^[a-f0-9]{64}$/.test(row.normalized_hash)
    || row.raw_path !== referencePath(row.raw_hash) || row.normalized_path !== referencePath(row.normalized_hash)
    || [row.raw_bytes, row.normalized_bytes].some(size => !Number.isSafeInteger(size) || size < 1 || size > REFERENCE_MAX_BYTES)
    || !["pending", "approved", "rejected"].includes(row.status)
    || typeof row.attribution !== "string" || !row.attribution.trim() || row.attribution.length > 512
    || typeof row.rights_basis !== "string" || row.rights_basis.trim().length < 10 || row.rights_basis.length > 2048) throw failure();
  return row;
}

async function readObject(path: string, hash: string, bytes: number) {
  if (path !== referencePath(hash) || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > REFERENCE_MAX_BYTES) throw failure();
  const result = await db().storage.from("lol-augment-snapshots").download(path);
  if (result.error || !result.data || result.data.size !== bytes) throw failure();
  const body = await result.data.text();
  if (Buffer.byteLength(body) !== bytes || sha(body) !== hash) throw failure();
  return body;
}

async function verifiedPayload(row: ReferenceRelease) {
  validRelease(row);
  const [raw, body] = await Promise.all([readObject(row.raw_path, row.raw_hash, row.raw_bytes), readObject(row.normalized_path, row.normalized_hash, row.normalized_bytes)]);
  const payload = normalizeReference(row.kind, raw, row.client_patch, row.champion_id);
  if (!isDeepStrictEqual(payload, JSON.parse(body)) || payload.date !== row.source_data_date
    || (row.kind === "champion_tiers" && (payload as ReferencePayloads["champion_tiers"]).dataVersion !== row.upstream_version)) throw failure();
  return row.kind === "item_ratings" ? filterMayhemItemComponents(payload as ReferencePayloads["item_ratings"], JSON.parse(raw).dataDragon.metadata) : payload;
}

export async function saveReferenceSnapshot<K extends ReferenceKind>(input: {
  kind: K; raw: string; normalized: ReferencePayloads[K]; upstreamVersion: string; championId?: number;
  attribution: string; rightsBasis: string; leaseToken: string;
}): Promise<number> {
  if (!referencePersistenceEnabled()) throw new Error("reference_sync_disabled");
  const championId = input.championId ?? 0;
  const patch = input.kind === "augment_rankings" ? archiveClientPatch(input.normalized.patch) : input.normalized.patch;
  const parsed = normalizeReference(input.kind, input.raw, patch, championId);
  if (!isDeepStrictEqual(parsed, input.normalized) || input.attribution.trim().length < 1 || input.attribution.length > 512
    || input.rightsBasis.trim().length < 10 || input.rightsBasis.length > 2048
    || !input.upstreamVersion.trim() || input.upstreamVersion.length > 128) throw failure();
  const body = JSON.stringify(parsed);
  const candidate: ReferenceCandidate = { kind: input.kind, source: REFERENCE_SOURCES[input.kind], clientPatch: patch, championId,
    upstreamVersion: input.upstreamVersion, sourceDataDate: parsed.date, rawHash: sha(input.raw), normalizedHash: sha(body),
    rawPath: referencePath(sha(input.raw)), normalizedPath: referencePath(sha(body)), rawBytes: Buffer.byteLength(input.raw), normalizedBytes: Buffer.byteLength(body),
    attribution: input.attribution.trim(), rightsBasis: input.rightsBasis.trim() };
  if ([candidate.rawBytes, candidate.normalizedBytes].some(size => size < 1 || size > REFERENCE_MAX_BYTES)) throw failure();
  // 원본 수정 이력을 보존하고 원본·정규화본이 모두 같을 때만 기존 후보를 유지한다.
  const existing = await db().from("lol_mayhem_reference_releases").select("id").eq("kind", candidate.kind)
    .eq("client_patch", patch).eq("champion_id", championId).eq("raw_hash", candidate.rawHash).eq("normalized_hash", candidate.normalizedHash).abortSignal(signal()).maybeSingle();
  if (existing.error) throw new Error("reference_database_error");
  if (existing.data) return existing.data.id;
  for (const [path, text, hash, bytes] of [[candidate.rawPath, input.raw, candidate.rawHash, candidate.rawBytes], [candidate.normalizedPath, body, candidate.normalizedHash, candidate.normalizedBytes]] as const) {
    const upload = await db().storage.from("lol-augment-snapshots").upload(path, text, { contentType: "application/json", upsert: false });
    if (upload.error && await readObject(path, hash, bytes) !== text) throw new Error("reference_storage_error");
  }
  const result = await db().rpc("ingest_lol_mayhem_reference", { p_candidate: candidate, p_token: input.leaseToken }).abortSignal(signal());
  if (result.error || !Number.isSafeInteger(result.data) || Number(result.data) <= 0) throw new Error("reference_ingest_failed");
  return Number(result.data);
}

const publications = unstable_cache(async (kind: ReferenceKind, championId: number): Promise<ReferencePublication[]> => {
  const result = await db().from("lol_mayhem_reference_publications").select("kind,client_patch,champion_id,release_id,previous_release_id,published_at")
    .eq("kind", kind).eq("champion_id", championId).limit(101).abortSignal(signal());
  if (result.error || !result.data || result.data.length > 100 || result.data.some(row => row.kind !== kind || row.champion_id !== championId || !validReferencePatch(row.client_patch))) throw new Error("reference_database_error");
  return result.data.sort((a, b) => compareReferencePatches(a.client_patch, b.client_patch));
}, ["lol-mayhem-reference-publications-v1"], { revalidate: 60, tags: [MAYHEM_REFERENCE_TAG] });

const published = unstable_cache(async (id: number, kind: ReferenceKind, patch: string, championId: number) => {
  const result = await db().from("lol_mayhem_reference_releases").select("*").eq("id", id).eq("status", "approved").abortSignal(signal()).single();
  if (result.error || !result.data) throw new Error("reference_release_unavailable");
  const row = validRelease(result.data as ReferenceRelease);
  if (row.status !== "approved" || row.kind !== kind || row.client_patch !== patch || row.champion_id !== championId) throw failure();
  return { row, payload: await verifiedPayload(row) };
}, ["lol-mayhem-reference-payload-v2-no-components"], { revalidate: 3600 });

export async function getPublicReference<K extends ReferenceKind>(kind: K, patch?: string, championId = 0): Promise<ReferencePayloads[K] | null> {
  if (!referencePublicEnabled()) return null;
  if (kind === "champion_tiers" && process.env.LOL_MAYHEM_STATS_REUSE_CONFIRMED !== "true") return null;
  if (!validReferenceKind(kind) || (patch !== undefined && !validReferencePatch(patch)) || !Number.isSafeInteger(championId)
    || (kind === "item_ratings" ? championId < 1 || championId > 99999 : championId !== 0)) throw failure();
  const choices = await publications(kind, championId);
  const publication = patch ? choices.find(row => row.client_patch === patch) : choices[0];
  if (!publication) return null;
  const result = await published(publication.release_id, kind, publication.client_patch, championId);
  return result.payload as ReferencePayloads[K];
}

export async function getReferenceRankingPatches() {
  if (!referencePublicEnabled()) return [];
  return (await publications("augment_rankings", 0)).map(row => `${Number(row.client_patch.split(".")[0]) + 10}.${row.client_patch.split(".")[1]}`);
}

export async function getReferenceAdmin() {
  const enabled = referencePersistenceEnabled();
  const publicEnabled = referencePublicEnabled();
  const itemsEnabled = process.env.LOL_MAYHEM_ITEMS_ENABLED === "true";
  if (!enabled) return { enabled, publicEnabled, itemsEnabled, releases: [], publications: [], sync: [], champions: [], truncatedKinds: [] as ReferenceKind[] };
  const kinds = Object.keys(REFERENCE_SOURCES) as ReferenceKind[];
  const [releaseResults, sync, champions] = await Promise.all([
    Promise.all(kinds.map(kind => db().from("lol_mayhem_reference_releases").select("*").eq("kind", kind)
      .order("fetched_at", { ascending: false }).order("id", { ascending: false }).limit(500).abortSignal(signal()))),
    db().from("lol_data_sync_status").select("job_key,last_checked_at,last_success_at,last_error_code,consecutive_failures,counts").eq("job_key", "mayhem-reference").abortSignal(signal()),
    getLolChampions().catch(() => null),
  ]);
  if (releaseResults.some(result => result.error) || sync.error) throw new Error("reference_database_error");
  // shortcut: 종류별 최근 500개이며 관리자에서 전체 이력 탐색이 필요하면 커서 조회를 추가한다.
  const releases = releaseResults.flatMap(result => result.data ?? []).map(row => validRelease(row as ReferenceRelease))
    .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at) || b.id - a.id);
  const pointerResults = await Promise.all(kinds.map(async kind => {
    const patches = [...new Set(releases.filter(row => row.kind === kind).map(row => row.client_patch))];
    if (!patches.length) return { data: [], error: null };
    return db().from("lol_mayhem_reference_publications").select("*").eq("kind", kind).in("client_patch", patches).limit(1000).abortSignal(signal());
  }));
  if (pointerResults.some(result => result.error || result.data?.length === 1000)) throw new Error("reference_database_error");
  return { enabled, publicEnabled, itemsEnabled, releases, truncatedKinds: kinds.filter((_, index) => releaseResults[index].data?.length === 500), publications: pointerResults.flatMap(result => result.data ?? []), sync: sync.data ?? [],
    champions: champions?.champions.map(champion => ({ id: champion.id, name: champion.name })) ?? [] };
}

async function release(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw failure();
  const result = await db().from("lol_mayhem_reference_releases").select("*").eq("id", id).abortSignal(signal()).single();
  if (result.error || !result.data) throw new Error("reference_release_unavailable");
  return validRelease(result.data as ReferenceRelease);
}

export async function getReferenceFile(id: number, kind: "raw" | "normalized") {
  if (!referencePersistenceEnabled()) throw new Error("reference_sync_disabled");
  const row = await release(id);
  await verifiedPayload(row);
  return kind === "raw" ? readObject(row.raw_path, row.raw_hash, row.raw_bytes) : readObject(row.normalized_path, row.normalized_hash, row.normalized_bytes);
}

export async function reviewReference(input: { id: number; action: "approve" | "reject" | "publish" | "rollback"; expectedPublication: number | null; reviewedBy: string; reason: string | null }) {
  if (!referencePersistenceEnabled()) throw new Error("reference_sync_disabled");
  const row = await release(input.id);
  if (input.action === "approve" || input.action === "publish") {
    if (row.kind === "champion_tiers" && process.env.LOL_MAYHEM_STATS_REUSE_CONFIRMED !== "true") throw new Error("reference_reuse_unconfirmed");
    await verifiedPayload(row);
  }
  const result = await db().rpc("review_lol_mayhem_reference", { p_id: input.id, p_action: input.action, p_expected_publication: input.expectedPublication,
    p_reviewed_by: input.reviewedBy, p_reason: input.reason }).abortSignal(signal());
  if (result.error) throw new Error(result.error.code === "PT409" ? "reference_publication_conflict" : "reference_review_failed");
}
