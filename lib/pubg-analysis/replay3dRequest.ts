import {
  parseTelemetryPlatform,
  type TelemetryPlatform,
} from "./telemetryIdentity";

const DEMO_MATCH_ID = "c88f4f64-4f86-4f44-b40b-629bece6cdcf";
const DEMO_NICKNAME = "KangHeeSung_";
const QUERY_ERROR = "3D 리플레이 query가 누락되었거나 지원되지 않습니다.";

type Replay3DQuery = {
  matchId: string | null;
  nickname: string | null;
  platform: string | null;
};

export type Replay3DRequest = {
  matchId: string;
  nickname: string;
  platform: TelemetryPlatform;
  isDemo: boolean;
};

/**
 * 리플레이 진입 시점(`t` 쿼리, 초 단위)을 밀리초로 해석합니다.
 *
 * Overwolf Companion 세션 타임라인이 교전 시점을 초로 넘길 때 사용합니다.
 * 값이 없거나 해석할 수 없으면 null 을 반환해 재생 위치를 건드리지 않습니다.
 * 24시간을 넘는 값은 신뢰하지 않습니다.
 */
const MAX_START_SECONDS = 86400;

export function parseReplayStartMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_START_SECONDS) return null;

  return Math.round(seconds * 1000);
}

/**
 * 요청된 진입 시점을 실제 재생 가능한 위치로 변환합니다.
 *
 * 아직 텔레메트리가 로드되지 않았거나(재생 구간 0, 플레이어 없음) 요청 시점이 없으면
 * null 을 반환해 현재 재생 위치를 건드리지 않습니다.
 * 매치 길이를 넘는 요청은 끝으로 맞춥니다.
 */
export function resolveReplaySeekMs(input: {
  requestedStartMs: number | null;
  maxTimeMs: number;
  playerCount: number;
}): number | null {
  const { requestedStartMs, maxTimeMs, playerCount } = input;

  if (requestedStartMs === null) return null;
  if (!Number.isFinite(maxTimeMs) || maxTimeMs <= 0) return null;
  if (playerCount <= 0) return null;

  return Math.min(requestedStartMs, maxTimeMs);
}

export function resolveReplay3DRequest(query: Replay3DQuery): Replay3DRequest {
  const values = [query.matchId, query.nickname, query.platform];
  if (values.every((value) => value === null)) {
    return {
      matchId: DEMO_MATCH_ID,
      nickname: DEMO_NICKNAME,
      platform: "steam",
      isDemo: true,
    };
  }
  if (values.some((value) => value === null)) throw new Error(QUERY_ERROR);

  try {
    return {
      matchId: query.matchId as string,
      nickname: query.nickname as string,
      platform: parseTelemetryPlatform(query.platform),
      isDemo: false,
    };
  } catch {
    throw new Error(QUERY_ERROR);
  }
}
