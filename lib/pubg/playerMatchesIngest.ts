import { evaluateMatchEligibility } from "@/lib/pubg-analysis/matchEligibility";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { hasObservedPlayerMatchValues, normalizeBasicMatchStat, upsertPlayerMatches, type PlayerMatchRecord } from "./playerMatches";
import type { PlayerMatchTeammate } from "./playerMatchTeammateList";
import { getPrivatePlayersList, matchesPrivatePlayer, type PrivatePlayer } from "./privatePlayers";

export interface IngestParticipantInput {
  matchId: string;
  nickname: string;
  platform: string;
  createdAt: string;
  matchType?: string;
  gameMode: string;
  mapName: string;
  kills: number;
  damage: number;
  winPlace: number;
  knocks?: unknown;
  survivalTime?: unknown;
}

export function buildPlayerMatchRecordFromParticipant(input: IngestParticipantInput): PlayerMatchRecord {
  return {
    player_id: normalizeName(input.nickname),
    platform: normalizePlatform(input.platform),
    match_id: input.matchId,
    played_at: input.createdAt,
    game_mode: input.gameMode,
    map_name: input.mapName,
    kills: input.kills,
    damage: Math.floor(input.damage),
    win_place: input.winPlace,
    knocks: normalizeBasicMatchStat(input.knocks),
    survival_time: normalizeBasicMatchStat(input.survivalTime),
    match_type: input.matchType || "unknown",
  };
}

