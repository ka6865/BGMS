import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { PlayerMatchRecord } from "@/lib/pubg/playerMatches";
import { hasObservedPlayerMatchValues } from "@/lib/pubg/playerMatches";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { openRecoveryBytes, sealRecoveryBytes } from "@/scripts/r2_recovery_archive";
import { hasMatchingTelemetryDefinition } from "./telemetrySource";
import { isCanonicalMatchId, parseTelemetryPlatform, type TelemetryPlatform } from "./telemetryIdentity";

export type LegacyCopyManifest = {
  format: 1;
  matchId: string;
  platform: TelemetryPlatform;
  originalKeys: [string, string];
  sourceKey: string;
  sourceSha256: string;
  records: [PlayerMatchRecord, PlayerMatchRecord];
  checksum: string;
};

type LegacyCopyManifestInput = Omit<LegacyCopyManifest, "format" | "checksum">;
type BasicRecordField = keyof PlayerMatchRecord;
const RECORD_FIELDS: BasicRecordField[] = [
  "player_id", "platform", "match_id", "played_at", "game_mode", "map_name", "kills", "damage", "win_place", "match_type",
  "account_id", "ranking_eligible", "knocks", "survival_time",
];
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const ROOT_KEY = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([a-z0-9._-]+)_v(60|61)_analyze\.json$/;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizePlayerMatchRecord(value: unknown, matchId: string, platform: TelemetryPlatform): PlayerMatchRecord {
  if (!isRecord(value) || !exactKeys(value, RECORD_FIELDS)
    || value.platform !== platform || value.match_id !== matchId
    || typeof value.player_id !== "string" || !value.player_id.trim()
    || typeof value.account_id !== "string" || !/^account\.[A-Za-z0-9_-]+$/.test(value.account_id)
    || !hasObservedPlayerMatchValues(value)) {
    throw new Error("legacy-copy-record-unobserved-or-invalid");
  }
  if (![value.kills, value.damage, value.win_place].every((number) => Number.isSafeInteger(number) && Number(number) >= 0)
    || (value.knocks !== undefined && value.knocks !== null && !Number.isSafeInteger(value.knocks))
    || (value.survival_time !== undefined && value.survival_time !== null && !Number.isSafeInteger(value.survival_time))
    || !Number.isFinite(Date.parse(value.played_at as string))) {
    throw new Error("legacy-copy-record-observation-invalid");
  }

  const record: PlayerMatchRecord = {
    player_id: normalizeName(value.player_id),
    platform,
    match_id: matchId,
    played_at: value.played_at as string,
    game_mode: (value.game_mode as string).trim(),
    map_name: (value.map_name as string).trim(),
    kills: value.kills as number,
    damage: value.damage as number,
    win_place: value.win_place as number,
    match_type: (value.match_type as string).trim(),
    account_id: value.account_id,
  };
  if (value.ranking_eligible !== undefined && value.ranking_eligible !== null) {
    if (typeof value.ranking_eligible !== "boolean") throw new Error("legacy-copy-record-invalid");
    record.ranking_eligible = value.ranking_eligible;
  }
  if (value.knocks !== undefined && value.knocks !== null) record.knocks = value.knocks as number;
  if (value.survival_time !== undefined && value.survival_time !== null) record.survival_time = value.survival_time as number;
  if (!hasObservedPlayerMatchValues(record)) throw new Error("legacy-copy-record-unobserved-or-invalid");
  return record;
}

function normalizeBody(value: unknown): Omit<LegacyCopyManifest, "checksum"> {
  if (!isRecord(value) || value.format !== 1 || !isCanonicalMatchId(value.matchId)) {
    throw new Error("legacy-copy-manifest-invalid");
  }
  const matchId = value.matchId.toLowerCase();
  const platform = parseTelemetryPlatform(value.platform);
  if (!Array.isArray(value.originalKeys) || value.originalKeys.length !== 2
    || value.originalKeys.some((key) => typeof key !== "string")) throw new Error("legacy-copy-manifest-invalid");
  const originalKeys = value.originalKeys as [string, string];
  const parsedKeys = originalKeys.map((key) => ROOT_KEY.exec(key));
  if (parsedKeys.some((match) => !match || match[1] !== matchId)
    || parsedKeys[0]![2] === parsedKeys[1]![2]) throw new Error("legacy-copy-original-keys-invalid");
  if (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || value.sourceKey !== `telemetry-source/legacy-corpus/v1/${value.sourceSha256}.json`) {
    throw new Error("legacy-copy-source-key-invalid");
  }
  if (!Array.isArray(value.records) || value.records.length !== 2) throw new Error("legacy-copy-records-invalid");
  const records = value.records.map((record, index) => {
    const normalized = normalizePlayerMatchRecord(record, matchId, platform);
    if (normalized.player_id !== parsedKeys[index]![2]) throw new Error("legacy-copy-record-key-identity-mismatch");
    return normalized;
  }) as [PlayerMatchRecord, PlayerMatchRecord];
  if (records[0].account_id === records[1].account_id) throw new Error("legacy-copy-account-identity-duplicate");

  return { format: 1, matchId, platform, originalKeys, sourceKey: value.sourceKey, sourceSha256: value.sourceSha256, records };
}

