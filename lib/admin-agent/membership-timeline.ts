export type MembershipLifecycleEventType = "signup" | "deletion";

export type MembershipLifecycleEvent = {
  event_type: MembershipLifecycleEventType;
  occurred_at: string;
};

export type MembershipDailyRow = {
  event_date: string;
  signups: number;
  deletions: number;
  collection_started_at?: string | null;
};

export type MembershipTimelinePoint = {
  date: string;
  signups: number | null;
  deletions: number | null;
  net: number | null;
};

export type MembershipTimeline = {
  status: "ready" | "unavailable";
  windowDays: 7 | 30 | 90;
  currentMembers: number;
  periodSignups: number | null;
  periodDeletions: number | null;
  netChange: number | null;
  points: MembershipTimelinePoint[];
  collectionStartedAt: string | null;
  deletionHistoryAvailable: boolean;
  periodCoverage: "complete" | "partial" | "none";
  notes: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeMembershipWindowDays(value: unknown): 7 | 30 | 90 {
  const days = Number(value);
  if (days === 7) return 7;
  if (days === 90) return 90;
  if (days === 30) return 30;
  return 30;
}

/** KST 날짜 경계를 사용해 집계 시작 시각을 만든다. */
export function getMembershipWindowStart(now = new Date(), windowDays: 7 | 30 | 90 = 30): Date {
  const kstDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const [year, month, day] = kstDate.split("-").map(Number);
  // The Date.UTC value is a stable day key; subtract N-1 days so today is included.
  return new Date(Date.UTC(year, month - 1, day) - (windowDays - 1) * DAY_MS - 9 * 60 * 60 * 1000);
}

export function kstDateKey(value: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(typeof value === "string" ? new Date(value) : value);
}

export function buildMembershipTimeline(
  events: MembershipLifecycleEvent[],
  options: {
    windowDays?: unknown;
    currentMembers?: number;
    status?: "ready" | "unavailable";
    collectionStartedAt?: string | null;
    dailyRows?: MembershipDailyRow[];
    now?: Date;
  } = {}
): MembershipTimeline {
  const windowDays = normalizeMembershipWindowDays(options.windowDays);
  const start = getMembershipWindowStart(options.now || new Date(), windowDays);
  const pointsByDate = new Map<string, MembershipTimelinePoint>();
  const collectionStartAtMs = options.collectionStartedAt ? Date.parse(options.collectionStartedAt) : null;
  const dailyByDate = new Map((options.dailyRows || []).map((row) => [row.event_date, row]));

  for (let index = 0; index < windowDays; index += 1) {
    const date = kstDateKey(new Date(start.getTime() + index * DAY_MS));
    const pointStartAtMs = start.getTime() + index * DAY_MS;
    // The first capture day is partial, not empty: retain events collected
    // after activation and disclose partial coverage in the period notes.
    const collected = options.status === "ready" && (collectionStartAtMs === null || collectionStartAtMs < pointStartAtMs + DAY_MS);
    const daily = dailyByDate.get(date);
    const signups = daily && collected ? Number(daily.signups || 0) : collected ? 0 : null;
    const deletions = daily && collected ? Number(daily.deletions || 0) : collected ? 0 : null;
    pointsByDate.set(date, { date, signups, deletions, net: signups === null || deletions === null ? null : signups - deletions });
  }

  for (const event of options.dailyRows ? [] : events) {
    if (event.event_type !== "signup" && event.event_type !== "deletion") continue;
    const eventTime = Date.parse(event.occurred_at);
    if (!Number.isFinite(eventTime) || (collectionStartAtMs !== null && eventTime < collectionStartAtMs)
      || eventTime > (options.now || new Date()).getTime()) continue;
    const date = kstDateKey(event.occurred_at);
    const point = pointsByDate.get(date);
    if (!point) continue;
    if (point.signups === null || point.deletions === null) continue;
    if (event.event_type === "signup") point.signups += 1;
    else point.deletions += 1;
    point.net = point.signups - point.deletions;
  }

  const points = Array.from(pointsByDate.values());
  const hasDeletionHistory = options.status === "ready";
  const observedPoints = points.filter((point) => point.signups !== null && point.deletions !== null);
  const windowEndAtMs = start.getTime() + windowDays * DAY_MS;
  const periodCoverage: MembershipTimeline["periodCoverage"] = !hasDeletionHistory || observedPoints.length === 0 || (collectionStartAtMs !== null && collectionStartAtMs >= windowEndAtMs)
    ? "none"
    : collectionStartAtMs !== null && collectionStartAtMs > start.getTime() ? "partial" : "complete";
  const periodSignups = periodCoverage === "none" ? null : observedPoints.reduce((sum, point) => sum + (point.signups || 0), 0);
  const periodDeletions = periodCoverage === "none" ? null : observedPoints.reduce((sum, point) => sum + (point.deletions || 0), 0);
  const netChange = periodSignups === null || periodDeletions === null ? null : periodSignups - periodDeletions;
  const notes: string[] = options.status === "ready"
    ? [
      "가입·탈퇴 이벤트가 기록된 날짜만 표시합니다.",
      periodCoverage === "partial" ? "수집 시작일 이전 날짜는 미수집(null)입니다. 시작일의 수치는 수집을 시작한 시각 이후 관측분만 포함하며, 기간 KPI도 수집 이후 관측분입니다." : null,
      periodCoverage === "none" ? "선택 기간이 이벤트 수집 시작일보다 이전이라 관측 건수가 없습니다." : null,
      `현재 계정 ${Number(options.currentMembers || 0)}명(관리자 포함)은 선택 기간의 순증감으로 재구성하지 않습니다.`,
      options.collectionStartedAt
        ? `이벤트 수집 시작: ${kstDateKey(options.collectionStartedAt)} (KST)`
        : "이벤트 수집 시작일은 아직 확인되지 않았습니다."
    ].filter((note): note is string => Boolean(note))
    : [
      "가입·탈퇴 이력 테이블이 아직 없거나 조회할 수 없습니다.",
      "현재 잔존 Auth 계정의 created_at만으로 과거 가입·탈퇴 수와 회원 총수 곡선을 추정하지 않습니다.",
      `현재 계정 ${Number(options.currentMembers || 0)}명(관리자 포함)만 확인 가능합니다.`
    ].filter((note): note is string => Boolean(note))

  return {
    status: options.status || "unavailable",
    windowDays,
    currentMembers: Number(options.currentMembers || 0),
    periodSignups,
    periodDeletions,
    netChange,
    points,
    collectionStartedAt: options.collectionStartedAt || null,
    deletionHistoryAvailable: hasDeletionHistory,
    periodCoverage,
    notes
  };
}
