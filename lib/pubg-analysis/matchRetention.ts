/** 상세 제공 기간은 파일 생성일이 아닌 실제 경기 시각을 기준으로 계산한다. */
export const MATCH_DETAIL_RETENTION_DAYS = 14;
export const MATCH_DETAIL_EXPIRED_CODE = "PUBG_MATCH_DETAIL_EXPIRED";
export const MATCH_DETAIL_UNAVAILABLE_CODE = "PUBG_MATCH_DETAIL_UNAVAILABLE";
export const MATCH_DETAIL_EXPIRED_MESSAGE = "상세 분석과 리플레이 제공 기간이 만료되었습니다. 기본 전적과 저장된 성과는 계속 확인할 수 있습니다.";

export type MatchDetailRetention = {
  status: "available" | "expired" | "unknown";
  expiresAt: string | null;
};

export function getMatchDetailRetention(playedAt: unknown, now = Date.now()): MatchDetailRetention {
  const playedMs = typeof playedAt === "string" ? Date.parse(playedAt) : NaN;
  if (!Number.isFinite(playedMs) || !Number.isFinite(now) || playedMs > now) {
    return { status: "unknown", expiresAt: null };
  }
  const expiresMs = playedMs + MATCH_DETAIL_RETENTION_DAYS * 86_400_000;
  return { status: expiresMs <= now ? "expired" : "available", expiresAt: new Date(expiresMs).toISOString() };
}

export function matchDetailExpiredBody(playedAt: unknown, now = Date.now()) {
  return {
    error: MATCH_DETAIL_EXPIRED_MESSAGE,
    errorCode: MATCH_DETAIL_EXPIRED_CODE,
    retryable: false,
    retentionDays: MATCH_DETAIL_RETENTION_DAYS,
    expiresAt: getMatchDetailRetention(playedAt, now).expiresAt,
  };
}
