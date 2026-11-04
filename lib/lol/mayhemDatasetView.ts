export const MAYHEM_EXTERNAL_ID_PATTERN = /^[a-z0-9][a-z0-9_!-]{0,127}$/i;

export type MayhemDatasetRelease = {
  id: number; verified_client_patch: string; upstream_release_id: string; status: string; fetched_at: string;
  metadata: { unknown_count?: number; unknownExternalIds?: string[]; sourceStatsDate?: string | null; sourcePatch?: string; sourceClientPatch?: string; augments?: number; combos?: number };
};
export type MayhemDatasetAdminData = {
  releases: MayhemDatasetRelease[];
  publications: Array<{ client_patch: string; release_id: number; previous_release_id: number | null; published_at: string }>;
  mappings: Array<{ external_id: string; client_patch: string; platform_id: number; evidence: { note?: string }; status: string }>;
  augments: Array<{ platformId: number; name: string; patch: string }>;
  sync: Array<{ job_key: string; last_checked_at: string | null; last_success_at: string | null; last_error_code: string | null; consecutive_failures: number; counts: Record<string, unknown> }>;
};
export type PublicMayhemDataset = {
  patch: string; publishedAt: string; sourceStatsDate: string | null; sourcePatch: string | null; statsDateSource?: string | null;
  combos: Array<{ id: number; championId: number; augmentIds: number[]; types: string[]; sourceUrl: string }>;
  rates: Array<{ augmentId: number; pickRate: number | null; rank: number | null }>;
};
