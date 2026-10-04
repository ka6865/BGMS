import { buildSharedTelemetrySourceKey, parseSharedTelemetrySource } from "./sharedTelemetrySourceContract";
import { createTelemetryPublicIdentity, telemetryPublicIdentityEquals, type TelemetryPlatform } from "./telemetryIdentity";
import { readObjectForVerification } from "./r2Service";
import { gunzipSync } from "node:zlib";
import { TELEMETRY_VERSION } from "./constants";

type ArchiveResult = { events: any[]; source: "shared" | "legacy" | "missing" };

async function readArchiveText(key: string): Promise<string | null> {
  const object = await readObjectForVerification(key);
  if (!object) return null;
  if (object.body.length > 33554432) throw new Error("bluezone-archive-read-failed");
  const body = object.body;
  return (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body, { maxOutputLength: 134217728 }) : body).toString("utf8");
}

function legacyPathMatches(key: string, matchId: string, platform: TelemetryPlatform): boolean {
  const parts = key.split("/");
  return parts.length === 6 && parts[0] === "telemetry-map" && /^v[1-9]\d*$/.test(parts[1])
    && Number(parts[1].slice(1)) <= TELEMETRY_VERSION
    && parts[2] === platform && parts[3] === matchId && /^[a-f0-9]{32}$/.test(parts[4])
    && /^(lite|full)_analyze\.json$/.test(parts[5]);
}

/** 개인 파일은 자기장 추출에만 사용하고 전체 경기 원본으로 승격하지 않는다. */
export function parseBluezoneLegacyEvents(value: unknown, key: string, matchId: string, platform: TelemetryPlatform): any[] | null {
  const parts = key.split("/");
  if (!legacyPathMatches(key, matchId, platform)) return null;
  const version = Number(parts[1].slice(1));
  let events: unknown;
  if (Array.isArray(value)) {
    // 구형 배열의 경기·플랫폼 연결은 DB 경로로 검증한다.
    if (version > 61) return null;
    events = value;
  } else if (value && typeof value === "object") {
    const envelope = value as Record<string, unknown>;
    if (envelope.analyzeFormat !== 2 || envelope.projection !== "full") return null;
    try {
      const actual = createTelemetryPublicIdentity(envelope.identity as Parameters<typeof createTelemetryPublicIdentity>[0]);
      const expected = createTelemetryPublicIdentity({ matchId, platform, playerKey: parts[4], mode: parts[5].startsWith("lite") ? "lite" : "full", telemetryVersion: version });
      if (!telemetryPublicIdentityEquals(actual, expected)) return null;
    } catch { return null; }
    events = envelope.events;
  }
  if (!Array.isArray(events) || !events.length || events.length > 250_000
    || events.some(event => !event || typeof event !== "object" || typeof event._T !== "string")) return null;
  return events;
}

export async function readBluezoneArchive(matchId: string, platform: TelemetryPlatform, storagePath?: string | null,
  download = readArchiveText): Promise<ArchiveResult> {
  const sharedText = await download(buildSharedTelemetrySourceKey(matchId, platform));
  if (sharedText) {
    let source;
    try { source = parseSharedTelemetrySource(JSON.parse(sharedText), matchId, platform); }
    catch { source = null; }
    if (!source) throw new Error("bluezone-shared-source-invalid");
    return { events: source.events, source: "shared" };
  }
  if (storagePath) {
    // master는 지도 파일을 가리키므로 같은 식별자의 분석 입력 경로를 사용한다.
    const analyzePath = /\/(lite|full)\.json$/.test(storagePath)
      ? storagePath.replace(/\.json$/, "_analyze.json") : storagePath;
    // 경로가 다른 경기·플랫폼이면 다운로드도 하지 않는다.
    if (!legacyPathMatches(analyzePath, matchId, platform)) return { events: [], source: "missing" };
    const text = await download(analyzePath);
    if (text) {
      let events;
      try { events = parseBluezoneLegacyEvents(JSON.parse(text), analyzePath, matchId, platform); }
      catch { events = null; }
      if (!events) throw new Error("bluezone-legacy-source-invalid");
      return { events, source: "legacy" };
    }
  }
  return { events: [], source: "missing" };
}

export function safeBluezoneErrorCode(error: unknown): string {
  return error instanceof Error && /^bluezone-[a-z-]+$/.test(error.message)
    ? error.message : "bluezone-unexpected-failure";
}
