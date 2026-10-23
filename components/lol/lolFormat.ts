export function formatMetric(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "미제공";
  return value.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "미제공"
    : `${Math.round(value)}%`;
}

export function formatKdaRatio(
  kills: number | null | undefined,
  deaths: number | null | undefined,
  assists: number | null | undefined,
) {
  if (
    kills == null ||
    deaths == null ||
    assists == null ||
    ![kills, deaths, assists].every((value) => Number.isFinite(value) && value >= 0)
  )
    return "미제공";
  return deaths === 0
    ? "Perfect"
    : `${((kills + assists) / deaths).toFixed(2)}:1`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 10_080) return `${Math.floor(minutes / 1440)}일 전`;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(
    timestamp,
  );
}

export function formatAbsoluteTime(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

// 기록 시각은 UTC로 저장되므로 한국 날짜 기준으로 표시한다.
export function formatKstDate(isoTimestamp: string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(isoTimestamp));
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "미제공";
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

export function getQueueLabel(queueId: number, gameMode: string) {
  if (queueId === 420) return "솔로 랭크";
  if (queueId === 440) return "자유 랭크";
  if (queueId === 450 || gameMode === "ARAM") return "무작위 총력전";
  if (gameMode === "CLASSIC") return "일반 게임";
  if (gameMode === "URF") return "U.R.F.";
  if (gameMode === "CHERRY") return "아레나";
  return `큐 ${queueId}`;
}
