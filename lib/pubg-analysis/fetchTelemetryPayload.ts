import { orderedReplayEvents } from "../replay/orderedEvents";
import getApiUrl from "../api-config";
import {
  parseTelemetryMode,
  parseTelemetryPlatform,
  type TelemetryMode,
  type TelemetryPlatform,
} from "./telemetryIdentity";
import {
  parseTelemetryEnvelope,
  parseTelemetryPayload,
  type TelemetryEnvelope,
  type TelemetryPayload,
} from "./telemetryPayload";

type TelemetryRequest = {
  matchId: string;
  nickname: string;
  platform: TelemetryPlatform;
  mapName?: string;
  mode: TelemetryMode;
};

type TelemetryFetchOptions = {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
};

const MATCH_ID = /^[A-Za-z0-9._-]{1,160}$/;
const NICKNAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const MAP_NAME = /^[^\u0000-\u001f\u007f]{1,80}$/;
const REQUEST_ERROR = "텔레메트리 요청에 실패했습니다.";
const DOWNLOAD_ERROR = "텔레메트리 다운로드에 실패했습니다.";
const VALIDATION_ERROR = "텔레메트리 데이터 검증에 실패했습니다.";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function validateRequest(request: TelemetryRequest): {
  matchId: string;
  nickname: string;
  platform: TelemetryPlatform;
  mode: TelemetryMode;
} {
  if (!MATCH_ID.test(request.matchId)) {
    throw new Error("유효하지 않은 matchId입니다.");
  }

  const nickname = request.nickname.trim();
  if (!NICKNAME.test(nickname)) {
    throw new Error("유효하지 않은 nickname입니다.");
  }
  if (request.mapName !== undefined && !MAP_NAME.test(request.mapName)) {
    throw new Error("유효하지 않은 mapName입니다.");
  }

  return {
    matchId: request.matchId,
    nickname,
    platform: parseTelemetryPlatform(request.platform),
    mode: parseTelemetryMode(request.mode),
  };
}

function envelopeMatchesRequest(
  envelope: TelemetryEnvelope,
  request: ReturnType<typeof validateRequest>,
): boolean {
  return envelope.identity.matchId === request.matchId &&
    envelope.identity.platform === request.platform &&
    envelope.identity.mode === request.mode;
}

async function requestJson(
  fetchFn: typeof fetch,
  input: string,
  signal: AbortSignal | undefined,
  failureMessage: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(input, { signal, cache: "no-store" });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(failureMessage);
  }

  if (!response.ok) throw new Error(failureMessage);

  try {
    return await response.json();
  } catch {
    throw new Error(VALIDATION_ERROR);
  }
}

export async function fetchTelemetryPayload(
  request: TelemetryRequest,
  options: TelemetryFetchOptions = {},
): Promise<TelemetryPayload> {
  const validated = validateRequest(request);
  const query = new URLSearchParams({
    matchId: validated.matchId,
    nickname: validated.nickname,
    platform: validated.platform,
    mode: validated.mode,
  });
  if (request.mapName !== undefined) query.set("mapName", request.mapName);

  const fetchFn = options.fetchFn ?? fetch;
  const envelopeValue = await requestJson(
    fetchFn,
    getApiUrl(`/api/pubg/telemetry?${query.toString()}`),
    options.signal,
    REQUEST_ERROR,
  );

  let envelope: TelemetryEnvelope;
  try {
    envelope = parseTelemetryEnvelope(envelopeValue);
  } catch {
    throw new Error(VALIDATION_ERROR);
  }
  if (!envelopeMatchesRequest(envelope, validated)) {
    throw new Error(VALIDATION_ERROR);
  }

  const payloadValue = await requestJson(
    fetchFn,
    envelope.downloadUrl,
    options.signal,
    DOWNLOAD_ERROR,
  );
  try {
    const payload = parseTelemetryPayload(payloadValue, envelope.identity);
    return { ...payload, events: orderedReplayEvents(payload.events), zoneEvents: orderedReplayEvents(payload.zoneEvents) };
  } catch {
    throw new Error(VALIDATION_ERROR);
  }
}
