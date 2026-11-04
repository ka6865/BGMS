import { validateChampionStatsFile, type PublicChampionStats } from './mayhemChampionDataset';

export type ObservationStatus = 'observed' | 'unobserved' | 'never_observed' | 'insufficient';
export type ObservationRow = { augmentPlatformId: number; status: ObservationStatus; missingSince: string | null; consecutiveMissing: number; lastObservedPatch: string | null };
export type ObservationSnapshot = { patch: string; dataset: PublicChampionStats | null; augmentIds: number[] };
export type ObservationHistory = { patch: string; patches: Array<{ patch: string; available: boolean }>; rows: ObservationRow[] };

type Cohort = { source: string; region: string };
type PatchObservation = 'observed' | 'unobserved' | 'unknown';

export function observationPatches(patch: string): string[] {
  const match = /^(15|16)\.([1-9][0-9]?)$/.exec(patch);
  if (!match) throw new Error('invalid_patch');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Array.from({ length: Math.min(minor, 4) }, (_, index) => `${major}.${minor - index}`);
}

function cohortOf(dataset: PublicChampionStats): Cohort | null {
  const pairs = new Map<string, Cohort>();
  for (const row of dataset.rows) {
    if (row.rateSource && row.rateRegion) pairs.set(`${row.rateSource}\0${row.rateRegion}`, { source: row.rateSource, region: row.rateRegion });
  }
  return pairs.size === 1 ? [...pairs.values()][0] : null;
}

function readDataset(snapshot: ObservationSnapshot, patch: string, championId: number): PublicChampionStats | null {
  if (snapshot.patch !== patch || !snapshot.dataset) return null;
  try {
    const dataset = validateChampionStatsFile(snapshot.dataset);
    return dataset.clientPatch === patch && dataset.championId === championId ? { ...dataset, attribution: snapshot.dataset.attribution, publishedAt: snapshot.dataset.publishedAt } : null;
  } catch {
    return null;
  }
}

function snapshotsByPatch(snapshots: ObservationSnapshot[]): Map<string, ObservationSnapshot> {
  const result = new Map<string, ObservationSnapshot>();
  for (const snapshot of snapshots) {
    const current = result.get(snapshot.patch);
    const time = snapshot.dataset && Date.parse(snapshot.dataset.publishedAt);
    const currentTime = current?.dataset && Date.parse(current.dataset.publishedAt);
    if (!current || (Number.isFinite(time) && (!Number.isFinite(currentTime) || time! > currentTime!))) result.set(snapshot.patch, snapshot);
  }
  return result;
}

function isObserved(row: PublicChampionStats['rows'][number]): boolean {
  return Number(row.reportedPickRate) > 0 || (row.reportedSampleCount !== null && row.reportedSampleCount > 0
    && row.selectionEvidence === 'reported_count' && row.countMeaning === 'source_reported_games'
    && row.countSource === row.rateSource && row.countRegion === row.rateRegion);
}

export function buildObservationHistory(patch: string, championId: number, augmentIds: number[], snapshots: ObservationSnapshot[]): ObservationHistory {
  const patches = observationPatches(patch);
  const byPatch = snapshotsByPatch(snapshots);
  const currentSnapshot = byPatch.get(patch);
  const currentData = currentSnapshot && readDataset(currentSnapshot, patch, championId);
  const cohort = currentData && cohortOf(currentData);
  const datasets = new Map<string, PublicChampionStats>();
  const available = new Map<string, boolean>();
  for (const item of patches) {
    const snapshot = byPatch.get(item);
    const dataset = snapshot && readDataset(snapshot, item, championId);
    const sameCohort = !!dataset && !!cohort && (() => {
      const candidate = cohortOf(dataset);
      return !!candidate && candidate.source === cohort.source && candidate.region === cohort.region;
    })();
    available.set(item, sameCohort);
    if (dataset && sameCohort) datasets.set(item, dataset);
  }

  const rows = [...new Set(augmentIds)].map(augmentPlatformId => {
    const observations: PatchObservation[] = patches.map(item => {
      const dataset = datasets.get(item);
      const snapshot = byPatch.get(item);
      if (!dataset || !snapshot || !snapshot.augmentIds.includes(augmentPlatformId)) return 'unknown';
      const row = dataset.rows.find(candidate => candidate.augmentPlatformId === augmentPlatformId);
      if (!row) return 'unobserved';
      if (row.rateSource !== cohort?.source || row.rateRegion !== cohort.region) return 'unknown';
      return isObserved(row) ? 'observed' : row.reportedPickRate !== null && Number(row.reportedPickRate) === 0 ? 'unobserved' : 'unknown';
    });
    const lastPositive = observations.findIndex(value => value === 'observed');
    if (observations[0] === 'observed') return { augmentPlatformId, status: 'observed', missingSince: null, consecutiveMissing: 0, lastObservedPatch: patch } satisfies ObservationRow;
    if (observations[0] !== 'unobserved') return { augmentPlatformId, status: 'insufficient', missingSince: null, consecutiveMissing: 0, lastObservedPatch: lastPositive < 0 ? null : patches[lastPositive] } satisfies ObservationRow;
    const priorPositive = observations.findIndex((value, index) => index > 0 && value === 'observed');
    if (priorPositive < 0) return { augmentPlatformId, status: observations.includes('unknown') ? 'insufficient' : 'never_observed', missingSince: null, consecutiveMissing: 0, lastObservedPatch: null } satisfies ObservationRow;
    if (observations.slice(0, priorPositive).includes('unknown')) return { augmentPlatformId, status: 'insufficient', missingSince: null, consecutiveMissing: 0, lastObservedPatch: patches[priorPositive] } satisfies ObservationRow;
    return { augmentPlatformId, status: 'unobserved', missingSince: patches[priorPositive - 1], consecutiveMissing: priorPositive, lastObservedPatch: patches[priorPositive] } satisfies ObservationRow;
  });

  return { patch, patches: patches.map(item => ({ patch: item, available: available.get(item) ?? false })), rows };
}

export function observationLabel(row: ObservationRow): string {
  if (row.status === 'observed') return '선택 관측';
  if (row.status === 'never_observed') return '관측 이력 없음';
  if (row.status === 'insufficient') return '자료 부족';
  const [major, minor] = (row.missingSince ?? '').split('.');
  return `${Number(major) === 16 ? 26 : 25}.${minor}부터 ${row.consecutiveMissing}패치 연속 미관측`;
}
