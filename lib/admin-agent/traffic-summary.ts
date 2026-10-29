export type TrafficTopItem = {
  label: string;
  count: number;
};

export type TrafficTopUser = {
  userId: string;
  label: string;
  nickname: string | null;
  pubgNickname: string | null;
  eventCount: number;
  pageViews: number;
  statsSearches: number;
  aiFeatureUses: number;
};

export type TrafficSummaryWindow = {
  uniqueSessions: number;
  uniqueUsers: number;
  guestSessions: number;
  memberSessions: number;
  pageViews: number;
  totalEvents: number;
  topPages: TrafficTopItem[];
  topEvents: TrafficTopItem[];
  topFeatures: TrafficTopItem[];
  topUsers: TrafficTopUser[];
  statsSearches: number;
  aiFeatureUses: number;
  boardActions: number;
  crateOpens: number;
  replayOpens: number;
};

export type TrafficSummary = {
  generatedAt: string;
  status: "ready" | "empty" | "unavailable";
  windowHours: number;
  current: TrafficSummaryWindow;
  previous: TrafficSummaryWindow;
  changes: Record<keyof Pick<TrafficSummaryWindow, "uniqueSessions" | "pageViews" | "totalEvents" | "statsSearches" | "aiFeatureUses" | "boardActions" | "crateOpens" | "replayOpens">, number | null>;
  highlights: string[];
  /** 조회 상한(TRAFFIC_EVENT_ROW_LIMIT)에 걸려 일부 이벤트가 빠졌을 수 있으면 true */
  truncated: boolean;
  /** 운영 지표에서 제외한 내부(is_internal=true) 이벤트 수. 조회된 행 기준이다. */
  internalEventsExcluded: number;
  error?: string;
};

type AnalyticsEventRow = {
  event_name: string;
  session_id: string | null;
  user_id: string | null;
  page_path: string | null;
  params: Record<string, unknown> | null;
  created_at: string;
  is_internal?: boolean | null;
};

type AnalyticsUserProfile = {
  id: string;
  nickname: string | null;
  role: string | null;
  pubg_nickname: string | null;
};

const EMPTY_WINDOW: TrafficSummaryWindow = {
  uniqueSessions: 0,
  uniqueUsers: 0,
  guestSessions: 0,
  memberSessions: 0,
  pageViews: 0,
  totalEvents: 0,
  topPages: [],
  topEvents: [],
  topFeatures: [],
  topUsers: [],
  statsSearches: 0,
  aiFeatureUses: 0,
  boardActions: 0,
  crateOpens: 0,
  replayOpens: 0
};

// 현재+이전 기간을 한 번에 읽는 최대 행 수
export const TRAFFIC_EVENT_ROW_LIMIT = 10000;

/**
 * 조회 자체가 불가능할 때의 결과입니다. command center 처럼 여러 소스를 병렬로 읽는 곳에서
 * 예외가 나도 같은 모양의 값을 쓰도록 공개한다.
 */
export function buildUnavailableTrafficSummary(windowHours: number, error: string): TrafficSummary {
  return {
    generatedAt: new Date().toISOString(),
    status: "unavailable",
    windowHours,
    current: { ...EMPTY_WINDOW },
    previous: { ...EMPTY_WINDOW },
    changes: buildChanges(EMPTY_WINDOW, EMPTY_WINDOW),
    highlights: ["유저 활동 테이블을 아직 조회할 수 없습니다."],
    truncated: false,
    internalEventsExcluded: 0,
    error
  };
}

/**
 * is_internal 은 NOT NULL DEFAULT false 컬럼이다(20260611133705).
 * 명시적으로 true 인 행만 내부 이벤트로 보고, null/누락은 운영 이벤트로 취급한다.
 */
function isInternalEvent(row: AnalyticsEventRow) {
  return row.is_internal === true;
}

