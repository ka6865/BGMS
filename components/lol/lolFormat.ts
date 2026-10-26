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
  if (queueId === 2400) return "무작위 총력전: 아수라장";
  if (queueId === 450 || queueId === 100 || gameMode === "ARAM") return "무작위 총력전";
  if (gameMode === "CLASSIC") return "일반 게임";
  if (gameMode === "URF") return "U.R.F.";
  if (gameMode === "CHERRY") return "아레나";
  return `큐 ${queueId}`;
}

export const LOL_TIER_NAMES: Record<string, string> = {
  IRON: "아이언", BRONZE: "브론즈", SILVER: "실버", GOLD: "골드", PLATINUM: "플래티넘",
  EMERALD: "에메랄드", DIAMOND: "다이아몬드", MASTER: "마스터", GRANDMASTER: "그랜드마스터", CHALLENGER: "챌린저",
};
const LOL_DIVISION_NUMBERS: Record<string, string> = { I: "1", II: "2", III: "3", IV: "4" };
const LOL_APEX_TIERS = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

// Riot 티어·디비전(PLATINUM, IV)을 화면 표기(플래티넘 4)로 바꾼다. 마스터 이상은 디비전이 없으므로 생략한다.
export function formatLolTier(tier?: string | null, rank?: string | null): string {
  if (!tier) return "랭크 없음";
  const name = LOL_TIER_NAMES[tier] ?? tier;
  if (LOL_APEX_TIERS.has(tier) || !rank) return name;
  return `${name} ${LOL_DIVISION_NUMBERS[rank] ?? rank}`;
}
