import { createHash } from 'node:crypto';
import { buildRetainedPerformanceRow, type RetainedPerformanceRow } from '../pubg/retainedPerformance';
import { AnalysisEngine } from './AnalysisEngine';
import { MAP_NAMES } from './constants';
import { normalizeName } from './utils';
import { projectTelemetryEvent } from './telemetryContract';

export type LegacyRetentionBasic = {
  account_id: string | null;
  player_id: string;
  platform: string;
  match_id: string;
  played_at: string;
  game_mode: string;
  map_name: string;
  kills: number;
  damage: number;
  win_place: number;
  match_type: string;
};

type IdentityScope = { matchId: string; platform: string; playerId: string };
type LegacyEventSource = {
  matchId: string;
  platform: string;
  legacyKey: string;
  requestedLegacyKey: string;
  verification: 'parent-exact-key' | 'verified-nickname';
  verifiedNickname?: string;
  artifactSha256: string;
  events: unknown[];
};

export type LegacyTeamRecoveryInput = {
  targetBasic: LegacyRetentionBasic;
  targetHasPersonalAnalysis: false;
  sourceBasic: LegacyRetentionBasic;
  sourceIdentity: IdentityScope;
  sourceFullResult: unknown;
  eventSource: LegacyEventSource;
};

export type LegacyTeamRecoveryEvidence = {
  sourceScope: IdentityScope;
  legacyKey: string;
  verification: LegacyEventSource['verification'];
  rawArtifactSha256: string;
  sourceFullResultSha256: string;
  sourceMatchId: string;
  sourcePlayerId: string;
  observedPlayers: number;
  officialPlayers: number;
  observedTeams: number;
  officialTeams: number;
  observedTeamId: number;
  telemetryFilter: 'current-allowlist-projection';
  cohortEvidence: 'LogPlayerCreate exact official lobby counts' | 'LogPlayerCreate ∩ LogMatchEnd.allWeaponStats.accountId'
    | 'LogMatchEnd.characters exact official lobby counts';
  unavailableEvidence: ['full-lobby-damage-rank', 'opponent-official-stats', 'LogPlayerAttack'];
  compatibility?: {
    metadataSource: 'verified-legacy-event-interval';
    startedAt: string;
    endedAt: string;
    duration: number;
  };
};

export type LegacyTeamRecoveryResult = {
  fullResult: Record<string, any>;
  compact: Omit<RetainedPerformanceRow['summary'], 'benchmark'> & { benchmark: null;
    retentionRecoveryEvidence: LegacyTeamRecoveryEvidence; retentionRecoveryContext: string };
  expectedBasic: LegacyRetentionBasic;
  evidence: LegacyTeamRecoveryEvidence;
  writeCandidate: {
    identity: { platform: string; match_id: string; player_id: string; account_id: string };
    calculation_version: number;
    result_version: number;
    summary_version: number;
    source_checksum: string;
  };
};

type Dict = Record<string, any>;
const ACCOUNT_ID = /^account\.[A-Za-z0-9_-]+$/;
const LOBBY_PLAYER_ID = /^(?:account|ai)\.[A-Za-z0-9_-]+$/;
const HASH = /^[a-f0-9]{64}$/i;
const KNOWN_NUMERIC_STATS = new Set([
  'kills', 'damageDealt', 'winPlace', 'timeSurvived', 'assists', 'DBNOs', 'headshotKills',
  'longestKill', 'heals', 'boosts', 'walkDistance', 'rideDistance', 'swimDistance', 'revives',
]);
const COPIED_OFFICIAL_NUMERIC_STATS = [
  'kills', 'damageDealt', 'winPlace', 'timeSurvived', 'assists', 'DBNOs', 'headshotKills',
  'longestKill', 'heals', 'boosts', 'walkDistance', 'rideDistance', 'swimDistance', 'revives',
] as const;
const UI_MAP_ALIASES: Record<string, string> = { erangel: 'Baltic_Main', miramar: 'Desert_Main', sanhok: 'Savage_Main', taego: 'Tiger_Main', vikendi: 'DihorOtok_Main', rondo: 'Neon_Main', deston: 'Kiki_Main', karakin: 'Summerland_Main', paramo: 'Chimera_Main' };
const RECOVERABLE_MATCH_TYPES = new Set(['official', 'competitive', 'custom', 'event', 'seasonal', 'airoyale', 'training']);