export async function buildTrafficSummary(supabase: any, windowHours = 24): Promise<TrafficSummary> {
  const now = Date.now();
  const currentSince = new Date(now - windowHours * 60 * 60 * 1000).toISOString();
  const previousSince = new Date(now - windowHours * 2 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("analytics_events")
    .select("event_name, session_id, user_id, page_path, params, created_at, is_internal")
    .gte("created_at", previousSince)
    .order("created_at", { ascending: false })
    .limit(TRAFFIC_EVENT_ROW_LIMIT);

  if (error) {
    return buildUnavailableTrafficSummary(windowHours, error.message);
  }

  const fetchedRows = (data || []) as AnalyticsEventRow[];
  const truncated = fetchedRows.length >= TRAFFIC_EVENT_ROW_LIMIT;
  // 로컬/개발 등 내부 이벤트는 운영 지표에 섞지 않고 건수만 따로 보고한다.
  const rows = fetchedRows.filter((row) => !isInternalEvent(row));
  const internalEventsExcluded = fetchedRows.filter((row) => row.created_at >= currentSince && isInternalEvent(row)).length;
  const profilesById = await fetchProfilesByUserId(supabase, rows);
  const nonAdminRows = rows.filter((row) => !row.user_id || profilesById.get(row.user_id)?.role !== "admin");
  const currentRows = nonAdminRows.filter((row) => row.created_at >= currentSince);
  const previousRows = nonAdminRows.filter((row) => row.created_at < currentSince && row.created_at >= previousSince);
  const current = summarizeRows(currentRows, profilesById);
  const previous = summarizeRows(previousRows, profilesById);
  const status = current.totalEvents > 0 ? "ready" : "empty";

  return {
    generatedAt: new Date().toISOString(),
    status,
    windowHours,
    current,
    previous,
    changes: buildChanges(current, previous),
    highlights: buildHighlights(current, previous, status, { truncated, internalEventsExcluded }),
    truncated,
    internalEventsExcluded
  };
}

export function renderTrafficSummaryText(summary: TrafficSummary) {
  if (summary.status === "unavailable") {
    return `유저 활동 집계를 조회할 수 없습니다. 원인: ${summary.error || "알 수 없는 오류"}`;
  }
  if (summary.status === "empty") {
    return ["최근 유저 활동 수집 데이터가 아직 없습니다. 배포 후 페이지뷰와 주요 기능 이벤트가 쌓이면 이곳에서 요약됩니다.", ...buildDataQualityNotes(summary)].join("\n");
  }

  const topPages = summary.current.topPages.slice(0, 3).map((item) => `${item.label} ${item.count}회`).join(", ") || "없음";
  const topFeatures = summary.current.topFeatures.slice(0, 3).map((item) => `${item.label} ${item.count}회`).join(", ") || "없음";
  const topUsers = summary.current.topUsers.slice(0, 3).map((item) => `${item.label} ${item.eventCount}건`).join(", ") || "회원 활동 없음";
  return [
    `최근 ${summary.windowHours}시간 유저 활동 요약입니다.`,
    `방문 세션 ${summary.current.uniqueSessions}개(회원 ${summary.current.memberSessions}개, 비회원 ${summary.current.guestSessions}개), 페이지뷰 ${summary.current.pageViews}회, 전체 이벤트 ${summary.current.totalEvents}건입니다.`,
    `전적 검색 ${summary.current.statsSearches}건, AI 기능 ${summary.current.aiFeatureUses}건, 게시판 활동 ${summary.current.boardActions}건, 상자 오픈 ${summary.current.crateOpens}건, 리플레이 열람 ${summary.current.replayOpens}건입니다.`,
    `인기 페이지: ${topPages}`,
    `인기 기능: ${topFeatures}`,
    `활동 많은 회원: ${topUsers}`,
    `변화: 세션 ${formatChange(summary.changes.uniqueSessions)}, 페이지뷰 ${formatChange(summary.changes.pageViews)}, 전적 검색 ${formatChange(summary.changes.statsSearches)}`,
    ...buildDataQualityNotes(summary)
  ].join("\n");
}

async function fetchProfilesByUserId(supabase: any, rows: AnalyticsEventRow[]) {
  const userIds = Array.from(new Set(rows.map((row) => row.user_id).filter(Boolean))) as string[];
  if (!userIds.length) return new Map<string, AnalyticsUserProfile>();

  const { data, error } = await supabase
    .from("profiles")
    .select("id, nickname, role, pubg_nickname")
    .in("id", userIds);

  if (error) return new Map<string, AnalyticsUserProfile>();
  const entries = ((data || []) as AnalyticsUserProfile[]).map((profile) => [profile.id, profile] as const);
  return new Map<string, AnalyticsUserProfile>(entries);
}

function summarizeRows(rows: AnalyticsEventRow[], profilesById: Map<string, AnalyticsUserProfile>): TrafficSummaryWindow {
  const sessions = new Set<string>();
  const sessionHasMember = new Map<string, boolean>();
  const users = new Set<string>();
  const pageCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  const featureCounts = new Map<string, number>();
  const userCounts = new Map<string, AnalyticsEventRow[]>();

  rows.forEach((row) => {
    if (row.session_id) {
      sessions.add(row.session_id);
      sessionHasMember.set(row.session_id, Boolean(sessionHasMember.get(row.session_id) || row.user_id));
    }
    if (row.user_id) {
      users.add(row.user_id);
      userCounts.set(row.user_id, [...(userCounts.get(row.user_id) || []), row]);
    }
    increment(eventCounts, row.event_name || "unknown");

    if (row.event_name === "page_view" && row.page_path) {
      increment(pageCounts, row.page_path);
    }

    const feature = getFeatureLabel(row);
    if (feature) increment(featureCounts, feature);
  });

  return {
    uniqueSessions: sessions.size,
    uniqueUsers: users.size,
    guestSessions: Array.from(sessionHasMember.values()).filter((hasMember) => !hasMember).length,
    memberSessions: Array.from(sessionHasMember.values()).filter(Boolean).length,
    pageViews: rows.filter((row) => row.event_name === "page_view").length,
    totalEvents: rows.length,
    topPages: topItems(pageCounts),
    topEvents: topItems(eventCounts),
    topFeatures: topItems(featureCounts),
    topUsers: topUsers(userCounts, profilesById),
    statsSearches: rows.filter((row) => row.event_name === "stats_searched").length,
    aiFeatureUses: rows.filter((row) => row.event_name === "ai_analysis_opened" || row.event_name === "ai_squad_coaching_requested" || row.params?.feature_name === "ai-coaching").length,
    boardActions: rows.filter((row) => row.event_name === "board_viewed" || row.event_name === "post_viewed" || row.event_name === "post_action").length,
    crateOpens: rows.reduce((sum, row) => row.event_name === "crate_opened" ? sum + Number(row.params?.open_count || 1) : sum, 0),
    replayOpens: rows.filter((row) => row.event_name === "replay_2d_opened" || row.params?.feature_name === "2d-replay" || row.params?.feature_name === "3d-replay").length
  };
}

function topUsers(userCounts: Map<string, AnalyticsEventRow[]>, profilesById: Map<string, AnalyticsUserProfile>): TrafficTopUser[] {
  return Array.from(userCounts.entries())
    .map(([userId, rows]) => {
      const profile = profilesById.get(userId);
      const nickname = profile?.nickname || null;
      const pubgNickname = profile?.pubg_nickname || null;
      return {
        userId,
        label: nickname || pubgNickname || `회원 ${userId.slice(0, 8)}`,
        nickname,
        pubgNickname,
        eventCount: rows.length,
        pageViews: rows.filter((row) => row.event_name === "page_view").length,
        statsSearches: rows.filter((row) => row.event_name === "stats_searched").length,
        aiFeatureUses: rows.filter((row) => row.event_name === "ai_analysis_opened" || row.event_name === "ai_squad_coaching_requested" || row.params?.feature_name === "ai-coaching").length
      };
    })
    .sort((a, b) => b.eventCount - a.eventCount || a.label.localeCompare(b.label))
    .slice(0, 5);
}

function getFeatureLabel(row: AnalyticsEventRow) {
  if (row.event_name === "feature_consumption" && typeof row.params?.feature_name === "string") return row.params.feature_name;
  if (row.event_name === "stats_searched") return "전적 검색";
  if (row.event_name === "ai_analysis_opened" || row.event_name === "ai_squad_coaching_requested") return "AI 분석";
  if (row.event_name === "replay_2d_opened") return "2D 리플레이";
  if (row.event_name === "crate_opened") return "상자 시뮬";
  if (row.event_name === "post_action") return "게시글/댓글";
  if (row.event_name === "weapon_viewed") return "무기 도감";
  if (row.event_name === "map_viewed") return "맵 조회";
  return null;
}

function buildChanges(current: TrafficSummaryWindow, previous: TrafficSummaryWindow) {
  return {
    uniqueSessions: percentChange(current.uniqueSessions, previous.uniqueSessions),
    pageViews: percentChange(current.pageViews, previous.pageViews),
    totalEvents: percentChange(current.totalEvents, previous.totalEvents),
    statsSearches: percentChange(current.statsSearches, previous.statsSearches),
    aiFeatureUses: percentChange(current.aiFeatureUses, previous.aiFeatureUses),
    boardActions: percentChange(current.boardActions, previous.boardActions),
    crateOpens: percentChange(current.crateOpens, previous.crateOpens),
    replayOpens: percentChange(current.replayOpens, previous.replayOpens)
  };
}

function buildDataQualityNotes(summary: Pick<TrafficSummary, "truncated" | "internalEventsExcluded">) {
  const notes: string[] = [];
  if (summary.internalEventsExcluded > 0) {
    notes.push(`내부(로컬/개발) 이벤트 ${summary.internalEventsExcluded}건은 운영 지표에서 제외했습니다.`);
  }
  if (summary.truncated) {
    notes.push(`조회 상한 ${TRAFFIC_EVENT_ROW_LIMIT}건에 도달해 일부 이벤트가 빠졌을 수 있습니다. 수치는 최소값으로 해석하세요.`);
  }
  return notes;
}

function buildHighlights(
  current: TrafficSummaryWindow,
  previous: TrafficSummaryWindow,
  status: TrafficSummary["status"],
  quality: Pick<TrafficSummary, "truncated" | "internalEventsExcluded">
) {
  if (status === "empty") return ["아직 최근 24시간 유저 활동 수집 데이터가 없습니다.", ...buildDataQualityNotes(quality)];
  const highlights = [
    `가장 많이 본 페이지: ${current.topPages[0]?.label || "아직 없음"}`,
    `가장 많이 쓴 기능: ${current.topFeatures[0]?.label || "아직 없음"}`,
    `전적 검색 ${current.statsSearches}건, AI 기능 ${current.aiFeatureUses}건, 게시판 활동 ${current.boardActions}건`
  ];
  const sessionChange = percentChange(current.uniqueSessions, previous.uniqueSessions);
  if (sessionChange !== null) highlights.push(`방문 세션은 이전 기간 대비 ${formatChange(sessionChange)}입니다.`);
  highlights.push(...buildDataQualityNotes(quality));
  return highlights;
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function topItems(map: Map<string, number>, limit = 5): TrafficTopItem[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function formatChange(value: number | null) {
  if (value === null) return "신규 수집";
  if (value === 0) return "변화 없음";
  return `${value > 0 ? "+" : ""}${value}%`;
}
