export type TelemetryPlatform = "steam" | "kakao";
export type TelemetryMode = "lite" | "full";

export type TelemetryIdentity = {
  matchId: string;
  platform: TelemetryPlatform;
  playerId: string;
  mode: TelemetryMode;
  telemetryVersion: number;
};

export type TelemetryPublicIdentity = {
  matchId: string;
  platform: TelemetryPlatform;
  playerKey: string;
  mode: TelemetryMode;
  telemetryVersion: number;
};

/** Shared canonical match-id boundary for every public ingest/detail route. */
export const CANONICAL_MATCH_ID = /^[A-Za-z0-9._-]{1,160}$/;
const PLAYER_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const PLAYER_KEY = /^[a-f0-9]{32}$/;

export function isCanonicalMatchId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_MATCH_ID.test(value);
}

/** Official match payloads must preserve the server-provided resource ID. */
export function hasMatchingUpstreamMatchId(payload: unknown, expectedMatchId: string): boolean {
  if (!isCanonicalMatchId(expectedMatchId)) return false;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).id === expectedMatchId;
}

export function parseTelemetryPlatform(value: unknown): TelemetryPlatform {
  if (value === "steam" || value === "kakao") return value;
  throw new Error("지원하지 않는 telemetry platform입니다.");
}

export function parseTelemetryMode(value: unknown): TelemetryMode {
  if (value === "lite" || value === "full") return value;
  throw new Error("지원하지 않는 telemetry mode입니다.");
}

export function createTelemetryIdentity(input: TelemetryIdentity): TelemetryIdentity {
  if (!isCanonicalMatchId(input.matchId)) throw new Error("유효하지 않은 matchId입니다.");
  if (!PLAYER_ID.test(input.playerId)) throw new Error("유효하지 않은 playerId입니다.");
  if (!Number.isFinite(input.telemetryVersion) || input.telemetryVersion <= 0) {
    throw new Error("유효하지 않은 telemetryVersion입니다.");
  }

  return {
    matchId: input.matchId,
    platform: parseTelemetryPlatform(input.platform),
    playerId: input.playerId,
    mode: parseTelemetryMode(input.mode),
    telemetryVersion: input.telemetryVersion,
  };
}

export function createTelemetryPublicIdentity(
  input: TelemetryPublicIdentity,
): TelemetryPublicIdentity {
  if (!isCanonicalMatchId(input.matchId)) throw new Error("유효하지 않은 matchId입니다.");
  if (!PLAYER_KEY.test(input.playerKey)) throw new Error("유효하지 않은 playerKey입니다.");
  if (!Number.isFinite(input.telemetryVersion) || input.telemetryVersion <= 0) {
    throw new Error("유효하지 않은 telemetryVersion입니다.");
  }

  return {
    matchId: input.matchId,
    platform: parseTelemetryPlatform(input.platform),
    playerKey: input.playerKey,
    mode: parseTelemetryMode(input.mode),
    telemetryVersion: input.telemetryVersion,
  };
}

export function telemetryPublicIdentityEquals(
  left: TelemetryPublicIdentity,
  right: TelemetryPublicIdentity,
): boolean {
  return left.matchId === right.matchId &&
    left.platform === right.platform &&
    left.playerKey === right.playerKey &&
    left.mode === right.mode &&
    left.telemetryVersion === right.telemetryVersion;
}
