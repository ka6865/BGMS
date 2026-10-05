import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createLegacyCopyManifest, readLegacyCopyRecords, sealLegacyCopyManifest, type LegacyCopyManifest } from "./legacyCopyManifest";
import { hasMatchingTelemetryDefinition } from "./telemetrySource";
import type { PlayerMatchRecord } from "../pubg/playerMatches";

export const LEGACY_COPY_KEY = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([a-z0-9._-]+)_v(60|61)_analyze\.json$/;
export type LegacyCopyTarget = { originalKeys: [string, string]; expectedSha256?: string };
export function bodySha256(body: Buffer): string { return createHash("sha256").update(body).digest("hex"); }

export function parseLegacyCopyTargets(value: unknown): LegacyCopyTarget[] {
  const rows = (value as { format?: unknown; pairs?: unknown })?.pairs;
  if (!value || (value as { format?: unknown }).format !== 1 || !Array.isArray(rows) || rows.length < 1 || rows.length > 20) {
    throw new Error("live-copy-targets-invalid");
  }
  const seen = new Set<string>();
  return rows.map(row => {
    const keys = row?.originalKeys;
    if (!Array.isArray(keys) || keys.length !== 2 || keys.some(key => typeof key !== "string" || !LEGACY_COPY_KEY.test(key))) {
      throw new Error("live-copy-targets-invalid");
    }
    const parsed = keys.map(key => LEGACY_COPY_KEY.exec(key)!);
    if (parsed[0][1] !== parsed[1][1] || parsed[0][2] === parsed[1][2] || keys.some(key => seen.has(key))) {
      throw new Error("live-copy-targets-invalid");
    }
    keys.forEach(key => seen.add(key));
    if (row.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(row.expectedSha256)) throw new Error("live-copy-targets-invalid");
    return { originalKeys: keys as [string, string], ...(row.expectedSha256 ? { expectedSha256: row.expectedSha256 } : {}) };
  });
}

export function decodeLegacyCopy(body: Buffer): unknown {
  if (body.length === 0 || body.length > 32 * 1024 * 1024) throw new Error("live-copy-body-bound");
  try {
    return JSON.parse((body[0] === 0x1f && body[1] === 0x8b
      ? gunzipSync(body, { maxOutputLength: 128 * 1024 * 1024 }) : body).toString("utf8"));
  } catch { throw new Error("live-copy-body-invalid"); }
}

export function proveLegacyCopy(input: {
  target: LegacyCopyTarget; bodies: [Buffer, Buffer]; records: PlayerMatchRecord[];
  referenced: boolean; activeLease: boolean; secret: string; now?: number;
}): { equalBytes: boolean; arrayBodies: boolean; definitionVerified: boolean; blockers: string[]; manifest?: LegacyCopyManifest } {
  const blockers: string[] = [];
  const [left, right] = input.bodies.map(body => decodeLegacyCopy(body));
  const sha = input.bodies.map(bodySha256);
  const equalBytes = sha[0] === sha[1];
  if (!equalBytes) blockers.push("bodies-differ");
  if (input.target.expectedSha256 && sha.some(hash => hash !== input.target.expectedSha256)) blockers.push("prior-body-changed");
  const arrayBodies = Array.isArray(left) && Array.isArray(right);
  if (!arrayBodies) blockers.push("legacy-array-unproven");
  const matchId = LEGACY_COPY_KEY.exec(input.target.originalKeys[0])![1];
  const names = input.target.originalKeys.map(key => LEGACY_COPY_KEY.exec(key)![2]);
  const records = names.map(name => input.records.filter(row => row.player_id === name && row.match_id === matchId));
  const recordsUnique = records.every(rows => rows.length === 1) && records[0][0]?.platform === records[1][0]?.platform;
  if (!recordsUnique) blockers.push("db-identity-absent-or-ambiguous");
  const platform = recordsUnique ? records[0][0].platform : null;
  const definitionVerified = (platform === "steam" || platform === "kakao")
    && hasMatchingTelemetryDefinition(left, matchId, platform) && hasMatchingTelemetryDefinition(right, matchId, platform);
  if (!definitionVerified) blockers.push("official-match-definition-missing-or-conflicting");
  if (input.referenced) blockers.push("original-key-still-referenced");
  if (input.activeLease) blockers.push("active-match-lease");
  const now = input.now ?? Date.now();
  if (!recordsUnique || records.some(rows => !Number.isFinite(Date.parse(rows[0]?.played_at))
    || now - Date.parse(rows[0]?.played_at) < 14 * 86400000)) blockers.push("historical-match-age-unproven");
  let manifest: LegacyCopyManifest | undefined;
  if (recordsUnique && (platform === "steam" || platform === "kakao")) {
    try {
      manifest = createLegacyCopyManifest({ matchId, platform, originalKeys: input.target.originalKeys,
        sourceSha256: sha[0], sourceKey: `telemetry-source/legacy-corpus/v1/${sha[0]}.json`,
        records: records.map(rows => rows[0]) as [PlayerMatchRecord, PlayerMatchRecord] });
      readLegacyCopyRecords(sealLegacyCopyManifest(manifest, input.secret), input.bodies[0], input.secret);
    } catch { manifest = undefined; blockers.push("recovery-record-proof-failed"); }
  }
  return { equalBytes, arrayBodies, definitionVerified, blockers, ...(manifest && blockers.length === 0 ? { manifest } : {}) };
}
