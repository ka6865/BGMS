import { createHash } from "node:crypto";
import { TELEMETRY_EVENT_ALLOWLIST, filterTelemetryEvents } from "./telemetryContract";
import { hasMatchingUpstreamMatchId, isCanonicalMatchId, parseTelemetryPlatform, type TelemetryPlatform } from "./telemetryIdentity";
import { containsTelemetryAccountEvidence } from "./telemetrySource";

// Independent of player map/result versions: only bump when the event projection changes.
export const SHARED_TELEMETRY_FILTER_VERSION = 1;
const ALLOWED_EVENTS = new Set<string>(TELEMETRY_EVENT_ALLOWLIST);
export type SharedTelemetrySource = {
  sourceFormat: 1;
  filterVersion: number;
  platform: TelemetryPlatform;
  matchId: string;
  matchData: any;
  events: any[];
  checksum: string;
};

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildSharedTelemetrySourceKey(matchId: string, platform: TelemetryPlatform): string {
  if (!isCanonicalMatchId(matchId)) throw new Error("invalid-shared-telemetry-match");
  return `telemetry-source/v${SHARED_TELEMETRY_FILTER_VERSION}/${parseTelemetryPlatform(platform)}/${matchId}.json`;
}

function validMatchMetadata(value: unknown, matchId: string): boolean {
  if (!hasMatchingUpstreamMatchId(value, matchId) || !isRecord(value)) return false;
  const attributes = value.data?.attributes;
  if (!isRecord(attributes) || typeof attributes.createdAt !== "string"
    || !Number.isFinite(Date.parse(attributes.createdAt)) || typeof attributes.gameMode !== "string"
    || !(typeof attributes.mapName === "string" || typeof attributes.mapId === "string")
    || !Array.isArray(value.included)) return false;
  const participants = value.included.filter((item: any) => item?.type === "participant");
  const rosters = value.included.filter((item: any) => item?.type === "roster");
  if (!participants.length || !rosters.length) return false;
  const ids = new Set<string>();
  const accounts = new Set<string>();
  for (const item of participants) {
    const stats = item.attributes?.stats;
    const accountId = stats?.playerId || item.attributes?.accountId;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id)
      || !isRecord(stats) || typeof stats.name !== "string" || !stats.name.trim()
      || typeof accountId !== "string" || !accountId || accounts.has(accountId)) return false;
    if (["kills", "damageDealt", "winPlace", "timeSurvived"].some((field) => (
      typeof stats[field] !== "number" || !Number.isFinite(stats[field]) || stats[field] < 0
    ))) return false;
    ids.add(item.id);
    accounts.add(accountId);
  }
  const assigned = new Set<string>();
  for (const roster of rosters) {
    const refs = roster.relationships?.participants?.data;
    if (typeof roster.id !== "string" || !roster.id || !Array.isArray(refs) || !refs.length) return false;
    for (const ref of refs) {
      if (typeof ref?.id !== "string" || !ids.has(ref.id) || assigned.has(ref.id)) return false;
      assigned.add(ref.id);
    }
  }
  return assigned.size === ids.size;
}

function checksum(source: Omit<SharedTelemetrySource, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function validSourceFields(value: unknown, matchId: string, platform: TelemetryPlatform): value is Omit<SharedTelemetrySource, "checksum"> {
  if (!isRecord(value) || value.sourceFormat !== 1 || value.filterVersion !== SHARED_TELEMETRY_FILTER_VERSION
    || value.matchId !== matchId || value.platform !== platform || !validMatchMetadata(value.matchData, matchId)
    || !Array.isArray(value.events) || !value.events.length) return false;
  return value.events.every((event: unknown) => isRecord(event) && ALLOWED_EVENTS.has(event._T));
}

export function parseSharedTelemetrySource(value: unknown, matchId: string, platform: TelemetryPlatform): SharedTelemetrySource | null {
  if (!isRecord(value) || typeof value.checksum !== "string") return null;
  const storedChecksum = value.checksum;
  if (!validSourceFields(value, matchId, platform)) return null;
  const source: Omit<SharedTelemetrySource, "checksum"> = {
    sourceFormat: 1, filterVersion: SHARED_TELEMETRY_FILTER_VERSION, platform, matchId,
    matchData: value.matchData, events: value.events,
  };
  if (checksum(source) !== storedChecksum) return null;
  return { ...source, checksum: storedChecksum };
}

/** 공식 자산에서 검증한 전체 이벤트만 공통 보관 자료로 구성한다. */
export function createSharedTelemetrySource(matchData: any, platform: TelemetryPlatform, events: any[]): SharedTelemetrySource {
  const matchId = matchData?.data?.id;
  buildSharedTelemetrySourceKey(matchId, platform);
  const projected = filterTelemetryEvents(events, { mode: "full", teamNames: new Set(), teamAccountIds: new Set() });
  const source: Omit<SharedTelemetrySource, "checksum"> = {
    sourceFormat: 1, filterVersion: SHARED_TELEMETRY_FILTER_VERSION, platform, matchId, matchData, events: projected,
  };
  if (!validSourceFields(source, matchId, platform)) throw new Error("invalid-shared-telemetry-source");
  const participants = matchData.included.filter((item: any) => item?.type === "participant");
  if (!participants.some((item: any) => containsTelemetryAccountEvidence(projected, item.attributes.stats.playerId || item.attributes.accountId))) {
    throw new Error("shared-telemetry-account-evidence-missing");
  }
  // Validate fields before hashing, rather than rehashing our own new envelope.
  return { ...source, checksum: checksum(source) };
}
