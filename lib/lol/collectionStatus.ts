const DAY_MS = 24 * 60 * 60 * 1000;

export function lolCollectionStatus(updatedAt: string | null | undefined, now = Date.now()) {
  const timestamp = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now) return { time: null, stale: false };
  return {
    time: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(timestamp),
    stale: now - timestamp >= DAY_MS,
  };
}