function checksum(body: Omit<LegacyCopyManifest, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function parseManifest(value: unknown): LegacyCopyManifest {
  if (!isRecord(value) || !exactKeys(value, ["format", "matchId", "platform", "originalKeys", "sourceKey", "sourceSha256", "records", "checksum"])
    || typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum)) {
    throw new Error("legacy-copy-manifest-invalid");
  }
  const body = normalizeBody(value);
  if (checksum(body) !== value.checksum) throw new Error("legacy-copy-manifest-checksum-mismatch");
  return { ...body, checksum: value.checksum };
}

export function createLegacyCopyManifest(input: LegacyCopyManifestInput): LegacyCopyManifest {
  const body = normalizeBody({ ...input, format: 1 });
  return { ...body, checksum: checksum(body) };
}

export function sealLegacyCopyManifest(manifest: LegacyCopyManifest, secret: string): Buffer {
  const validated = parseManifest(manifest);
  return sealRecoveryBytes(Buffer.from(JSON.stringify(validated), "utf8"), secret);
}

export function parseLegacyCopyManifest(encrypted: Buffer, secret: string): LegacyCopyManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(openRecoveryBytes(encrypted, secret).toString("utf8")); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("legacy-copy-")) throw error;
    throw new Error("legacy-copy-manifest-decryption-failed");
  }
  return parseManifest(parsed);
}

function decodeSource(sourceBuffer: Buffer): unknown[] {
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0 || sourceBuffer.length > MAX_SOURCE_BYTES) {
    throw new Error("legacy-copy-source-size-invalid");
  }
  let decoded: Buffer;
  try {
    decoded = sourceBuffer[0] === 0x1f && sourceBuffer[1] === 0x8b
      ? gunzipSync(sourceBuffer, { maxOutputLength: MAX_DECODED_BYTES })
      : sourceBuffer;
  } catch { throw new Error("legacy-copy-source-decompression-failed"); }
  if (decoded.length > MAX_DECODED_BYTES) throw new Error("legacy-copy-source-size-invalid");
  try {
    const events: unknown = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(events)) throw new Error();
    return events;
  } catch { throw new Error("legacy-copy-source-json-invalid"); }
}

function hasAccountAndNameEvidence(events: unknown[], accountId: string, nickname: string): boolean {
  const targetName = normalizeName(nickname);
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    const accountMatches = [value.accountId, value.playerId].some((id) => id === accountId);
    const nameMatches = [value.name, value.Name].some((name) => typeof name === "string" && normalizeName(name) === targetName);
    if (accountMatches && nameMatches) return true;
    return Object.values(value).some(visit);
  };
  return events.some(visit);
}

export function readLegacyCopyRecords(encrypted: Buffer, sourceBuffer: Buffer, secret: string): PlayerMatchRecord[] {
  const manifest = parseLegacyCopyManifest(encrypted, secret);
  if (sha256(sourceBuffer) !== manifest.sourceSha256) throw new Error("legacy-copy-source-sha256-mismatch");
  const events = decodeSource(sourceBuffer);
  if (!hasMatchingTelemetryDefinition(events, manifest.matchId, manifest.platform)) {
    throw new Error("legacy-copy-source-identity-mismatch");
  }
  for (const record of manifest.records) {
    if (!hasAccountAndNameEvidence(events, record.account_id!, record.player_id)) {
      throw new Error("legacy-copy-source-player-evidence-missing");
    }
  }
  return manifest.records;
}
