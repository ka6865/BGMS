export const CHAMPION_DATASET_SOURCE = 'champion_api_v1' as const;
export const CHAMPION_DATASET_COHORT = 'source_default' as const;
export const CHAMPION_DATASET_PREFIX = 'external/champion-stats/champion_api_v1';
export const CHAMPION_DATASET_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const CHAMPION_DATASET_MAX_BATCH_BYTES = 64 * 1024 * 1024;
export type ChampionStatsRow = {
  augmentPlatformId: number; reportedPickRate: string | null; reportedSampleCount: number | null;
  rateSource: string | null; rateRegion: string | null; countSource: string | null; countRegion: string | null; countMeaning: string | null;
  denominatorKind: 'unverified_source_definition'; denominatorCount: null;
  selectionEvidence: 'reported_count' | 'reported_rate' | null; offerEligibility: 'unknown';
};
export type ChampionStatsFile = {
  schemaVersion: 1; source: typeof CHAMPION_DATASET_SOURCE; clientPatch: string; cohort: typeof CHAMPION_DATASET_COHORT;
  upstreamVersion: string; sourceDataDate: string; fetchedAt: string; championId: number; catalogHash: string; rows: ChampionStatsRow[];
};
export type PublicChampionStats = ChampionStatsFile & { attribution: string; publishedAt: string };
export type ChampionStatsContext = { clientPatch: string; championId: number; allowedAugmentIds: ReadonlySet<number>; upstreamVersion: string; sourceDataDate: string; fetchedAt: string; catalogHash: string };
export type ChampionManifestFile = { championId: number; rawPath: string; rawHash: string; rawBytes: number; normalizedPath: string; normalizedHash: string; normalizedBytes: number };
export type ChampionDatasetManifest = {
  schemaVersion: 1; source: typeof CHAMPION_DATASET_SOURCE; cohort: typeof CHAMPION_DATASET_COHORT; clientPatch: string;
  upstreamVersion: string; sourceDataDate: string; catalogHash: string; expectedChampionIds: number[];
  files: ChampionManifestFile[]; attribution: string; rightsBasis: string; normalizerVersion: 1;
};
export type ChampionCandidateInput = { clientPatch: string; upstreamVersion: string; sourceDataDate: string; captureHash: string; manifestPath: string; catalogHash: string; metadata: ChampionDatasetManifest; leaseToken: string };
export type ChampionDatasetReadiness = { apiKeyConfigured: boolean; reuseConfirmed: boolean; enabled: boolean; persistenceEnabled: boolean };
export type ChampionDatasetAdminData = {
  releases: Array<{ id: number; status: 'pending' | 'approved' | 'rejected'; client_patch: string; source_data_date: string; upstream_version: string; fetched_at: string; metadata: ChampionDatasetManifest }>;
  publications: Array<{ client_patch: string; release_id: number; previous_release_id: number | null; published_at: string }>;
  sync: Array<{ job_key: string; last_checked_at: string | null; last_success_at: string | null; last_error_code: string | null; consecutive_failures: number; counts: Record<string, unknown> }>;
  readiness: ChampionDatasetReadiness;
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_champion_stats');
  return v as Record<string, unknown>;
};
const id = (v: unknown): number => {
  if ((typeof v !== 'string' || !/^[1-9][0-9]{0,8}$/.test(v)) && (typeof v !== 'number' || !Number.isSafeInteger(v))) throw new Error('invalid_stats_id');
  const n = Number(v); if (n <= 0 || n > 999999999) throw new Error('invalid_stats_id'); return n;
};
const rate = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(v) || v.length > 32) throw new Error('invalid_pick_rate');
  return v;
};
const count = (v: unknown): number | null => {
  if (v === null) return null;
  if (!(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) && typeof v !== 'number') throw new Error('invalid_sample_count');
  const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid_sample_count'); return n;
};
const provenance = (v: unknown, allowed: string[]): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error('invalid_stats_provenance'); return v;
};
const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;

