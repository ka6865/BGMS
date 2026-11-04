import type { MayhemChampionTiers } from "./mayhemChampionTiers";
import type { MayhemItemRatings } from "./mayhemItems";
import type { MayhemPatchRanking } from "./mayhemPatchRankings";

export type ReferenceKind = "champion_tiers" | "item_ratings" | "augment_rankings";
export type ReferencePayloads = { champion_tiers: MayhemChampionTiers; item_ratings: MayhemItemRatings; augment_rankings: MayhemPatchRanking };
export type ReferenceCandidate = {
  kind: ReferenceKind; source: "aramgg" | "iesdev" | "arammayhem"; clientPatch: string; championId: number;
  upstreamVersion: string; sourceDataDate: string; rawHash: string; normalizedHash: string;
  rawPath: string; normalizedPath: string; rawBytes: number; normalizedBytes: number; attribution: string; rightsBasis: string;
};
export type ReferenceRelease = {
  id: number; kind: ReferenceKind; source: ReferenceCandidate["source"]; client_patch: string; champion_id: number;
  upstream_version: string; source_data_date: string; raw_hash: string; normalized_hash: string;
  raw_path: string; normalized_path: string; raw_bytes: number; normalized_bytes: number; attribution: string; rights_basis: string;
  status: "pending" | "approved" | "rejected"; fetched_at: string; reviewed_at: string | null;
};
export type ReferencePublication = { kind: ReferenceKind; client_patch: string; champion_id: number; release_id: number;
  previous_release_id: number | null; published_at: string };
export const REFERENCE_PREFIX = "external/mayhem-reference";
export const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
export const REFERENCE_SOURCES = { champion_tiers: "aramgg", item_ratings: "iesdev", augment_rankings: "arammayhem" } as const;
export const validReferenceKind = (value: unknown): value is ReferenceKind => typeof value === "string" && Object.hasOwn(REFERENCE_SOURCES, value);
export const validReferencePatch = (value: unknown): value is string => typeof value === "string" && /^(15|16)\.[1-9][0-9]?$/.test(value);
export const referencePath = (hash: string) => `${REFERENCE_PREFIX}/objects/${hash}.json`;
export function archiveClientPatch(patch: string): string {
  if (!/^(25|26)\.[1-9][0-9]?$/.test(patch)) throw new Error("reference_patch_invalid");
  return `${Number(patch.split(".")[0]) - 10}.${patch.split(".")[1]}`;
}
export const compareReferencePatches = (a: string, b: string) => {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  return bb[0] - aa[0] || bb[1] - aa[1];
};