function record(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validBasic(value: unknown): value is LegacyRetentionBasic {
  if (!record(value) || typeof value.player_id !== 'string' || !value.player_id.trim()
    || typeof value.match_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.match_id) || !['steam', 'kakao'].includes(value.platform)
    || typeof value.played_at !== 'string' || !Number.isFinite(Date.parse(value.played_at))
    || typeof value.game_mode !== 'string' || !value.game_mode.trim() || typeof value.map_name !== 'string' || !value.map_name.trim()
    || typeof value.match_type !== 'string'
    || ![value.kills, value.damage, value.win_place].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    || !Number.isInteger(value.kills) || !Number.isInteger(value.damage) || !Number.isInteger(value.win_place)
    || value.win_place < 1 || !(value.account_id === null || (typeof value.account_id === 'string' && ACCOUNT_ID.test(value.account_id)))) return false;
  return true;
}
function sameInstant(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
}
function mapIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().toLowerCase();
  if (UI_MAP_ALIASES[normalized]) return MAP_NAMES[UI_MAP_ALIASES[normalized]].toLowerCase();
  const alias = Object.entries(MAP_NAMES).find(([key, label]) => key.toLowerCase() === normalized || label.toLowerCase() === normalized)?.[1];
  return (alias ?? normalized).toLowerCase();
}
function matchingMap(basicName: string, ...metadata: unknown[]): boolean {
  const basic = mapIdentity(basicName);
  return basic !== null && metadata.some(item => mapIdentity(item) === basic)
    && metadata.filter(item => item !== undefined && item !== null).every(item => mapIdentity(item) === basic);
}
function validOfficialStats(value: unknown): value is Dict {
  if (!record(value) || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.playerId !== 'string' || !ACCOUNT_ID.test(value.playerId)) return false;
  for (const key of ['kills', 'damageDealt', 'winPlace', 'timeSurvived']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) return false;
  }
  if (value.winPlace < 1) return false;
  for (const [key, field] of Object.entries(value)) {
    if (field === null) return false;
    if (KNOWN_NUMERIC_STATS.has(key) && (typeof field !== 'number' || !Number.isFinite(field) || field < 0)) return false;
    if (typeof field === 'number' && (!Number.isFinite(field) || field < 0)) return false;
  }
  return true;
}
function copyOfficialStats(value: Dict): Dict {
  const copied: Dict = { name: value.name, playerId: value.playerId };
  for (const key of COPIED_OFFICIAL_NUMERIC_STATS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) copied[key] = value[key];
  }
  if (typeof value.deathType === 'string') copied.deathType = value.deathType;
  return copied;
}

// An old projection does not prove that an absent action happened zero times.
// Preserve official zeroes, but leave unobserved derived metrics unavailable.
function omitUnobservedDefaults(value: unknown): unknown {
  if (value === 0 || value === false) return null;
  if (Array.isArray(value)) return value.map(omitUnobservedDefaults);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, omitUnobservedDefaults(item)]));
  return value;
}
type SourceMetadata = { date: string; duration: number; mapId: string; gameMode: string; matchType: string;
  compatibility?: NonNullable<LegacyTeamRecoveryEvidence['compatibility']> };
