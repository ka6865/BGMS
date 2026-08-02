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