/** 이동 거리는 도보·차량·수영 거리의 합을 m 단위 정수로 저장한다. 하나라도 관측되지 않으면 저장하지 않는다. */
export function observedTravelDistance(stats: Record<string, unknown>): number | null {
  const parts = [stats.walkDistance, stats.rideDistance, stats.swimDistance];
  if (!parts.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  return normalizeBasicMatchStat(Math.round((parts as number[]).reduce((sum, value) => sum + value, 0)));
}

/** 최장 킬 거리(m). 킬이 없으면 공식 응답의 0 을 그대로 저장한다. */
export function observedLongestKill(stats: Record<string, unknown>): number | null {
  const value = stats.longestKill;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? normalizeBasicMatchStat(Math.round(value)) : null;
}

const MAX_STORED_TEAMMATES = 8;

/** roster 의 참가자 id → teamId. 한 참가자가 여러 roster 에 있거나 teamId 가 범위를 벗어나면 제외한다. */
export function buildParticipantTeamIds(rosters: readonly unknown[]): Map<string, number> {
  const teams = new Map<string, number>();
  const duplicated = new Set<string>();
  for (const roster of rosters) {
    const value = roster as { type?: unknown; attributes?: { stats?: { teamId?: unknown } };
      relationships?: { participants?: { data?: unknown } } } | null;
    const teamId = value?.attributes?.stats?.teamId;
    const members = value?.relationships?.participants?.data;
    if (value?.type !== "roster" || typeof teamId !== "number" || !Number.isSafeInteger(teamId)
      || teamId < 0 || teamId > 32767 || !Array.isArray(members)) continue;
    for (const member of members) {
      const id = (member as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !id) continue;
      if (teams.has(id)) duplicated.add(id);
      teams.set(id, teamId);
    }
  }
  for (const id of duplicated) teams.delete(id);
  return teams;
}

/** Official response observations only; ambiguous identities never become history. */
export function buildOfficialParticipantMatchRecords(input: {
  matchId: string; platform: string; matchAttr: Record<string, unknown>;
  participants: readonly unknown[]; privatePlayers: readonly PrivatePlayer[];
  rosters?: readonly unknown[];
}): PlayerMatchRecord[] {
  const { matchId, platform, matchAttr, privatePlayers } = input;
  const teamIds = buildParticipantTeamIds(input.rosters ?? []);
  if (!matchId || !["steam", "kakao"].includes(platform)
    || (matchAttr.shardId !== undefined && matchAttr.shardId !== platform)) return [];
  const participantIds = input.participants.map(participant => {
    const id = (participant as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : null;
  });
  const participants = input.participants.map(participant => {
    const stats = (participant as { attributes?: { stats?: Record<string, unknown> } } | null)?.attributes?.stats;
    return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : null;
  });
  const names = new Map<string, number>();
  const accounts = new Map<string, number>();
  for (const stats of participants) {
    if (!stats) continue;
    if (typeof stats.name === "string" && normalizeName(stats.name)) {
      const name = normalizeName(stats.name);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    if (typeof stats.playerId === "string" && /^account\.[A-Za-z0-9_-]+$/.test(stats.playerId)) {
      accounts.set(stats.playerId, (accounts.get(stats.playerId) ?? 0) + 1);
    }
  }
  // 팀원으로 적을 수 있는 참가자: 공식 계정 ID·닉네임이 경기 안에서 유일하고 비공개가 아닌 사람.
  const listable = participants.map((stats) => {
    if (!stats || typeof stats.name !== "string" || typeof stats.playerId !== "string"
      || !/^account\.[A-Za-z0-9_-]+$/.test(stats.playerId)) return null;
    const name = stats.name.trim();
    if (!name || name.length > 64 || names.get(normalizeName(name)) !== 1 || accounts.get(stats.playerId) !== 1
      || matchesPrivatePlayer(privatePlayers, platform, name, stats.playerId)) return null;
    return { name, account_id: stats.playerId };
  });
  const teamMembers = new Map<number, number[]>();
  participantIds.forEach((id, index) => {
    const teamId = id ? teamIds.get(id) : undefined;
    if (teamId === undefined) return;
    teamMembers.set(teamId, [...(teamMembers.get(teamId) ?? []), index]);
  });
  // roster 로 팀을 확인하지 못하면 관측하지 못한 값(null)이다. 팀은 확인했지만 적을 팀원이 없으면 빈 목록이다.
  const teammatesFor = (index: number): PlayerMatchTeammate[] | null => {
    const id = participantIds[index];
    const teamId = id ? teamIds.get(id) : undefined;
    if (teamId === undefined) return null;
    return (teamMembers.get(teamId) ?? []).flatMap((member) => {
      const teammate = member === index ? null : listable[member];
      return teammate ? [teammate] : [];
    }).slice(0, MAX_STORED_TEAMMATES);
  };
  const records: PlayerMatchRecord[] = [];
  for (const [index, stats] of participants.entries()) {
    if (!stats || typeof stats.name !== "string" || typeof stats.playerId !== "string"
      || !/^account\.[A-Za-z0-9_-]+$/.test(stats.playerId)) continue;
    const playerId = normalizeName(stats.name);
    if (!playerId || names.get(playerId) !== 1 || accounts.get(stats.playerId) !== 1
      || matchesPrivatePlayer(privatePlayers, platform, stats.name, stats.playerId)) continue;
    const record = {
      account_id: stats.playerId, retention_scope: "basic_only" as const,
      ranking_eligible: evaluateMatchEligibility({ ...matchAttr, stats }, "benchmark").eligible,
      player_id: playerId, platform, match_id: matchId, played_at: matchAttr.createdAt,
      game_mode: matchAttr.gameMode, map_name: matchAttr.mapName,
      kills: stats.kills, damage: stats.damageDealt, win_place: stats.winPlace,
      knocks: normalizeBasicMatchStat(stats.DBNOs), survival_time: normalizeBasicMatchStat(stats.timeSurvived),
      match_type: typeof matchAttr.matchType === "string" ? matchAttr.matchType.trim().toLowerCase() : "unknown",
      teammates: teammatesFor(index),
      travel_distance: observedTravelDistance(stats),
      longest_kill: observedLongestKill(stats),
    };
    const noPlacement = record.win_place === 0 && (record.match_type === "tutorialatoz" || record.game_mode === "tdm");
    if (!hasObservedPlayerMatchValues(record, { allowZeroPlacement: noPlacement })) continue;
    record.damage = Math.floor(record.damage);
    records.push(record);
  }
  return records;
}

export type BasicMatchIngestStatus =
  | "saved"
  | "not_found"
  | "unsupported_match"
  | "rate_limited"
  | "upstream_error"
  | "network_error";

/** The rate-limit headers observed on one PUBG API response. */
export interface PubgRateLimitHeaderSnapshot {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  resetAt: string | null;
  retryAfter: number | null;
  retryAfterMs: number | null;
}

export interface BasicMatchIngestOutcome {
  status: BasicMatchIngestStatus;
  record: PlayerMatchRecord | null;
  httpStatus: number | null;
  rateLimitHeaders: PubgRateLimitHeaderSnapshot | null;
  error?: string;
}

export type PubgFetchImpl = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BasicMatchIngestOptions {
  expectedAccountId?: string;
  fetchImpl?: PubgFetchImpl;
  signal?: AbortSignal;
  timeoutMs?: number;
  onResponseStatus?: (status: number) => void;
}

type BasicMatchIngestCallback = ((status: number) => void) | BasicMatchIngestOptions;

/**
 * Extracts the PUBG quota headers without coupling the worker to a database
 * tracker. The caller can persist this snapshot or pass the Headers object to
 * the existing tracker at its own boundary.
 */
export function readPubgRateLimitHeaders(headers: Headers | null | undefined): PubgRateLimitHeaderSnapshot | null {
  if (!headers) return null;

  const limit = parseHeaderNumber(headers, ["x-ratelimit-limit"]);
  const remaining = parseHeaderNumber(headers, ["x-ratelimit-remaining"]);
  const reset = parseHeaderNumber(headers, ["x-ratelimit-reset"]);
  const retryAfter = parseHeaderNumber(headers, ["retry-after"]);
  const resetAt = reset === null
    ? parseHeaderDate(headers, ["x-ratelimit-reset"])
    : new Date((reset > 10_000_000_000 ? reset : reset * 1_000)).toISOString();
  const retryAfterMs = retryAfter === null
    ? null
    : retryAfter > 10_000 ? retryAfter : retryAfter * 1_000;

  if (limit === null && remaining === null && reset === null && retryAfter === null && resetAt === null) {
    return null;
  }

  return { limit, remaining, reset, resetAt, retryAfter, retryAfterMs };
}

/**
 * Fetches one match and returns a machine-readable disposition. The
 * compatibility wrapper below intentionally keeps its historical nullable
 * record contract for API routes.
 */
export async function fetchAndIngestBasicMatchSummaryOutcome(
  supabase: SupabaseClient,
  matchId: string,
  nickname: string,
  platform: string,
  apiKey: string,
  callbackOrOptions?: BasicMatchIngestCallback,
): Promise<BasicMatchIngestOutcome> {
  const options = typeof callbackOrOptions === "function"
    ? { onResponseStatus: callbackOrOptions }
    : (callbackOrOptions || {});
  const fetchImpl = options.fetchImpl || fetch;
  const normPlatform = normalizePlatform(platform);
  const playerId = normalizeName(nickname);
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!["steam", "kakao"].includes(platform.trim().toLowerCase())) {
    return { status: "upstream_error", record: null, httpStatus: null, rateLimitHeaders: null, error: "match-identity-invalid" };
  }

  try {
    const res = await fetchImpl(
      `https://api.pubg.com/shards/${normPlatform}/matches/${encodeURIComponent(matchId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
    );
    const rateLimitHeaders = readPubgRateLimitHeaders(res.headers);

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      options.onResponseStatus?.(res.status);
      return {
        status: res.status === 404
          ? "not_found"
          : res.status === 429
            ? "rate_limited"
            : "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
      };
    }

    let data: any;
    try {
      data = await res.json();
    } catch (error) {
      return {
        status: "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const matchAttr = data?.data?.attributes || {};
    const responseMatchId = data?.data?.id;
    if (typeof responseMatchId !== "string" || responseMatchId.replace(/^shard:/, '') !== matchId
      || (matchAttr.shardId !== undefined && matchAttr.shardId !== normPlatform)) {
      return { status: 'upstream_error', record: null, httpStatus: res.status, rateLimitHeaders, error: 'match-identity-invalid' };
    }
    const participants = (Array.isArray(data.included) ? data.included : []).filter((it: any) => it?.type === "participant");
    const targets = participants.filter(
      (p: any) => options.expectedAccountId
        ? p.attributes?.stats?.playerId === options.expectedAccountId
        : typeof p.attributes?.stats?.name === "string" && normalizeName(p.attributes.stats.name) === playerId,
    );
    if (targets.length !== 1 || !targets[0]?.attributes?.stats) {
      return { status: options.expectedAccountId || targets.length > 1 ? "upstream_error" : "not_found", record: null, httpStatus: res.status, rateLimitHeaders };
    }

    const stats = targets[0].attributes.stats;
    if (options.expectedAccountId && (typeof stats.name !== 'string' || !stats.name.trim())) {
      return { status: 'upstream_error', record: null, httpStatus: res.status, rateLimitHeaders, error: 'participant-name-missing' };
    }
    let privatePlayers: PrivatePlayer[];
    try { privatePlayers = await getPrivatePlayersList(supabase); }
    catch { return { status: "upstream_error", record: null, httpStatus: res.status, rateLimitHeaders, error: "player-privacy-check-failed" }; }
    const rosters = (Array.isArray(data.included) ? data.included : []).filter((it: any) => it?.type === "roster");
    const records = buildOfficialParticipantMatchRecords({ matchId, platform: normPlatform, matchAttr, participants, privatePlayers, rosters });
    const record = records.find(row => row.account_id === stats.playerId && row.player_id === normalizeName(stats.name));
    if (!record) {
      return { status: "upstream_error", record: null, httpStatus: res.status, rateLimitHeaders, error: "match-basic-values-missing" };
    }
    // 다른 필수값까지 관측된 순위 없는 훈련·TDM만 영구 제외한다. DB 순위 계약은 유지한다.
    if (record.win_place === 0) {
      return { status: 'unsupported_match', record: null, httpStatus: res.status, rateLimitHeaders, error: 'match-placement-unavailable' };
    }
    let persisted = false;
    try {
      // 검색·연동 대상 플레이어의 기록만 저장한다. 같은 경기 참가자 전원 저장은 DB 증가량 때문에 중단했다.
      // 참가자 전원은 위에서 닉네임·계정 중복과 비공개 여부를 판단하는 데만 쓴다.
      persisted = await upsertPlayerMatches(supabase, [record], { atomic: true });
    } catch (error) {
      return {
        status: "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!persisted) {
      return {
        status: "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
        error: "player-match-upsert-failed",
      };
    }

    return { status: "saved", record, httpStatus: res.status, rateLimitHeaders };
  } catch (error) {
    return {
      status: "network_error",
      record: null,
      httpStatus: null,
      rateLimitHeaders: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchAndIngestBasicMatchSummary(
  supabase: SupabaseClient,
  matchId: string,
  nickname: string,
  platform: string,
  apiKey: string,
  onResponseStatus?: (status: number) => void,
): Promise<PlayerMatchRecord | null> {
  const outcome = await fetchAndIngestBasicMatchSummaryOutcome(
    supabase,
    matchId,
    nickname,
    platform,
    apiKey,
    { onResponseStatus },
  );
  return outcome.status === "saved" ? outcome.record : null;
}

function parseHeaderNumber(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value === null || value.trim() === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseHeaderDate(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (!value || !Number.isFinite(Date.parse(value))) continue;
    return new Date(value).toISOString();
  }
  return null;
}
