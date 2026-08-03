 export function isMatchTelemetryExpired(
   playedAtIso: string,
   retentionDays = 90,
   nowMs = Date.now()
 ): boolean {
   if (!playedAtIso) return false;
   const playedMs = new Date(playedAtIso).getTime();
   if (!Number.isFinite(playedMs)) return false;
   const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
   return playedMs < cutoffMs;
 }

export function isMatchOlderThan14Days(
  playedAtIso: string,
  nowMs = Date.now()
): boolean {
  return isMatchTelemetryExpired(playedAtIso, 14, nowMs);
}