export function normalizeChampionAugments(input: unknown, context: ChampionStatsContext): ChampionStatsFile {
  if (!Array.isArray(input) || input.length !== 1 || !Array.isArray(input[0]) || input[0].length !== 4) throw new Error('invalid_champion_tuple');
  const [champion, stats, patch, date] = input[0];
  if (id(champion) !== context.championId || patch !== context.clientPatch || date !== context.sourceDataDate || typeof stats !== 'string') throw new Error('source_version_mismatch');
  let parsed: unknown; try { parsed = JSON.parse(stats); } catch { throw new Error('invalid_champion_json'); }
  const data = record(parsed); const augments = record(data.augments);
  const source = provenance(data.source, ['tencent','iesdev']); const region = provenance(data.region, ['CN','WORLD']);
  const rows = Object.entries(augments).map(([augmentId, raw]) => {
    const augmentPlatformId = id(augmentId); if (!context.allowedAugmentIds.has(augmentPlatformId)) throw new Error('unknown_augment');
    const row = record(raw); const reportedPickRate = rate(row.pick_rate); const reportedSampleCount = count(row.num_games);
    return { augmentPlatformId, reportedPickRate, reportedSampleCount, rateSource: source, rateRegion: region,
      countSource: reportedSampleCount === null ? null : source, countRegion: reportedSampleCount === null ? null : region,
      countMeaning: reportedSampleCount === null ? null : 'source_reported_games', denominatorKind: 'unverified_source_definition' as const, denominatorCount: null,
      selectionEvidence: reportedSampleCount !== null && reportedSampleCount > 0 ? 'reported_count' as const : Number(reportedPickRate) > 0 ? 'reported_rate' as const : null, offerEligibility: 'unknown' as const };
  }).sort((a,b) => a.augmentPlatformId - b.augmentPlatformId);
  return validateChampionStatsFile({ schemaVersion: 1, source: CHAMPION_DATASET_SOURCE, cohort: CHAMPION_DATASET_COHORT,
    clientPatch: context.clientPatch, upstreamVersion: context.upstreamVersion, sourceDataDate: context.sourceDataDate,
    fetchedAt: context.fetchedAt, championId: context.championId, catalogHash: context.catalogHash, rows });
}

export function validateChampionStatsFile(input: unknown): ChampionStatsFile {
  const data = record(input);
  if (data.schemaVersion !== 1 || data.source !== CHAMPION_DATASET_SOURCE || data.cohort !== CHAMPION_DATASET_COHORT
    || typeof data.clientPatch !== 'string' || !/^(15|16)\.[1-9][0-9]?$/.test(data.clientPatch)
    || typeof data.upstreamVersion !== 'string' || !data.upstreamVersion.startsWith(`${data.clientPatch}.`) || !/^\d+\.\d+\.\d+$/.test(data.upstreamVersion)
    || !validDate(data.sourceDataDate) || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))
    || typeof data.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.catalogHash)
    || !Array.isArray(data.rows) || data.rows.length > 1000) throw new Error('invalid_champion_stats');
  const seen = new Set<number>();
  const rows: ChampionStatsRow[] = data.rows.map(value => {
    const row = record(value); const augmentPlatformId = id(row.augmentPlatformId);
    if (seen.has(augmentPlatformId)) throw new Error('duplicate_augment'); seen.add(augmentPlatformId);
    const reportedPickRate = rate(row.reportedPickRate); const reportedSampleCount = count(row.reportedSampleCount);
    const rateSource = provenance(row.rateSource, ['tencent','iesdev']); const rateRegion = provenance(row.rateRegion, ['CN','WORLD']);
    const countSource = provenance(row.countSource, ['tencent','iesdev']); const countRegion = provenance(row.countRegion, ['CN','WORLD']);
    const selectionEvidence = reportedSampleCount !== null && reportedSampleCount > 0 ? 'reported_count' : Number(reportedPickRate) > 0 ? 'reported_rate' : null;
    if (row.denominatorKind !== 'unverified_source_definition' || row.denominatorCount !== null || row.offerEligibility !== 'unknown'
      || row.selectionEvidence !== selectionEvidence || (reportedSampleCount === null ? row.countMeaning !== null || countSource !== null || countRegion !== null
        : row.countMeaning !== 'source_reported_games' || countSource !== rateSource || countRegion !== rateRegion)) throw new Error('invalid_stats_provenance');
    return { augmentPlatformId, reportedPickRate, reportedSampleCount, rateSource, rateRegion, countSource, countRegion,
      countMeaning: reportedSampleCount === null ? null : 'source_reported_games', denominatorKind: 'unverified_source_definition', denominatorCount: null, selectionEvidence, offerEligibility: 'unknown' };
  });
  return { schemaVersion: 1, source: CHAMPION_DATASET_SOURCE, cohort: CHAMPION_DATASET_COHORT, clientPatch: data.clientPatch,
    upstreamVersion: data.upstreamVersion, sourceDataDate: data.sourceDataDate, fetchedAt: data.fetchedAt, championId: id(data.championId), catalogHash: data.catalogHash, rows };
}
