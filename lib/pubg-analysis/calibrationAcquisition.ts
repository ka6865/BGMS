import { assertHttpsHost, readJsonBodyWithinLimit } from '../../scripts/fetch_calculation_upgrade_raw_helpers';
import { isCanonicalMatchId, parseTelemetryPlatform, type TelemetryPlatform } from './telemetryIdentity';
import { hasMatchingTelemetryDefinition, parseOrdinaryTelemetryUrl, relationshipBoundTelemetryAsset } from './telemetrySource';
import { createSharedTelemetrySource, type SharedTelemetrySource } from './sharedTelemetrySourceContract';
import { isAiSummaryEligibleMatch } from './matchEligibility';

export type CalibrationAcquisition = {
  status: 'available' | 'unavailable' | 'rate_limited';
  stage: 'match' | 'telemetry';
  httpStatus: number;
  source?: SharedTelemetrySource;
  bytes: number;
  retryAfterSeconds?: number;
};

/** 공식 원본을 로컬 검증 자료로만 반환한다. DB/R2·애플리케이션 API는 호출하지 않는다. */
export async function fetchOfficialCalibrationSource(matchId: string, platform: TelemetryPlatform): Promise<CalibrationAcquisition> {
  if (!isCanonicalMatchId(matchId)) throw new Error('invalid_match_id');
  parseTelemetryPlatform(platform);
  const url = assertHttpsHost(`https://api.pubg.com/shards/${platform}/matches/${encodeURIComponent(matchId)}`, /^api\.pubg\.com$/i, 'match');
  const matchResponse = await fetch(url, { headers: { Accept: 'application/vnd.api+json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!matchResponse.ok) return unavailable(matchResponse, 'match');
  const { value: match, bytes: matchBytes } = await readJsonBodyWithinLimit(matchResponse, { maxBytes: 8 * 1024 * 1024, label: 'match' });
  if (match?.data?.id !== matchId || match.data.attributes?.shardId !== platform) throw new Error('match_identity_mismatch');
  if (!isAiSummaryEligibleMatch(match.data.attributes)) throw new Error('match_population_excluded');
  const binding = relationshipBoundTelemetryAsset(match);
  if (!binding) throw new Error('telemetry_asset_ambiguous');
  const telemetryUrl = parseOrdinaryTelemetryUrl((binding.asset.attributes as Record<string, unknown> | null)?.URL, binding.id);
  const response = await fetch(telemetryUrl, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return unavailable(response, 'telemetry');
  const { value: events, bytes } = await readJsonBodyWithinLimit(response, { maxBytes: 64 * 1024 * 1024, label: 'telemetry' });
  if (!hasMatchingTelemetryDefinition(events, matchId, platform)) throw new Error('telemetry_definition_mismatch');
  return { status: 'available', stage: 'telemetry', httpStatus: 200, bytes: matchBytes + bytes, source: createSharedTelemetrySource(match, platform, events) };
}

function unavailable(response: Response, stage: CalibrationAcquisition['stage']): CalibrationAcquisition {
  const retry = Number(response.headers.get('retry-after'));
  return { status: response.status === 429 ? 'rate_limited' : 'unavailable', stage, httpStatus: response.status, bytes: 0,
    ...(response.status === 429 ? { retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.min(3600, retry) : 60 } : {}) };
}
