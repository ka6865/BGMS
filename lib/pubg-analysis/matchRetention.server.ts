import { NextResponse } from "next/server";
import {
  getMatchDetailRetention,
  matchDetailExpiredBody,
  MATCH_DETAIL_UNAVAILABLE_CODE,
} from "./matchRetention";

type MatchRetentionDatabase = {
  from(table: string): {
    select(columns: string): any;
  };
};

function validDate(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now ? value : null;
}

/** Only use dates from an identity-validated canonical result or a scoped history row. */
export function canonicalMatchPlayedAt(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const match = value as Record<string, unknown>;
  const info = typeof match.matchInfo === "object" && match.matchInfo !== null
    ? match.matchInfo as Record<string, unknown>
    : null;
  return validDate(info?.date, now) ?? validDate(info?.createdAt, now) ?? validDate(match.createdAt, now);
}

/** Conflicting canonical dates fail toward the earlier (more restrictive) retention deadline. */
export function resolveTrustedMatchPlayedAt(databaseDate: unknown, officialDate: unknown, now = Date.now()): string | null {
  const databasePlayedAt = validDate(databaseDate, now);
  const officialPlayedAt = validDate(officialDate, now);
  if (databasePlayedAt && officialPlayedAt) {
    return Date.parse(databasePlayedAt) <= Date.parse(officialPlayedAt) ? databasePlayedAt : officialPlayedAt;
  }
  return databasePlayedAt ?? officialPlayedAt;
}

export async function lookupMatchPlayedAt(
  db: MatchRetentionDatabase,
  input: { matchId: string; platform: string; playerId: string; signal?: AbortSignal },
): Promise<string | null> {
  let query = db.from("pubg_player_matches")
    .select("played_at")
    .eq("match_id", input.matchId)
    .eq("platform", input.platform)
    .eq("player_id", input.playerId);
  if (input.signal) query = query.abortSignal(input.signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return validDate(data?.played_at);
}

export function expiredMatchDetailResponse(playedAt: unknown, now = Date.now()) {
  return NextResponse.json(matchDetailExpiredBody(playedAt, now), {
    status: 410,
    headers: { "Cache-Control": "no-store" },
  });
}

export function unavailableMatchDetailResponse() {
  return NextResponse.json({
    error: "저장된 리플레이 파일을 사용할 수 없습니다.",
    errorCode: MATCH_DETAIL_UNAVAILABLE_CODE,
    retryable: false,
  }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function isMatchDetailExpired(playedAt: unknown, now = Date.now()): boolean {
  return getMatchDetailRetention(playedAt, now).status === "expired";
}

/** Keep replay URLs within the remaining retention window; unknown dates get a short bounded URL. */
export function getMatchDetailPresignTtlSeconds(playedAt: unknown, now = Date.now()): number | null {
  const retention = getMatchDetailRetention(playedAt, now);
  if (retention.status === "expired") return null;
  if (retention.status === "unknown") return 600;
  const remainingSeconds = Math.floor((Date.parse(retention.expiresAt!) - now) / 1000);
  return remainingSeconds > 0 ? Math.min(600, remainingSeconds) : null;
}
