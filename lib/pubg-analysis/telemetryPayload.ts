import {
  createTelemetryPublicIdentity,
  telemetryPublicIdentityEquals,
  type TelemetryPublicIdentity,
} from "./telemetryIdentity";
import { decodeReplayEvents, encodeReplayEvents } from "./replayTrackEncoding";

export type TelemetryPayload = {
  identity: TelemetryPublicIdentity;
  startTime: string;
  teammates: string[];
  teamNames: string[];
  events: unknown[];
  zoneEvents: unknown[];
  mapName: string;
};

export type TelemetryEnvelope = {
  downloadUrl: string;
  identity: TelemetryPublicIdentity;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`유효하지 않은 telemetry ${label}입니다.`);
  }
  return value as Record<string, unknown>;
}

function parsePayloadIdentity(value: unknown): TelemetryPublicIdentity {
  const identity = requireRecord(value, "identity");
  return createTelemetryPublicIdentity({
    matchId: identity.matchId as string,
    platform: identity.platform as TelemetryPublicIdentity["platform"],
    playerKey: identity.playerKey as string,
    mode: identity.mode as TelemetryPublicIdentity["mode"],
    telemetryVersion: identity.telemetryVersion as number,
  });
}

function parseDateTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("유효하지 않은 telemetry startTime입니다.");
  }
  return value;
}

function parseMapName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("유효하지 않은 telemetry mapName입니다.");
  }
  return value;
}

function parseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`유효하지 않은 telemetry ${label}입니다.`);
  return value;
}

const PUBLIC_PLAYER_KEY = /^[a-f0-9]{32}$/;
const ACCOUNT_ID_FIELD = /(?:account|player)ids?$/i;

function assertPublicAccountIds(value: unknown, fieldName?: string): void {
  if (typeof value === "string" && fieldName && ACCOUNT_ID_FIELD.test(fieldName)) {
    if (!PUBLIC_PLAYER_KEY.test(value)) {
      throw new Error("텔레메트리 accountId는 공개 키여야 합니다.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertPublicAccountIds(item, fieldName));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value).forEach(([key, item]) => assertPublicAccountIds(item, key));
  }
}

function parseStringArray(value: unknown, label: string): string[] {
  const items = parseArray(value, label);
  if (!items.every((item) => typeof item === "string")) {
    throw new Error(`유효하지 않은 telemetry ${label}입니다.`);
  }
  return items;
}

export function createTelemetryPayload(input: TelemetryPayload): TelemetryPayload {
  return parseTelemetryPayload(input);
}

/** R2 저장용 JSON. 좌표를 선수별 track으로 묶고, 원본과 같게 복원할 수 없으면 기존 형식을 쓴다. */
export function serializeTelemetryPayload(payload: TelemetryPayload): string {
  const encoded = encodeReplayEvents(payload.events);
  return JSON.stringify(encoded ? { ...payload, ...encoded } : payload);
}

export function parseTelemetryPayload(
  value: unknown,
  expectedIdentity?: TelemetryPublicIdentity,
): TelemetryPayload {
  const payload = requireRecord(value, "payload");
  const identity = parsePayloadIdentity(payload.identity);
  if (expectedIdentity && !telemetryPublicIdentityEquals(
    identity,
    createTelemetryPublicIdentity(expectedIdentity),
  )) {
    throw new Error("telemetry identity가 요청과 일치하지 않습니다.");
  }

  const teammates = parseStringArray(payload.teammates, "teammates");
  if (!teammates.every((playerKey) => PUBLIC_PLAYER_KEY.test(playerKey))) {
    throw new Error("텔레메트리 teammate accountId는 공개 키여야 합니다.");
  }
  // encoding이 있으면 track 형식(serializeTelemetryPayload), 없으면 기존 이벤트 배열 형식이다.
  const events = payload.encoding === undefined
    ? parseArray(payload.events, "events")
    : decodeReplayEvents(payload.encoding, payload.events, payload.tracks);
  const zoneEvents = parseArray(payload.zoneEvents, "zoneEvents");
  assertPublicAccountIds(events);
  assertPublicAccountIds(zoneEvents);

  return {
    identity,
    startTime: parseDateTime(payload.startTime),
    teammates,
    teamNames: parseStringArray(payload.teamNames, "teamNames"),
    events,
    zoneEvents,
    mapName: parseMapName(payload.mapName),
  };
}

export function parseTelemetryEnvelope(value: unknown): TelemetryEnvelope {
  const envelope = requireRecord(value, "envelope");
  if (typeof envelope.downloadUrl !== "string" || envelope.downloadUrl.length === 0) {
    throw new Error("유효하지 않은 telemetry downloadUrl입니다.");
  }

  return {
    downloadUrl: envelope.downloadUrl,
    identity: parsePayloadIdentity(envelope.identity),
  };
}
