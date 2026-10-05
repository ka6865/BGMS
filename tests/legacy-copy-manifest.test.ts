import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLegacyCopyManifest,
  parseLegacyCopyManifest,
  readLegacyCopyRecords,
  sealLegacyCopyManifest,
} from "@/lib/pubg-analysis/legacyCopyManifest";
import { playerMatchRecordMatchesLiveRow } from "@/scripts/restore_legacy_player_matches";
import { openRecoveryBytes } from "@/scripts/r2_recovery_archive";

const secret = "legacy-copy-fixture-secret";
const matchId = "12345678-1234-4234-8234-123456789abc";
const records = [
  { player_id: "alice", platform: "steam", match_id: matchId, played_at: "2026-09-20T10:00:00.000Z", game_mode: "squad", map_name: "Baltic_Main", kills: 1, damage: 234, win_place: 3, match_type: "official", account_id: "account.alpha" },
  { player_id: "bob", platform: "steam", match_id: matchId, played_at: "2026-09-20T10:00:00.000Z", game_mode: "squad", map_name: "Baltic_Main", kills: 2, damage: 345, win_place: 2, match_type: "official", account_id: "account.bravo" },
] as const;

function sourceBytes(options: { accounts?: string[]; mapName?: string } = {}) {
  const source = [
    { _T: "LogMatchDefinition", MatchId: `match.steam.pc.${matchId}` },
    { _T: "LogMatchStart", mapName: options.mapName ?? "Baltic_Main" },
    { _T: "LogPlayerPosition", character: { accountId: options.accounts?.[0] ?? "account.alpha", name: "Alice" } },
    { _T: "LogPlayerPosition", character: { accountId: options.accounts?.[1] ?? "account.bravo", name: "Bob" } },
  ];
  return gzipSync(Buffer.from(JSON.stringify(source)));
}

function manifestFor(source = sourceBytes(), rows = [...records]) {
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  return createLegacyCopyManifest({
    matchId, platform: "steam",
    originalKeys: [`${matchId}_alice_v60_analyze.json`, `${matchId}_bob_v61_analyze.json`],
    sourceKey: `telemetry-source/legacy-corpus/v1/${sourceSha256}.json`, sourceSha256,
    records: rows as any,
  });
}

describe("legacy copied-match manifests", () => {
  it("authenticates encrypted manifests and returns records only after exact raw-source proof", () => {
    const source = sourceBytes();
    const encrypted = sealLegacyCopyManifest(manifestFor(source), secret);
    expect(openRecoveryBytes(encrypted, secret).length).toBeGreaterThan(0);
    expect(parseLegacyCopyManifest(encrypted, secret).records).toHaveLength(2);
    expect(readLegacyCopyRecords(encrypted, source, secret)).toEqual(records);
  });

  it("rejects encrypted-manifest tampering, a wrong secret, and source-byte changes", () => {
    const source = sourceBytes();
    const encrypted = sealLegacyCopyManifest(manifestFor(source), secret);
    const damaged = Buffer.from(encrypted);
    damaged[damaged.length - 1] ^= 1;
    expect(() => parseLegacyCopyManifest(damaged, secret)).toThrow();
    expect(() => parseLegacyCopyManifest(encrypted, "wrong-secret")).toThrow();
    expect(() => readLegacyCopyRecords(encrypted, Buffer.concat([source, Buffer.from(" ")]), secret))
      .toThrow("legacy-copy-source-sha256-mismatch");
  });

  it("rejects account evidence bound to another player", () => {
    const wrongAccountSource = sourceBytes({ accounts: ["account.other", "account.bravo"] });
    const wrongAccountEnvelope = sealLegacyCopyManifest(manifestFor(wrongAccountSource), secret);
    expect(() => readLegacyCopyRecords(wrongAccountEnvelope, wrongAccountSource, secret))
      .toThrow("legacy-copy-source-player-evidence-missing");

  });

  it("keeps the official match-definition requirement for raw event arrays", () => {
    const noDefinition = gzipSync(Buffer.from(JSON.stringify([
      { _T: "LogPlayerPosition", character: { accountId: "account.alpha", name: "Alice" } },
      { _T: "LogPlayerPosition", character: { accountId: "account.bravo", name: "Bob" } },
    ])));
    const envelope = sealLegacyCopyManifest(manifestFor(noDefinition), secret);
    expect(() => readLegacyCopyRecords(envelope, noDefinition, secret))
      .toThrow("legacy-copy-source-identity-mismatch");
  });

  it("rejects identical nickname keys and records with absent basic stats", () => {
    const source = sourceBytes();
    const digest = createHash("sha256").update(source).digest("hex");
    const input = {
      matchId, platform: "steam" as const,
      originalKeys: [`${matchId}_alice_v60_analyze.json`, `${matchId}_alice_v61_analyze.json`] as [string, string],
      sourceKey: `telemetry-source/legacy-corpus/v1/${digest}.json`, sourceSha256: digest,
      records: [...records] as any,
    };
    expect(() => createLegacyCopyManifest(input)).toThrow("legacy-copy-original-keys-invalid");
    const noObservedDate = [...records].map((record) => ({ ...record })) as any;
    noObservedDate[0].played_at = "";
    expect(() => createLegacyCopyManifest({ ...input, originalKeys: [`${matchId}_alice_v60_analyze.json`, `${matchId}_bob_v61_analyze.json`], records: noObservedDate }))
      .toThrow("legacy-copy-record-unobserved-or-invalid");
  });

  it("rejects live rows whose canonical account or map differs", () => {
    const expected = records[0];
    const row = { ...expected };
    expect(playerMatchRecordMatchesLiveRow(expected as any, row)).toBe(true);
    expect(playerMatchRecordMatchesLiveRow(expected as any, { ...row, account_id: "account.other" })).toBe(false);
    expect(playerMatchRecordMatchesLiveRow(expected as any, { ...row, map_name: "Desert_Main" })).toBe(false);
  });
});