function sourceMetadata(full: Dict, basic: LegacyRetentionBasic, rawEvents: unknown[]): SourceMetadata | null {
  const date = full.createdAt;
  const gameMode = full.gameMode;
  const matchType = full.matchType;
  const mapId = Object.keys(MAP_NAMES).find(key => mapIdentity(key) === mapIdentity(basic.map_name));
  if (!mapId) return null;
  if (!Object.prototype.hasOwnProperty.call(full, 'matchInfo')) {
    if (typeof matchType !== 'string' || !RECOVERABLE_MATCH_TYPES.has(matchType)
      || typeof gameMode !== 'string' || !sameInstant(date, basic.played_at) || gameMode !== basic.game_mode
      || basic.match_type !== matchType || !matchingMap(basic.map_name, full.mapName) || !Array.isArray(rawEvents)) return null;
    const starts = rawEvents.filter((event): event is Dict => record(event) && event._T === 'LogMatchStart');
    const ends = rawEvents.filter((event): event is Dict => record(event) && event._T === 'LogMatchEnd');
    if (starts.length !== 1 || ends.length !== 1 || typeof starts[0]._D !== 'string' || typeof ends[0]._D !== 'string') return null;
    const startedAt = Date.parse(starts[0]._D), endedAt = Date.parse(ends[0]._D), officialAt = Date.parse(date);
    const duration = (endedAt - startedAt) / 1000;
    if (![startedAt, endedAt, officialAt, duration].every(Number.isFinite) || Math.abs(startedAt - officialAt) > 60_000
      || duration < 1 || duration > 7200 || !Array.isArray(full.team)
      || full.team.some(stat => !record(stat) || typeof stat.timeSurvived !== 'number'
        || !Number.isFinite(stat.timeSurvived) || stat.timeSurvived < 0 || stat.timeSurvived > duration + 60)) return null;
    const rawStart = starts[0] as Dict;
    const startMaps = ['mapName', 'map', 'mapId'].filter(key => Object.prototype.hasOwnProperty.call(rawStart, key))
      .map(key => rawStart[key]);
    if (startMaps.some(startMap => mapIdentity(startMap) !== mapIdentity(full.mapName))) return null;
    return { date, duration, mapId, gameMode, matchType, compatibility: {
      metadataSource: 'verified-legacy-event-interval',
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), duration,
    } };
  }
  const info = full.matchInfo;
  if (!record(info) || Array.isArray(info)) return null;
  const infoDate = info.date;
  const infoMode = info.mode;
  const infoType = info.matchType;
  if (typeof matchType !== 'string' || !RECOVERABLE_MATCH_TYPES.has(matchType)
    || typeof gameMode !== 'string' || typeof infoMode !== 'string' || gameMode !== infoMode
    || (infoType !== undefined && (typeof infoType !== 'string' || infoType !== matchType))
    || (infoDate !== undefined && !sameInstant(infoDate, date))
    || !sameInstant(date, basic.played_at) || gameMode !== basic.game_mode
    || basic.match_type !== matchType || typeof info.duration !== 'number' || !Number.isFinite(info.duration) || info.duration <= 0) return null;
  const secondaryMap = info.map ?? info.mapName;
  if (!matchingMap(basic.map_name, full.mapName, secondaryMap)) return null;
  // The legacy route generated UI mapId='erangel' when matchAttr.mapId was absent.
  // That derived default is not official map evidence; the root map and basic row are.
  const legacyUiDefault = info.mapId === 'erangel' && info.map === undefined && info.mapName === undefined;
  if (!legacyUiDefault && info.mapId != null && !matchingMap(basic.map_name, info.mapId)) return null;
  return { date, duration: info.duration, mapId, gameMode, matchType };
}
function sourceResultMatchesBasic(full: Dict, basic: LegacyRetentionBasic): boolean {
  const stats = full.stats;
  if (!validOfficialStats(stats) || !sameInstant(full.createdAt, basic.played_at)
    || stats.kills !== basic.kills || Math.floor(stats.damageDealt) !== basic.damage || stats.winPlace !== basic.win_place
    || normalizeName(stats.name) !== normalizeName(basic.player_id)
    || basic.account_id !== stats.playerId) return false;
  return true;
}
function makeRosterEvidence(input: LegacyTeamRecoveryInput, officialTeam: Dict[], sourceDate: string, duration: number) {
  const events = input.eventSource.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 100_000) return null;
  const projected = events.map(projectTelemetryEvent);
  if (projected.some(event => event === null)) return null;
  const safeEvents = projected as Dict[];
  const starts = safeEvents.filter(event => event._T === 'LogMatchStart');
  const ends = safeEvents.filter(event => event._T === 'LogMatchEnd');
  if (starts.length !== 1 || ends.length !== 1 || typeof starts[0]._D !== 'string' || typeof ends[0]._D !== 'string') return null;
  const startedAt = Date.parse(starts[0]._D), endedAt = Date.parse(ends[0]._D), officialAt = Date.parse(sourceDate);
  if (![startedAt, endedAt, officialAt].every(Number.isFinite) || Math.abs(startedAt - officialAt) > 60_000
    || endedAt <= startedAt || endedAt - startedAt > (duration + 300) * 1000) return null;
  const characters = new Map<string, { accountId: string; name: string; teamId: number }>();
  const names = new Map<string, string>();
  for (const event of safeEvents.filter(item => item._T === 'LogPlayerCreate')) {
    const character = event.character;
    if (!record(character) || typeof character.accountId !== 'string' || !LOBBY_PLAYER_ID.test(character.accountId)
      || typeof character.name !== 'string' || !character.name.trim() || !Number.isInteger(character.teamId)) continue;
    const row = { accountId: character.accountId, name: character.name, teamId: character.teamId as number };
    const previous = characters.get(row.accountId);
    if (previous && (previous.name !== row.name || previous.teamId !== row.teamId)) return null;
    const normalized = normalizeName(row.name);
    const accountForName = names.get(normalized);
    if (accountForName && accountForName !== row.accountId) return null;
    characters.set(row.accountId, row);
    names.set(normalized, row.accountId);
  }
  const source = input.sourceFullResult as Dict;
  if (!record(source) || !Number.isInteger(source.totalPlayers) || !Number.isInteger(source.totalTeams)
    || source.totalPlayers < 1 || source.totalTeams < 1) return null;
  const groupTeams = (cohort: Array<{ accountId: string; name: string; teamId: number }>) => {
    const grouped = new Map<number, typeof cohort>();
    for (const character of cohort) {
      const team = grouped.get(character.teamId) ?? [];
      team.push(character);
      grouped.set(character.teamId, team);
    }
    return grouped;
  };
  const allCharacters = [...characters.values()];
  const allCharacterTeams = groupTeams(allCharacters);
  let cohort = allCharacters;
  let teams = allCharacterTeams;
  let cohortEvidence: LegacyTeamRecoveryEvidence['cohortEvidence'] = 'LogPlayerCreate exact official lobby counts';
  if (Array.isArray(ends[0].characters)) {
    const finishedIds = new Set<string>();
    const finished = [] as typeof allCharacters;
    for (const entry of ends[0].characters) {
      const character = record(entry) && record(entry.character) ? entry.character : entry;
      if (!record(character) || typeof character.accountId !== 'string' || finishedIds.has(character.accountId)) return null;
      const created = characters.get(character.accountId);
      if (!created || normalizeName(character.name ?? '') !== normalizeName(created.name)
        || character.teamId !== created.teamId) return null;
      finishedIds.add(character.accountId);
      finished.push(created);
    }
    cohort = finished;
    teams = groupTeams(cohort);
    if (cohort.length !== source.totalPlayers || teams.size !== source.totalTeams) return null;
    cohortEvidence = 'LogMatchEnd.characters exact official lobby counts';
  } else if (allCharacters.length !== source.totalPlayers || allCharacterTeams.size !== source.totalTeams) {
    const weaponOwners = ends[0].allWeaponStats;
    if (!Array.isArray(weaponOwners) || !weaponOwners.length) return null;
    const ownerIds = new Set<string>();
    for (const owner of weaponOwners) {
      if (!record(owner) || typeof owner.accountId !== 'string' || !LOBBY_PLAYER_ID.test(owner.accountId) || ownerIds.has(owner.accountId)) return null;
      ownerIds.add(owner.accountId);
    }
    cohort = allCharacters.filter(character => ownerIds.has(character.accountId));
    teams = groupTeams(cohort);
    if (cohort.length !== source.totalPlayers || teams.size !== source.totalTeams) return null;
    cohortEvidence = 'LogPlayerCreate ∩ LogMatchEnd.allWeaponStats.accountId';
  }
  const officialByAccount = new Map<string, Dict>();
  const officialNames = new Set<string>();
  for (const stats of officialTeam) {
    if (officialByAccount.has(stats.playerId) || officialNames.has(normalizeName(stats.name))) return null;
    officialByAccount.set(stats.playerId, stats);
    officialNames.add(normalizeName(stats.name));
  }
  const targetStats = officialTeam.filter(stats => normalizeName(stats.name) === normalizeName(input.targetBasic.player_id));
  if (targetStats.length !== 1) return null;
  const target = targetStats[0];
  const targetCharacter = characters.get(target.playerId);
  const cohortIds = new Set(cohort.map(character => character.accountId));
  if (!targetCharacter || !cohortIds.has(target.playerId) || normalizeName(targetCharacter.name) !== normalizeName(target.name)) return null;
  const observedTargetTeam = teams.get(targetCharacter.teamId);
  if (!observedTargetTeam || observedTargetTeam.length !== officialTeam.length) return null;
  const observedMembers = new Set(observedTargetTeam.map(character => normalizeName(character.name)));
  if (observedMembers.size !== officialTeam.length || officialTeam.some(stats => {
    const character = characters.get(stats.playerId);
    return !character || character.teamId !== targetCharacter.teamId || !cohortIds.has(stats.playerId)
      || normalizeName(character.name) !== normalizeName(stats.name);
  })) return null;
  return { safeEvents, starts, ends, cohort, teams, officialByAccount, target, targetCharacter,
    officialPlayers: source.totalPlayers, officialTeams: source.totalTeams, cohortEvidence };
}

