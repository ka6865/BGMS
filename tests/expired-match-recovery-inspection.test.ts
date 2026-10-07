import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  inspectExpiredMatchRecovery,
  formatRecoveryInspectionFailure,
  formatRecoverySummary,
  parseRecoveryMatches,
  RECOVERY_DECODED_BYTES_LIMIT,
  RECOVERY_OBJECT_BYTES_LIMIT,
  RECOVERY_STORED_BYTES_LIMIT,
  type RecoveryInspectorDependencies,
  type RecoveryRequest,
} from "../scripts/inspect_expired_match_recovery";
import { buildSharedTelemetrySourceKey } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { buildTelemetryAnalyzeCacheKey, buildTelemetryCacheKey } from "../lib/pubg-analysis/telemetryCacheKey";
import { openRecoveryBytes, sealRecoveryBytes } from "../scripts/r2_recovery_archive";

const matchId = "123e4567-e89b-42d3-a456-426614174000";
const request: RecoveryRequest = { matchId, platform: "steam" };
const outputPath = "/tmp/recovery-proof.enc";
const secret = "test-archive-key";

function deps(overrides: Partial<RecoveryInspectorDependencies> = {}) {
  const writes: Array<{ path: string; bytes: Buffer }> = [];
  const reads: string[] = [];
  const base: RecoveryInspectorDependencies = {
    readRows: async () => [],
    r2Configured: () => true,
    listLegacy: async () => ({ objects: [], pages: 1, truncated: false }),
    readObject: async (key) => {
      reads.push(key);
      const body = Buffer.from("{}", "utf8");
      return { key, etag: `etag:${key}`, sizeBytes: body.length, contentEncoding: null, body };
    },
    seal: sealRecoveryBytes,
    writeCiphertext: async (path, bytes) => { writes.push({ path, bytes }); },
    now: () => 1,
  };
  return { value: { ...base, ...overrides }, writes, reads };
}

