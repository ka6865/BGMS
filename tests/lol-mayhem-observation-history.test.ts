import { describe, expect, it } from 'vitest';
import { buildObservationHistory, observationLabel, observationPatches, type ObservationSnapshot } from '../lib/lol/mayhemObservationHistory';
import type { PublicChampionStats } from '../lib/lol/mayhemChampionDataset';

const stats = (patch: string, rows: Array<{ augmentPlatformId: number; reportedPickRate: string | null; reportedSampleCount?: number | null; rateSource?: string | null; rateRegion?: string | null; selectionEvidence?: 'reported_count' | 'reported_rate' | null }> = [], championId = 29): PublicChampionStats => ({
  schemaVersion: 1, source: 'champion_api_v1', clientPatch: patch, cohort: 'source_default', upstreamVersion: `${patch}.5`, sourceDataDate: '2026-11-01', fetchedAt: '2026-11-02T00:00:00Z', championId, catalogHash: 'a'.repeat(64), attribution: 'fixture', publishedAt: '2026-11-02T00:00:00Z',
  rows: rows.map(row => ({ augmentPlatformId: row.augmentPlatformId, reportedPickRate: row.reportedPickRate, reportedSampleCount: row.reportedSampleCount ?? null, rateSource: row.rateSource === undefined ? 'tencent' : row.rateSource, rateRegion: row.rateRegion === undefined ? 'CN' : row.rateRegion, countSource: row.reportedSampleCount == null ? null : (row.rateSource === undefined ? 'tencent' : row.rateSource), countRegion: row.reportedSampleCount == null ? null : (row.rateRegion === undefined ? 'CN' : row.rateRegion), countMeaning: row.reportedSampleCount == null ? null : 'source_reported_games', denominatorKind: 'unverified_source_definition', denominatorCount: null, selectionEvidence: row.selectionEvidence ?? (Number(row.reportedPickRate) > 0 ? 'reported_rate' : row.reportedSampleCount != null && row.reportedSampleCount > 0 ? 'reported_count' : null), offerEligibility: 'unknown' }))
});

const snap = (patch: string, kind: 'positive' | 'zero' | 'null' | 'missing' | 'error' = 'missing', augmentIds = [7], championId = 29): ObservationSnapshot => ({
  patch, augmentIds,
  dataset: kind === 'error' ? stats('16.99', [{ augmentPlatformId: 7, reportedPickRate: '0.2' }]) : stats(patch, kind === 'missing' ? [{ augmentPlatformId: 8, reportedPickRate: '0.2' }] : [{ augmentPlatformId: 7, reportedPickRate: kind === 'positive' ? '0.2' : kind === 'zero' ? '0' : null }], championId)
});