/** Reconstruct measured performance only when the archived identities and observed cohort close exactly. */
export function recoverLegacyTeamPerformance(input: LegacyTeamRecoveryInput): LegacyTeamRecoveryResult | null {
  try {
    const legacyIdentity = typeof input?.eventSource?.legacyKey === 'string'
      ? /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([a-z0-9._-]+)_v([1-9][0-9]*)_analyze\.json$/i.exec(input.eventSource.legacyKey) : null;
    if (!input || input.targetHasPersonalAnalysis !== false || !validBasic(input.targetBasic) || !validBasic(input.sourceBasic)
      || input.targetBasic.match_id !== input.sourceBasic.match_id || input.targetBasic.platform !== input.sourceBasic.platform
      || input.sourceIdentity.matchId !== input.sourceBasic.match_id || input.sourceIdentity.platform !== input.sourceBasic.platform
      || normalizeName(input.sourceIdentity.playerId) !== normalizeName(input.sourceBasic.player_id)
      || input.targetBasic.match_id !== input.eventSource.matchId || input.targetBasic.platform !== input.eventSource.platform
      || !['parent-exact-key', 'verified-nickname'].includes(input.eventSource.verification)
      || input.eventSource.requestedLegacyKey !== input.eventSource.legacyKey
      || !legacyIdentity || legacyIdentity[1].toLowerCase() !== input.targetBasic.match_id.toLowerCase()
      || ![input.sourceIdentity.playerId, input.targetBasic.player_id].some(name => normalizeName(name) === normalizeName(legacyIdentity[2]))
      || typeof input.eventSource.artifactSha256 !== 'string' || !HASH.test(input.eventSource.artifactSha256)) return null;
    const source = input.sourceFullResult;
    if (!record(source) || source.matchId !== input.targetBasic.match_id
      || source.platform !== input.sourceIdentity.platform
      || typeof source.player_id !== 'string' || normalizeName(source.player_id) !== normalizeName(input.sourceIdentity.playerId)
      || (source.match_id !== undefined && source.match_id !== input.targetBasic.match_id)
      || (source.id !== undefined && source.id !== input.targetBasic.match_id)
      || (source.player_id !== undefined && normalizeName(source.player_id) !== normalizeName(input.sourceIdentity.playerId))
      || !sourceResultMatchesBasic(source, input.sourceBasic)) return null;
    const metadata = sourceMetadata(source, input.sourceBasic, input.eventSource.events);
    if (!metadata || !Array.isArray(source.team) || !source.team.length) return null;
    if (input.targetBasic.match_type !== metadata.matchType
      && !['unknown', 'unavailable'].includes(input.targetBasic.match_type)) return null;
    const fallbackMetadata = input.targetBasic.account_id === null && input.targetBasic.kills === 0
      && input.targetBasic.damage === 0 && input.targetBasic.win_place === 99
      && input.targetBasic.map_name.toLowerCase() === 'unknown' && input.targetBasic.game_mode.toLowerCase() === 'unknown';
    if (!fallbackMetadata && (!sameInstant(input.targetBasic.played_at, metadata.date) || input.targetBasic.game_mode !== metadata.gameMode
      || !matchingMap(input.targetBasic.map_name, metadata.mapId,
        record(source.matchInfo) ? source.matchInfo.map ?? source.matchInfo.mapName ?? source.mapName : source.mapName))) return null;
    if (source.team.some(stats => !validOfficialStats(stats))) return null;
    const officialTeam = source.team.map(copyOfficialStats);
    const cohort = makeRosterEvidence(input, officialTeam, metadata.date, metadata.duration);
    if (!cohort) return null;
    const targetStats = cohort.target;
    const placeholder = input.targetBasic.account_id === null && input.targetBasic.kills === 0
      && input.targetBasic.damage === 0 && input.targetBasic.win_place === 99;
    const sourceMember = officialTeam.find(stats => stats.playerId === (source.stats as Dict).playerId);
    const sourceCharacter = sourceMember && cohort.cohort.find(character => character.accountId === sourceMember.playerId);
    if (!sourceMember || normalizeName(sourceMember.name) !== normalizeName(input.sourceBasic.player_id)
      || !sourceCharacter || sourceCharacter.teamId !== cohort.targetCharacter.teamId) return null;
    const alreadyObserved = (input.targetBasic.account_id === null || input.targetBasic.account_id === targetStats.playerId)
      && input.targetBasic.kills === targetStats.kills && input.targetBasic.damage === Math.floor(targetStats.damageDealt)
      && input.targetBasic.win_place === targetStats.winPlace;
    if (!placeholder && !alreadyObserved) return null;
    if (input.targetBasic.account_id !== null && input.targetBasic.account_id !== targetStats.playerId) return null;
    if (input.eventSource.verification === 'verified-nickname'
      && (!input.eventSource.verifiedNickname
        || normalizeName(input.eventSource.verifiedNickname) !== normalizeName(legacyIdentity![2]))) return null;
    const teamNames = new Set(officialTeam.map(stats => normalizeName(stats.name)));
    const teamAccounts = new Set(officialTeam.map(stats => stats.playerId));
    const participants = cohort.cohort.map(character => {
      const official = cohort.officialByAccount.get(character.accountId);
      // Only the same observed team has official numeric stats; opponents keep identity only.
      const stats = official ? { ...official } : { name: character.name, playerId: character.accountId };
      return { id: character.accountId, attributes: { stats } };
    });
    const rosters = [...cohort.teams.entries()].map(([teamId, members]) => ({
      id: String(teamId), relationships: { participants: { data: members.map(member => ({ id: member.accountId })) } },
    }));
    const raw = new AnalysisEngine(targetStats.name, targetStats.playerId, teamNames, teamAccounts, new Set(), new Set(),
      String(cohort.targetCharacter.teamId), 'full').run(cohort.safeEvents,
      { id: input.targetBasic.match_id, createdAt: metadata.date, mapName: metadata.mapId, gameMode: metadata.gameMode,
        matchType: metadata.matchType, duration: metadata.duration }, rosters, participants, targetStats, officialTeam, { sampleCount: 0 }) as Dict;
    const fullResult: Dict = { ...raw, mapId: metadata.mapId, platform: input.targetBasic.platform, player_id: normalizeName(input.targetBasic.player_id),
      retentionRecoverySource: 'legacy-team-events',
      retentionRecoveryContext: {
        completeness: 'partial',
        personalAnalysis: 'recomputed-from-legacy-event-projection',
        officialStatsScope: 'target-observed-team-only',
        basicMetadataRecovered: fallbackMetadata,
        ...(metadata.compatibility ? { metadataSource: metadata.compatibility.metadataSource } : {}),
        unavailable: ['full-lobby-damage-rank', 'opponent-official-stats', 'LogPlayerAttack'],
      } };
    delete fullResult.myRank;
    if (record(fullResult.matchInfo)) {
      fullResult.matchInfo = { ...fullResult.matchInfo };
      delete fullResult.matchInfo.rankPct;
    }
    fullResult.benchmark = null;
    fullResult.isValidBenchmark = false;
    fullResult.stats = { ...fullResult.stats,
      processedDamageDealt: fullResult.stats.processedDamageDealt > 0 ? fullResult.stats.processedDamageDealt : null };
    for (const field of ['weaponStats', 'itemUseStats', 'itemUseSummary', 'tradeStats', 'duelStats', 'killContribution',
      'isolationData', 'initiativeStats', 'combatPressure']) {
      fullResult[field] = omitUnobservedDefaults(fullResult[field]);
    }
    for (const field of ['teamWipeOccurred', 'goldenTimeDamage', 'initiative_rate', 'initiativeSampleCount', 'deathPhase',
      'edgePlay', 'bluezoneWaste', 'leadShotKills', 'leadShotKnocks', 'ridingShotKills', 'ridingShotKnocks', 'roadKills', 'roadKnocks']) {
      fullResult[field] = omitUnobservedDefaults(fullResult[field]);
    }
    fullResult.badges = [];
    const evidence: LegacyTeamRecoveryEvidence = {
      sourceScope: { ...input.sourceIdentity }, legacyKey: input.eventSource.legacyKey,
      verification: input.eventSource.verification, rawArtifactSha256: input.eventSource.artifactSha256.toLowerCase(),
      sourceFullResultSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
      sourceMatchId: input.sourceBasic.match_id, sourcePlayerId: input.sourceIdentity.playerId,
      observedPlayers: cohort.cohort.length, officialPlayers: cohort.officialPlayers,
      observedTeams: cohort.teams.size, officialTeams: cohort.officialTeams, observedTeamId: cohort.targetCharacter.teamId,
      telemetryFilter: 'current-allowlist-projection', cohortEvidence: cohort.cohortEvidence,
      ...(metadata.compatibility ? { compatibility: metadata.compatibility } : {}),
      unavailableEvidence: ['full-lobby-damage-rank', 'opponent-official-stats', 'LogPlayerAttack'],
    };
    fullResult.retentionRecoveryEvidence = evidence;
    const retained = buildRetainedPerformanceRow(fullResult, {
      matchId: input.targetBasic.match_id, platform: input.targetBasic.platform, playerId: input.targetBasic.player_id,
    });
    if (!retained) return null;
    const compact = retained.summary as unknown as LegacyTeamRecoveryResult['compact'];
    compact.performanceHistorical = true;
    compact.benchmark = null;
    compact.isValidBenchmark = false;
    (compact as Record<string, any>).retentionRecoveryContext = 'partial-legacy-team-events';
    (compact as Record<string, any>).retentionRecoveryEvidence = evidence;
    const expectedBasic: LegacyRetentionBasic = {
      ...input.targetBasic, account_id: targetStats.playerId,
      ...(fallbackMetadata ? { played_at: input.sourceBasic.played_at, game_mode: metadata.gameMode, map_name: input.sourceBasic.map_name } : {}),
      ...(placeholder ? { kills: targetStats.kills, damage: Math.floor(targetStats.damageDealt), win_place: targetStats.winPlace } : {}),
      ...(input.targetBasic.match_type === 'unknown' || input.targetBasic.match_type === 'unavailable'
        ? { match_type: metadata.matchType } : {}),
    };
    return {
      fullResult, compact, expectedBasic, evidence,
      writeCandidate: {
        identity: { platform: retained.platform, match_id: retained.match_id, player_id: retained.player_id, account_id: retained.account_id },
        calculation_version: retained.calculation_version, result_version: retained.result_version,
        summary_version: retained.summary_version, source_checksum: retained.source_checksum,
      },
    };
  } catch {
    return null;
  }
}