describe("expired match recovery inspection", () => {
  it("validates UUID/platform, rejects extra identity fields, duplicate identities and more than 30", () => {
    expect(parseRecoveryMatches(JSON.stringify([request]))).toEqual([request]);
    expect(() => parseRecoveryMatches(JSON.stringify([{ ...request, accountId: "account.secret" }]))).toThrow();
    expect(() => parseRecoveryMatches(JSON.stringify([{ ...request, platform: "invalid" }]))).toThrow();
    expect(() => parseRecoveryMatches(JSON.stringify([request, request]))).toThrow("recovery-match-duplicate");
    const tooMany = Array.from({ length: 31 }, (_, i) => ({
      matchId: `123e4567-e89b-42d3-a456-${String(i).padStart(12, "0")}`,
      platform: "steam",
    }));
    expect(() => parseRecoveryMatches(JSON.stringify(tooMany))).toThrow("recovery-matches-count-invalid");
  });

  it("reports fixed limit failures while hiding arbitrary errors with personal data", () => {
    expect(JSON.parse(formatRecoveryInspectionFailure(new Error("recovery-decoded-size-limit"))).reason).toBe("recovery-decoded-size-limit");
    const output = formatRecoveryInspectionFailure(new Error("account.private/player_nickname/path.json"));
    expect(JSON.parse(output)).toEqual({ error: "recovery-inspection-failed", reason: "unknown" });
    expect(output).not.toContain("account.private");
    expect(output).not.toContain("player_nickname");
  });

  it("fails a DB read before checking or calling R2 and never emits an artifact", async () => {
    const state = deps({ readRows: async () => { throw new Error("db-down"); }, r2Configured: vi.fn(() => true) });
    await expect(inspectExpiredMatchRecovery({ requests: [request], outputPath, secret }, state.value)).rejects.toThrow("db-down");
    expect(state.value.r2Configured).not.toHaveBeenCalled();
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("reads only canonical shared, registry-derived and requested-player legacy paths", async () => {
    const accountId = "account.player-1";
    const nickname = "player_one";
    const identity = { matchId, platform: "steam" as const, playerId: accountId, mode: "full" as const, telemetryVersion: 73 };
    const mapKey = buildTelemetryCacheKey(identity);
    const analysisKey = buildTelemetryAnalyzeCacheKey(identity);
    const legacyKey = `${matchId}_${nickname}_v74_analyze.json`;
    const tables: Record<string, Record<string, unknown>[]> = {
      pubg_player_matches: [{ match_id: matchId, platform: "steam", account_id: accountId, player_id: nickname }],
      telemetry_map_cache_entries: [{ match_id: matchId, platform: "steam", player_id: accountId, mode: "full", telemetry_version: 73, status: "ready", storage_path: mapKey }],
      match_master_telemetry: [{ match_id: matchId, storage_path: mapKey }, { match_id: matchId, storage_path: "untrusted/path" }],
    };
    const state = deps({
      readRows: async (_req, table) => tables[table] ?? [],
      listLegacy: async (prefix) => ({ objects: [
        { key: legacyKey, sizeBytes: 2, etag: "listed" },
        { key: `${matchId}_someone_else_v99_analyze.json`, sizeBytes: 2, etag: "wrong-player" },
        { key: `${matchId}x_${nickname}_v90_analyze.json`, sizeBytes: 2, etag: "wrong-match" },
      ], pages: prefix === `${matchId}_` ? 1 : 0, truncated: false }),
    });
    const summary = await inspectExpiredMatchRecovery({ requests: [request], outputPath, secret }, state.value);
    expect(state.reads).toEqual(expect.arrayContaining([buildSharedTelemetrySourceKey(matchId, "steam"), mapKey, analysisKey, legacyKey]));
    expect(state.reads).not.toContain("untrusted/path");
    expect(state.reads).not.toContain(`${matchId}_someone_else_v99_analyze.json`);
    expect(state.reads).toHaveLength(4);
    expect(summary.databaseTablesRead).toBe(6);
    expect(summary.kinds.other).toBe(3);
    const logLine = formatRecoverySummary(summary);
    for (const privateValue of [matchId, accountId, nickname, mapKey, analysisKey, legacyKey]) {
      expect(logLine).not.toContain(privateValue);
    }
    expect(logLine).not.toContain("bodyBase64");
    expect(state.writes[0].path).toBe(outputPath);
    expect(state.writes[0].bytes.subarray(0, 8).toString()).toBe("BGMSR2v1");
    expect(openRecoveryBytes(state.writes[0].bytes, secret).toString("utf8")).toContain(accountId);
  });

  it("reads a valid registry account before basic binding without accepting another match path", async () => {
    const identity = { matchId, platform: "steam" as const, playerId: "account.unbound", mode: "full" as const, telemetryVersion: 73 };
    const mapKey = buildTelemetryCacheKey(identity);
    const badKey = buildTelemetryCacheKey({ ...identity, matchId: "123e4567-e89b-42d3-a456-426614174999" });
    const state = deps({ readRows: async (_request, table) => table === "pubg_player_matches"
      ? [{ match_id: matchId, platform: "steam", account_id: null, player_id: "unbound_player" }]
      : table === "telemetry_map_cache_entries" ? [
        { match_id: matchId, platform: "steam", player_id: identity.playerId, mode: "full", telemetry_version: 73, status: "ready", storage_path: mapKey },
        { match_id: matchId, platform: "steam", player_id: "account.other", mode: "full", telemetry_version: 73, status: "ready", storage_path: badKey },
      ] : [] });
    await inspectExpiredMatchRecovery({ requests: [request], outputPath, secret }, state.value);
    expect(state.reads).toContain(mapKey);
    expect(state.reads).toContain(buildTelemetryAnalyzeCacheKey(identity));
    expect(state.reads).not.toContain(badKey);
    const payload = JSON.parse(openRecoveryBytes(state.writes[0].bytes, secret).toString("utf8"));
    expect(payload.matches[0].rows.pubg_player_matches[0].account_id).toBeNull();
  });

  it("keeps the shared source and selects the newest legacy versions within eight candidates", async () => {
    const readKeys: string[] = [];
    const versions = Array.from({ length: 12 }, (_, index) => index + 1).map((version) => ({
      key: `${matchId}_player_one_v${version}_analyze.json`, sizeBytes: 2, etag: `v${version}`,
    }));
    const state = deps({
      readRows: async (_req, table) => table === "pubg_player_matches"
        ? [{ match_id: matchId, platform: "steam", player_id: "player_one", account_id: "account.player-1" }]
        : [],
      listLegacy: async () => ({ objects: versions, pages: 1, truncated: true }),
      readObject: async (key) => {
        readKeys.push(key);
        if (key.endsWith("_v12_analyze.json")) return null;
        const body = key.endsWith("_v11_analyze.json")
          ? Buffer.from(JSON.stringify({ matchId, stats: { name: "player_one" } }))
          : Buffer.from("{}");
        return { key, etag: `etag:${key}`, sizeBytes: body.length, contentEncoding: null, body };
      },
    });
    const summary = await inspectExpiredMatchRecovery({ requests: [request], outputPath, secret }, state.value);
    expect(readKeys).toHaveLength(8);
    expect(readKeys[0]).toBe(buildSharedTelemetrySourceKey(matchId, "steam"));
    expect(readKeys).toContain(`${matchId}_player_one_v12_analyze.json`);
    expect(readKeys).toContain(`${matchId}_player_one_v6_analyze.json`);
    expect(readKeys).not.toContain(`${matchId}_player_one_v5_analyze.json`);
    expect(summary.legacyTruncated).toBe(1);
    expect(summary.kinds["full-analysis"]).toBe(1);
    const proof = JSON.parse(openRecoveryBytes(state.writes[0].bytes, secret).toString("utf8"));
    expect(proof.matches[0].skippedCandidateCount).toBe(5);
    expect(proof.matches[0].missingKeys).toEqual([`${matchId}_player_one_v12_analyze.json`]);
    expect(proof.matches[0].legacyListingTruncated).toBe(true);
  });

  it("applies per-object and aggregate stored byte bounds", async () => {
    const tooLarge = deps({ readObject: async (key) => ({ key, etag: "e", sizeBytes: RECOVERY_OBJECT_BYTES_LIMIT + 1,
      contentEncoding: null, body: Buffer.alloc(RECOVERY_OBJECT_BYTES_LIMIT + 1) }) });
    await expect(inspectExpiredMatchRecovery({ requests: [request], outputPath, secret }, tooLarge.value)).rejects.toThrow("recovery-object-size-invalid");
    expect(tooLarge.writes).toHaveLength(0);

    const requests = Array.from({ length: 9 }, (_, i) => ({
      matchId: `123e4567-e89b-42d3-a456-${String(i).padStart(12, "0")}`,
      platform: "steam" as const,
    }));
    const gzipHeader = gzipSync(Buffer.from("{}"));
    const paddedGzip = Buffer.concat([gzipHeader, Buffer.alloc(RECOVERY_OBJECT_BYTES_LIMIT - gzipHeader.length)]);
    const total = deps({ readObject: async (key) => ({ key, etag: "e", sizeBytes: paddedGzip.length,
      contentEncoding: "gzip", body: paddedGzip }) });
    await expect(inspectExpiredMatchRecovery({ requests, outputPath, secret }, total.value)).rejects.toThrow("recovery-total-size-limit");
    expect(total.writes).toHaveLength(0);
    expect(RECOVERY_STORED_BYTES_LIMIT).toBe(8 * RECOVERY_OBJECT_BYTES_LIMIT);
  });

  it("caps gzip expansion before sealing or writing", async () => {
    const expanded = Buffer.alloc(RECOVERY_DECODED_BYTES_LIMIT + 1, 0x61);
    const compressed = gzipSync(expanded);
    expect(compressed.length).toBeLessThan(RECOVERY_OBJECT_BYTES_LIMIT);
    const state = deps({ readObject: async (key) => ({ key, etag: "e", sizeBytes: compressed.length,
      contentEncoding: "gzip", body: compressed }) });
    await expect(inspectExpiredMatchRecovery({ requests: [request], outputPath, secret }, state.value)).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
  });

  it("uploads only the encrypted proof in inspect-recovery mode and skips cleanup/apply stages", async () => {
    const workflow = await readFile(new URL("../.github/workflows/pubg-archive-retention.yml", import.meta.url), "utf8");
    expect(workflow).toContain("options: [dry-run, apply, inspect-recovery]");
    expect(workflow).toContain("inputs.mode == 'inspect-recovery' && 15 || 90");
    expect(workflow).toMatch(/permissions:\n  contents: read\n  actions: read/);
    expect(workflow).toContain('--matches-json "$OP_MATCH_IDS_JSON"');
    expect(workflow).toMatch(/Initialize continuous batch budget\n\s+if: \$\{\{ env\.OP_MODE != 'inspect-recovery' \}\}/);
    expect(workflow).toMatch(/Inspect protected match recovery evidence\n\s+if: \$\{\{ env\.OP_MODE == 'inspect-recovery' \}\}/);
    expect(workflow).toMatch(/Upload encrypted recovery proof[\s\S]*?if: \$\{\{ env\.OP_MODE == 'inspect-recovery' \}\}[\s\S]*?path: \$\{\{ runner\.temp \}\}\/match-retention\/recovery-proof\.enc[\s\S]*?retention-days: 7/);
    expect(workflow).toMatch(/Retain expired match batch 1[\s\S]*?if: \$\{\{ env\.OP_MODE != 'inspect-recovery' \}\}/);
    const batch = await readFile(new URL("../.github/actions/pubg-retention-batch/action.yml", import.meta.url), "utf8");
    expect(batch).toMatch(/Apply exact plan and verify object absence\n\s+if: \$\{\{ steps\.gate\.outputs\.enabled == 'true' && env\.OP_MODE == 'apply'/);
    const source = await readFile(new URL("../scripts/inspect_expired_match_recovery.ts", import.meta.url), "utf8");
    expect(source).toContain('.select("*")');
    expect(source).toContain("skippedCandidateCount");
    expect(source).toContain("missingKeys");
    expect(source).toContain('open(path, "wx", 0o600)');
    expect(source).toContain("RECOVERY_OBJECT_LIMIT = 8");
    expect(source).toContain("console.info(formatRecoverySummary(summary))");
    expect(source).toContain('console.error(formatRecoveryInspectionFailure(error))');
    const r2Service = await readFile(new URL("../lib/pubg-analysis/r2Service.ts", import.meta.url), "utf8");
    const listFunction = r2Service.match(/export async function listR2ObjectsByPrefix\([\s\S]*?^\}/m)?.[0];
    expect(listFunction).toBeDefined();
    expect(listFunction).not.toMatch(/console\.(?:log|info|warn|error)/);
  });
});