describe('증바람 챔피언 선택 관측 이력', () => {
  it('같은 major의 유효 패치 중 최근 네 개를 내림차순으로 반환한다', () => {
    expect(observationPatches('16.21')).toEqual(['16.21', '16.20', '16.19', '16.18']);
    expect(observationPatches('15.2')).toEqual(['15.2', '15.1']);
    for (const invalid of ['17.1', '16.0', '16.100', '16.01', '16.x']) expect(() => observationPatches(invalid)).toThrow();
  });

  it('마지막 세 패치 연속 미관측을 시작점과 함께 표시한다', () => {
    const history = buildObservationHistory('16.21', 29, [7], [snap('16.18', 'positive'), snap('16.19'), snap('16.20'), snap('16.21')]);
    expect(history.rows[0]).toEqual({ augmentPlatformId: 7, status: 'unobserved', missingSince: '16.19', consecutiveMissing: 3, lastObservedPatch: '16.18' });
    expect(observationLabel(history.rows[0])).toBe('26.19부터 3패치 연속 미관측');
  });

  it('현재 패치에서 다시 관측되면 누락 이력을 끝낸다', () => {
    const history = buildObservationHistory('16.21', 29, [7], [snap('16.18', 'positive'), snap('16.19'), snap('16.20'), snap('16.21', 'positive')]);
    expect(history.rows[0]).toMatchObject({ status: 'observed', missingSince: null, consecutiveMissing: 0, lastObservedPatch: '16.21' });
    expect(observationLabel(history.rows[0])).toBe('선택 관측');
  });

  it('한 패치만 있고 선택 근거가 없으면 과거를 단정하지 않고 자료 부족으로 둔다', () => {
    const history = buildObservationHistory('16.21', 29, [7], [snap('16.21')]);
    expect(history.rows[0]).toMatchObject({ status: 'insufficient', missingSince: null, consecutiveMissing: 0, lastObservedPatch: null });
    expect(observationLabel(history.rows[0])).toBe('자료 부족');
  });

  it('양의 관측 뒤 불명 패치가 끼면 연속 미관측 시작점을 단정하지 않는다', () => {
    const history = buildObservationHistory('16.21', 29, [7], [snap('16.18', 'positive'), snap('16.19', 'error'), snap('16.20'), snap('16.21')]);
    expect(history.rows[0]).toMatchObject({ status: 'insufficient', missingSince: null, consecutiveMissing: 0, lastObservedPatch: '16.18' });
    expect(observationLabel(history.rows[0])).toBe('자료 부족');
  });

  it('다른 출처·지역은 비교 불가로 표시한다', () => {
    const changed = snap('16.20', 'zero');
    changed.dataset!.rows[0].rateSource = 'iesdev';
    const history = buildObservationHistory('16.21', 29, [7], [changed, snap('16.21')]);
    expect(history.patches.find(p => p.patch === '16.20')?.available).toBe(false);
    expect(history.rows[0].status).toBe('insufficient');
    const world = snap('16.20', 'zero');
    world.dataset!.rows[0].rateRegion = 'WORLD';
    expect(buildObservationHistory('16.21', 29, [7], [world, snap('16.21')]).patches.find(p => p.patch === '16.20')?.available).toBe(false);
  });

  it('null 선택률은 불명, 0 선택률은 미관측으로 다룬다', () => {
    expect(buildObservationHistory('16.21', 29, [7], [snap('16.21', 'null')]).rows[0].status).toBe('insufficient');
    expect(buildObservationHistory('16.21', 29, [7], [snap('16.21', 'zero'),snap('16.20'),snap('16.19'),snap('16.18')]).rows[0].status).toBe('never_observed');
  });

  it('검증된 동일 모집단의 양의 reported_count도 관측 근거다', () => {
    const data = stats('16.21', [{ augmentPlatformId: 7, reportedPickRate: '0', reportedSampleCount: 12, selectionEvidence: 'reported_count' }]);
    expect(buildObservationHistory('16.21', 29, [7], [{ patch: '16.21', dataset: data, augmentIds: [7] }]).rows[0].status).toBe('observed');
  });

  it('현재 데이터의 출처 혼합은 모집단을 확정하지 않고 자료 부족으로 둔다', () => {
    const data = stats('16.21', [{ augmentPlatformId: 7, reportedPickRate: '0.2' }, { augmentPlatformId: 8, reportedPickRate: '0.1', rateSource: 'iesdev' }]);
    const history = buildObservationHistory('16.21', 29, [7], [{ patch: '16.21', dataset: data, augmentIds: [7] }]);
    expect(history.patches[0].available).toBe(false);
    expect(history.rows[0].status).toBe('insufficient');
  });

  it('다른 챔피언의 데이터와 현재 카탈로그에 없는 증강을 근거로 쓰지 않는다', () => {
    expect(buildObservationHistory('16.21', 29, [7], [snap('16.21', 'positive', [7], 30)]).rows[0].status).toBe('insufficient');
    expect(buildObservationHistory('16.21', 29, [7], [snap('16.21', 'positive', [])]).rows[0].status).toBe('insufficient');
  });

  it('같은 패치의 중복 스냅샷은 연속 미관측 패치 수를 부풀리지 않는다', () => {
    const history = buildObservationHistory('16.21', 29, [7], [snap('16.18', 'positive'), snap('16.19'), snap('16.19'), snap('16.20'), snap('16.21')]);
    expect(history.patches).toHaveLength(4);
    expect(history.rows[0]).toMatchObject({ status: 'unobserved', missingSince: '16.19', consecutiveMissing: 3 });
  });
  it('소수점0은 미관측이며 출처가 없는 양의 행은 같은 모집단으로 추측하지 않는다', () => {
    const zero=stats('16.21', [{augmentPlatformId:7,reportedPickRate:'0.000'}]);
    expect(buildObservationHistory('16.21',29,[7],[{patch:'16.21',dataset:zero,augmentIds:[7]},snap('16.20'),snap('16.19'),snap('16.18')]).rows[0].status).toBe('never_observed');
    const unknown=stats('16.21', [{augmentPlatformId:7,reportedPickRate:'0.2',rateSource:null,rateRegion:null},{augmentPlatformId:8,reportedPickRate:'0.1'}]);
    expect(buildObservationHistory('16.21',29,[7],[{patch:'16.21',dataset:unknown,augmentIds:[7]}]).rows[0].status).toBe('insufficient');
  });

  it('모든 비교 패치 자료를 확인하고도 한 번도 선택되지 않았을 때만 관측 이력 없음이다', () => {
    const history=buildObservationHistory('16.21',29,[7],['16.21','16.20','16.19','16.18'].map(patch=>snap(patch)));
    expect(history.rows[0]).toMatchObject({status:'never_observed',missingSince:null,lastObservedPatch:null});
    expect(observationLabel(history.rows[0])).toBe('관측 이력 없음');
    expect(buildObservationHistory('16.21',29,[7],[snap('16.21','zero'),snap('16.20'),snap('16.18')]).rows[0].status).toBe('insufficient');
  });

});
