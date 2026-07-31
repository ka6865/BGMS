/**
 * @fileoverview Overwolf 세션 요약을 웹에서 표시하기 위한 순수 변환 모듈
 *
 * DB 에 적재된 raw 행을 화면이 쓰는 형태로 정리한다.
 * Supabase 나 Next 런타임에 의존하지 않으므로 단위 테스트가 가능하다.
 *
 * 정책 기준:
 *  - GEP 데이터는 PUBG 공식 API 사후 분석을 대체하지 않는 보조 신호다.
 *    화면에서도 "참고값"으로 다루고 확정 분석 근거로 표현하지 않는다.
 *  - 공식 API 조회는 match_id 가 있을 때만 가능하다.
 *    pseudo_match_id 는 Overwolf 생성값이라 조회 키로 쓸 수 없다.
 */

/** 사후 리뷰 타임라인에서 화면이 다루는 이벤트 종류 */
export const TIMELINE_KINDS = ["kill", "death", "knockedout", "revived", "killer"] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type SessionTimelineEntry = {
  kind: TimelineKind;
  /** 매치 시작 기준 경과 초. 시작 시각을 모르면 null */
  elapsedSeconds: number | null;
  /** 경과 초를 mm:ss 로 표기한 값. null 이면 빈 문자열 */
  clock: string;
  detail: string | null;
};

export type SessionSummaryView = {
  sessionId: string;
  /** 공식 PUBG API 로 조회 가능한 match id. 없으면 null */
  officialMatchId: string | null;
  /**
   * BGMS 내부 match_id(UUID). GEP match_id 문자열 끝의 UUID 구간을 추출한 값이다.
   * BGMS 는 텔레메트리를 UUID 기준으로 저장하므로 리플레이 연결에 이 값을 쓴다.
   */
  telemetryMatchId: string | null;
  /** 화면 식별용 id. officialMatchId 가 없으면 pseudo 값이 들어온다 */
  displayMatchId: string | null;
  /** 공식 API 텔레메트리 분석으로 진입할 수 있는지 */
  canOpenAnalysis: boolean;
  /** 해당 매치의 맵 리플레이로 바로 진입할 수 있는지 */
  canOpenReplay: boolean;
  playerId: string | null;
  platform: string | null;
  mapName: string | null;
  matchMode: string | null;
  kills: number;
  headshots: number;
  deaths: number;
  revives: number;
  knockdowns: number;
  maxKillDistance: number | null;
  rankPlace: number | null;
  rankTotal: number | null;
  lastKillerName: string | null;
  matchStartedAt: string | null;
  matchEndedAt: string | null;
  /** 매치 진행 시간(초). 시작/종료 시각이 모두 있을 때만 계산한다 */
  durationSeconds: number | null;
  createdAt: string;
  timeline: SessionTimelineEntry[];
};

export type RawSessionRow = {
  session_id?: unknown;
  match_id?: unknown;
  pseudo_match_id?: unknown;
  player_id?: unknown;
  platform?: unknown;
  gep_summary?: unknown;
  event_timeline?: unknown;
  created_at?: unknown;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readCount(value: unknown): number {
  const parsed = readNumber(value);
  return parsed !== null && parsed >= 0 ? Math.round(parsed) : 0;
}

/**
 * GEP match_id 에서 BGMS 텔레메트리 match_id(UUID)를 추출합니다.
 *
 * GEP 는 `match.bro.official.pc-2018-03.steam.solo.eu.2019.05.07.08.<uuid>` 형태로 주고,
 * BGMS 는 같은 매치를 뒤쪽 UUID 만으로 저장한다(match_master_telemetry.match_id).
 * 따라서 문자열 끝의 UUID 구간을 뽑으면 기존 리플레이/분석 경로에 그대로 넘길 수 있다.
 *
 * 이미 UUID 만 들어온 경우(BGMS 형식)도 그대로 통과시킨다.
 * 형식을 만족하지 못하면 null 을 반환해 잘못된 id 로 리플레이를 열지 않는다.
 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function extractTelemetryMatchId(officialMatchId: string | null): string | null {
  if (!officialMatchId) return null;

  const matched = UUID_PATTERN.exec(officialMatchId);
  if (!matched) return null;

  // UUID 는 여러 번 등장할 수 없는 구조지만, 방어적으로 마지막 구간을 쓴다.
  const all = officialMatchId.match(new RegExp(UUID_PATTERN, "gi"));
  const candidate = all && all.length > 0 ? all[all.length - 1] : matched[0];

  return candidate.toLowerCase();
}

/** 경과 초를 mm:ss 로 표기한다. 1시간을 넘으면 h:mm:ss 로 늘린다. */
export function formatClock(elapsedSeconds: number | null): string {
  if (elapsedSeconds === null || elapsedSeconds < 0) return "";

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function normalizeTimeline(raw: unknown): SessionTimelineEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: SessionTimelineEntry[] = [];

  raw.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;

    const record = item as Record<string, unknown>;
    const kind = readString(record.kind);
    if (!kind || !(TIMELINE_KINDS as readonly string[]).includes(kind)) return;

    const elapsed = readNumber(record.t);
    const elapsedSeconds = elapsed !== null && elapsed >= 0 ? Math.round(elapsed) : null;

    entries.push({
      kind: kind as TimelineKind,
      elapsedSeconds,
      clock: formatClock(elapsedSeconds),
      detail: readString(record.detail)
    });
  });

  // 경과 초 기준 정렬. 시각을 모르는 항목은 뒤로 보낸다.
  return entries.sort((a, b) => {
    if (a.elapsedSeconds === null) return 1;
    if (b.elapsedSeconds === null) return -1;
    return a.elapsedSeconds - b.elapsedSeconds;
  });
}

function readDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;

  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const seconds = Math.round((end - start) / 1000);
  // 12시간을 넘는 값은 시계 오차로 보고 신뢰하지 않는다.
  return seconds >= 0 && seconds <= 43200 ? seconds : null;
}

/**
 * DB raw 행을 화면용 구조로 변환합니다.
 * gep_summary 의 official_match_id 가 없으면 컬럼 match_id 를 대체로 사용합니다.
 * (타임라인 마이그레이션 이전에 적재된 행 호환)
 */
export function toSessionSummaryView(row: RawSessionRow): SessionSummaryView | null {
  const sessionId = readString(row.session_id);
  if (!sessionId) return null;

  const summary =
    row.gep_summary && typeof row.gep_summary === "object" && !Array.isArray(row.gep_summary)
      ? (row.gep_summary as Record<string, unknown>)
      : {};

  const officialMatchId = readString(summary.official_match_id) ?? readString(row.match_id);
  const pseudoMatchId = readString(row.pseudo_match_id);
  const matchStartedAt = readString(summary.match_started_at);
  const matchEndedAt = readString(summary.match_ended_at);
  const telemetryMatchId = extractTelemetryMatchId(officialMatchId);
  const playerId = readString(row.player_id);

  return {
    sessionId,
    officialMatchId,
    telemetryMatchId,
    displayMatchId: officialMatchId ?? pseudoMatchId,
    canOpenAnalysis: Boolean(officialMatchId),
    // 리플레이는 텔레메트리 UUID 와 닉네임이 모두 있어야 열 수 있다.
    canOpenReplay: Boolean(telemetryMatchId && playerId),
    playerId,
    platform: readString(row.platform),
    mapName: readString(summary.map_name),
    matchMode: readString(summary.match_mode),
    kills: readCount(summary.kills),
    headshots: readCount(summary.headshots),
    deaths: readCount(summary.deaths),
    revives: readCount(summary.revives),
    knockdowns: readCount(summary.knockdowns),
    maxKillDistance: readNumber(summary.max_kill_distance),
    rankPlace: readNumber(summary.rank_place),
    rankTotal: readNumber(summary.rank_total),
    lastKillerName: readString(summary.last_killer_name),
    matchStartedAt,
    matchEndedAt,
    durationSeconds: readDuration(matchStartedAt, matchEndedAt),
    createdAt: readString(row.created_at) ?? new Date(0).toISOString(),
    timeline: normalizeTimeline(row.event_timeline)
  };
}

export function toSessionSummaryViews(rows: unknown): SessionSummaryView[] {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => toSessionSummaryView((row || {}) as RawSessionRow))
    .filter((view): view is SessionSummaryView => view !== null);
}

/**
 * 세션에서 BGMS 분석 화면으로 이동할 경로를 만듭니다.
 * 공식 API 조회가 불가능한 세션(pseudo_match_id 만 있는 경우)은 null 을 반환합니다.
 */
export function buildAnalysisPath(view: SessionSummaryView): string | null {
  if (!view.canOpenAnalysis || !view.playerId) return null;

  const platform = view.platform || "steam";

  return `/stats/${encodeURIComponent(platform)}/${encodeURIComponent(view.playerId)}`;
}

/**
 * 세션에서 그 매치의 BGMS 맵 리플레이로 바로 이동하는 경로를 만듭니다.
 * 기존 `/replay/3d` 화면이 `matchId`, `nickname`, `platform` 쿼리를 받으므로 그대로 재사용합니다.
 *
 * `atSeconds` 를 주면 타임라인의 특정 시점으로 진입하도록 `t` 를 붙입니다.
 * 리플레이 화면이 아직 `t` 를 읽지 않아도 무해하며, 지원되면 그 시점으로 점프한다.
 */
export function buildReplayPath(
  view: SessionSummaryView,
  atSeconds?: number | null
): string | null {
  if (!view.canOpenReplay || !view.telemetryMatchId || !view.playerId) return null;

  const params = new URLSearchParams({
    matchId: view.telemetryMatchId,
    nickname: view.playerId,
    platform: view.platform || "steam"
  });

  if (typeof atSeconds === "number" && Number.isFinite(atSeconds) && atSeconds >= 0) {
    params.set("t", String(Math.round(atSeconds)));
  }

  return `/replay/3d?${params.toString()}`;
}
