import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeFullResultSourceChecksum } from "../lib/pubg-analysis/matchRetentionCleanup";
import { buildTelemetryCacheKey } from "../lib/pubg-analysis/telemetryCacheKey";

const harness = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  actions: [] as string[],
  failRegistryDeleteAfterRemoving: false,
  recreateConcurrentRegistryOnDeleteFailure: false,
  objectBody: Buffer.from('{"map":"retained"}'),
  failBinding: false,
  failPreservation: false,
}));
const r2 = vi.hoisted(() => ({
  read: vi.fn(),
  deletePersonal: vi.fn(),
  deleteSource: vi.fn(),
  restore: vi.fn(),
  list: vi.fn(),
}));

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

vi.mock("@supabase/supabase-js", () => {
  class Query {
    table: string;
    action = "select";
    filters: Record<string, unknown> = {};
    payload: unknown;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(key: string, value: unknown) {
      if (this.table === "match_master_telemetry" && key === "platform") throw new Error("column platform does not exist");
      this.filters[key] = value;
      return this;
    }
    is(key: string, value: unknown) { this.filters[key] = value; return this; }
    in(key: string, value: unknown) { this.filters[key] = value; return this; }
    lt() { return this; }
    order() { return this; }
    limit() { return this; }
    or() { return this; }
    abortSignal() { return this; }
    update(payload: unknown) { this.action = "update"; this.payload = payload; return this; }
    delete() { this.action = "delete"; return this; }
    insert(payload: unknown) { this.action = "insert"; this.payload = payload; return this; }
    single() { return Promise.resolve(this.result(true)); }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(this.result(false)).then(resolve, reject);
    }
    result(single: boolean) {
      if (this.table === "match_master_telemetry" && this.action === "update") {
        const restoring = (this.payload as any)?.storage_path !== null;
        const step = restoring ? "master-restore" : "master-clear";
        harness.actions.push(step);
        const row = (harness.tables[this.table] ?? []).find((entry) => entry.match_id === this.filters.match_id
          && (restoring ? entry.storage_path === null : entry.storage_path === this.filters.storage_path));
        if (!row) return { data: [], error: null };
        row.storage_path = (this.payload as any).storage_path;
        return { data: [{ match_id: row.match_id }], error: null };
      }
      if (this.table === "telemetry_map_cache_entries" && this.action === "delete") {
        harness.actions.push("registry-delete");
        const rows = harness.tables[this.table] ?? [];
        const index = rows.findIndex((entry) => entry.id === this.filters.id && entry.storage_path === this.filters.storage_path
          && entry.status === this.filters.status && entry.updated_at === this.filters.updated_at);
        if (index < 0) return { data: [], error: null };
        rows.splice(index, 1);
        if (harness.failRegistryDeleteAfterRemoving) {
          if (harness.recreateConcurrentRegistryOnDeleteFailure) rows.push({
            ...registrySnapshot, storage_path: "concurrent/replacement", lease_token: "active-lease",
          });
          return { data: null, error: { message: "ambiguous delete response" } };
        }
        return { data: [{ id: this.filters.id }], error: null };
      }
      if (this.table === "telemetry_map_cache_entries" && this.action === "insert") {
        harness.actions.push("registry-insert");
        harness.tables[this.table].push(this.payload);
        return { data: [this.payload], error: null };
      }
      if (this.table === "pubg_archive_cleanup_cursor" && this.action === "update") {
        harness.actions.push("cursor-cas-update");
        const row = (harness.tables[this.table] ?? []).find((entry) => entry.id === this.filters.id
          && entry.generation === this.filters.generation);
        if (!row) return { data: [], error: null };
        Object.assign(row, this.payload);
        return { data: [{ id: row.id }], error: null };
      }
      let rows = (harness.tables[this.table] ?? []).filter((row) => Object.entries(this.filters)
        .every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
      if (this.table === "telemetry_map_cache_entries" && single) {
        harness.actions.push("registry-read-for-restore");
        rows = rows.slice(0, 1);
      }
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
  }
  return { createClient: vi.fn(() => ({ from: (table: string) => new Query(table),
    rpc: (name: string, args: any) => {
      if (name === 'list_retention_archive_candidates') return new Query('pubg_player_matches');
      if (name !== 'bind_retention_legacy_accounts') throw new Error('unexpected-rpc');
      return { abortSignal: async () => {
        harness.actions.push('legacy-binding');
        if (harness.failBinding) return { data: null, error: { code: '40001' } };
        const linked = args.p_bindings.map((proof: any) => {
          const row = harness.tables.pubg_player_matches.find(row => row.match_id === proof.before.match_id
            && row.platform === proof.before.platform && row.player_id === proof.before.player_id);
          row.account_id = proof.accountId; return { ...row };
        });
        return { data: linked, error: null };
      } };
    },
  })) };
});

vi.mock('../scripts/preserve_match_performance', () => ({
  preservePerformanceRows: async (_db: unknown, rows: any[]) => {
    if (!rows.length) return 0;
    harness.actions.push('preserve-performance');
    if (harness.failPreservation) throw new Error('preserve-performance-readback-failed');
    harness.tables.pubg_match_performance.push(...rows);
    return rows.length;
  },
}));

vi.mock("../lib/pubg-analysis/r2Service", () => ({
  isR2Configured: vi.fn(() => true),
  readObjectForVerification: r2.read,
  deleteExpiredPersonalMatchObjectFromR2: r2.deletePersonal,
  deleteExpiredMatchSourceFromR2: r2.deleteSource,
  restoreR2ObjectFromRetentionBackup: r2.restore,
  listR2ObjectsByPrefix: r2.list,
  decodeMaybeGzip: (body: Buffer) => body.toString("utf8"),
}));

vi.mock("../scripts/r2_recovery_archive", () => ({
  sealRecoveryBytes: (body: Buffer) => body,
  openRecoveryBytes: (body: Buffer) => body,
}));

const accountId = "account.Retention";
const playerId = "retention-player";
const matchId = "match-retention-1";
const platform = "steam";
const playedAt = "2026-09-01T00:00:00.000Z";
const fixedNow = Date.parse("2026-10-06T00:00:00.000Z");
const mapKey = buildTelemetryCacheKey({ matchId, platform, playerId: accountId, mode: "full", telemetryVersion: 73 });
const fullResult = { data: { id: matchId, attributes: { createdAt: playedAt } }, detail: "source snapshot" };
const registrySnapshot = {
  id: 17, match_id: matchId, platform, player_id: accountId, mode: "full", telemetry_version: 73,
  storage_path: mapKey, status: "ready", lease_token: null, lease_expires_at: null, updated_at: "2026-09-02T00:00:00.000Z",
};

function basic(overrides: Record<string, unknown> = {}) {
  return {
    account_id: accountId, player_id: playerId, platform, match_id: matchId, played_at: playedAt,
    game_mode: "squad", map_name: "Baltic_Main", kills: 2, damage: 180, win_place: 3, match_type: "competitive",
    ...overrides,
  };
}

function performance(overrides: Record<string, unknown> = {}) {
  return {
    platform, account_id: accountId, match_id: matchId, player_id: playerId, played_at: playedAt,
    source_checksum: computeFullResultSourceChecksum(fullResult), summary_version: 1,
    summary: { matchId, stats: { name: playerId, playerId: accountId, kills: 2, damageDealt: 180, winPlace: 3 } },
    ...overrides,
  };
}

function makeRead() {
  const etag = '"archive-etag"';
  const sha256 = createHash("sha256").update(harness.objectBody).digest("hex");
  r2.read.mockImplementation(async (key: string) => key === mapKey ? {
    key, etag, sizeBytes: harness.objectBody.length, contentType: "application/json", contentEncoding: null,
    body: Buffer.from(harness.objectBody),
  } : null);
  return { etag, sha256, sizeBytes: harness.objectBody.length };
}

let dir: string;
let manifestPath: string;
let backupPath: string;
let cleanup: (argv: string[], env: Record<string, string | undefined>) => Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(Date, "now").mockReturnValue(fixedNow);
  dir = await mkdtemp(join(tmpdir(), "match-retention-cli-"));
  manifestPath = join(dir, "plan.json");
  backupPath = join(dir, "backup.bin");
  harness.tables = {
    pubg_player_matches: [basic()],
    processed_match_telemetry: [{ match_id: matchId, platform, player_id: playerId, data: { fullResult } }],
    pubg_match_performance: [performance()],
    telemetry_map_cache_entries: [{ ...registrySnapshot }],
    match_master_telemetry: [],
    pubg_player_match_discovery: [],
    pubg_performance_jobs: [],
    global_benchmarks: [],
    pubg_archive_cleanup_cursor: [{ id: 1, played_at: null, platform: null, match_id: null, generation: 4 }],
  };
  harness.actions = [];
  harness.failRegistryDeleteAfterRemoving = false;
  harness.recreateConcurrentRegistryOnDeleteFailure = false;
  harness.failBinding = false;
  harness.failPreservation = false;
  harness.objectBody = Buffer.from('{"map":"retained"}');
  r2.read.mockReset();
  r2.deletePersonal.mockReset().mockImplementation(async () => { harness.actions.push("r2-delete"); return { deleted: true }; });
  r2.deleteSource.mockReset();
  r2.restore.mockReset().mockImplementation(async () => { harness.actions.push("r2-restore"); });
  r2.list.mockReset().mockResolvedValue({ objects: [], pages: 1, truncated: false });
  makeRead();
  const cleanupModule = await import("../scripts/cleanup_expired_match_archives");
  cleanup = cleanupModule.runExpiredMatchArchiveCleanup;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function args(mode: "prepare" | "apply") {
  return [
    ...(mode === "prepare" ? ["--prepare-backup"] : ["--apply", "--backup-upload-verified"]),
    "--platform", platform, "--account-id", accountId, "--limit", "1", "--manifest", manifestPath,
    "--backup-artifact", backupPath,
  ];
}

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  CLOUDFLARE_R2_ENDPOINT: "https://r2.example.test",
  R2_RECOVERY_ARCHIVE_KEY: "unit-test-secret",
};

describe("expired match archive CLI apply protocol", () => {
  function legacyFixture() {
    const legacyMatch = '37466cd0-d4ac-4b1c-81c9-fb6d358b0bec';
    const original = basic({ match_id: legacyMatch, account_id: null });
    const full = { matchId: legacyMatch, platform, player_id: playerId, createdAt: playedAt,
      gameMode: 'squad', mapName: '에란겔', matchType: 'competitive', v: 72,
      stats: { name: playerId, playerId: accountId, kills: 2, damageDealt: 180, winPlace: 3 },
      teamImpact: { damageImpact: 1.25 }, benchmark: { score: 70, tier: 'A' } };
    const key = `${legacyMatch}_${playerId}_v60_analyze.json`;
    harness.tables.pubg_player_matches = [original];
    harness.tables.processed_match_telemetry = [{ match_id: legacyMatch, platform, player_id: playerId, data: { fullResult: full } }];
    harness.tables.pubg_match_performance = [];
    harness.tables.telemetry_map_cache_entries = [];
    r2.read.mockImplementation(async readKey => readKey === key ? {
      key, etag: '"legacy-etag"', sizeBytes: harness.objectBody.length, body: harness.objectBody,
      contentType: 'application/json', contentEncoding: null,
    } : null);
    r2.list.mockResolvedValue({ objects: [{ key, sizeBytes: harness.objectBody.length }], pages: 1, truncated: false });
    return { legacyMatch, original, full, key };
  }

  it('keeps dry-run read-only and protects legacy rows whose account is not linked', async () => {
    legacyFixture();
    await cleanup(['--platform', 'all', '--manifest', manifestPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects).toHaveLength(0);
    expect(plan.matches[0].reasons).toContain('account_references_unknown');
    expect(harness.actions).toEqual([]);
    expect(harness.tables.pubg_player_matches[0].account_id).toBeNull();
  });

  it('binds and preserves legacy DB performance before backing up and deleting its expired events', async () => {
    const { legacyMatch, original, key } = legacyFixture();
    const prep = ['--prepare-backup', '--preserve-performance', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath, '--backup-artifact', backupPath];
    await cleanup(prep, env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects.map((o: any) => o.key)).toEqual([key]);
    expect(plan.preservation).toEqual({ linkedAccounts: 1, savedSummaries: 1, recoveredSummaries: 0 });
    expect(harness.actions).toEqual(['legacy-binding', 'preserve-performance']);
    expect(harness.tables.pubg_player_matches[0]).toEqual({ ...original, account_id: accountId });
    expect(harness.tables.pubg_match_performance[0]).toMatchObject({ match_id: legacyMatch,
      summary: { teamImpact: { damageImpact: 1.25 } }, score: 70, tier: 'A', ranking_eligible: false });
    await cleanup(['--apply', '--backup-upload-verified', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    expect(harness.actions.indexOf('r2-delete')).toBeGreaterThan(harness.actions.indexOf('preserve-performance'));
    expect(harness.tables.pubg_player_matches).toHaveLength(1);
    expect(harness.tables.pubg_match_performance).toHaveLength(1);
  });

  it.each(['failBinding', 'failPreservation'] as const)('does not prepare a deletion when %s is true', async failure => {
    legacyFixture(); harness[failure] = true;
    await expect(cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--manifest', manifestPath,
      '--backup-artifact', backupPath], env)).rejects.toThrow(failure === 'failBinding'
      ? 'retention-account-binding-unverified' : 'preserve-performance-readback-failed');
    expect(r2.deletePersonal).not.toHaveBeenCalled();
    await expect(readFile(backupPath)).rejects.toThrow();
  });

  it('moves beyond a truncated legacy listing containing only protected keys', async () => {
    r2.read.mockResolvedValue(null);
    r2.list.mockResolvedValue({ objects: [], pages: 1, truncated: true });
    await cleanup(['--platform', 'all', '--manifest', manifestPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.nextCursor).toEqual({ played_at: playedAt, platform, match_id: matchId });
    expect(plan.matches[0].reasons).toContain('legacy_listing_truncated');
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('inspects more than 20 objects from one match rather than moving past uninspected maps', async () => {
    harness.tables.telemetry_map_cache_entries = Array.from({ length: 26 }, (_, i) => ({ ...registrySnapshot,
      id: 100 + i, telemetry_version: 50 + i,
      storage_path: buildTelemetryCacheKey({ matchId, platform, playerId: accountId, mode: 'full', telemetryVersion: 50 + i }),
    }));
    const keys = new Set(harness.tables.telemetry_map_cache_entries.map(row => row.storage_path));
    r2.read.mockImplementation(async (key: string) => keys.has(key) ? {
      key, etag: '"etag"', sizeBytes: harness.objectBody.length, body: harness.objectBody,
      contentType: 'application/json', contentEncoding: null,
    } : null);
    await cleanup(['--prepare-backup', '--platform', 'all', '--limit', '50', '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects).toHaveLength(26);
    expect(new Set(plan.objects.map((p: any) => p.key)).size).toBe(26);
  });

  it('keeps cursor before a partly planned match when object count limit is reached', async () => {
    const second = { ...registrySnapshot, id: 18, mode: 'lite',
      storage_path: buildTelemetryCacheKey({ matchId, platform, playerId: accountId, mode: 'lite', telemetryVersion: 73 }) };
    harness.tables.telemetry_map_cache_entries.push(second);
    const keys = new Set([mapKey, second.storage_path]);
    r2.read.mockImplementation(async (key: string) => keys.has(key) ? {
      key, etag: '"etag"', sizeBytes: harness.objectBody.length, body: harness.objectBody,
      contentType: 'application/json', contentEncoding: null,
    } : null);
    const prior = { played_at: '2026-08-31T00:00:00Z', platform, match_id: 'previous-match' };
    Object.assign(harness.tables.pubg_archive_cleanup_cursor[0], prior);
    await cleanup(['--prepare-backup', '--platform', 'all', '--limit', '1', '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects).toHaveLength(1);
    expect(plan.nextCursor).toEqual(prior);
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('refuses write-enabled preservation during dry-run or apply verification', async () => {
    await expect(cleanup(['--preserve-performance', '--platform', 'all', '--manifest', manifestPath], env)).rejects.toThrow('cli-arguments-invalid');
    await expect(cleanup(['--preserve-performance', ...args('apply')], env)).rejects.toThrow('cli-arguments-invalid');
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('keeps a map and registry when its analysis does not fit the remaining backup byte budget', async () => {
    const second = { ...registrySnapshot, id: 18, mode: 'lite',
      storage_path: buildTelemetryCacheKey({ matchId, platform, playerId: accountId, mode: 'lite', telemetryVersion: 73 }) };
    harness.tables.telemetry_map_cache_entries.push(second);
    const analyzeKeys = [mapKey, second.storage_path].map(key => key.replace(/\.json$/, '_analyze.json'));
    const allKeys = new Set([mapKey, second.storage_path, ...analyzeKeys]);
    r2.read.mockImplementation(async (key: string) => allKeys.has(key) ? {
      key, etag: '"etag"', sizeBytes: analyzeKeys.includes(key) ? 20 * 1024 * 1024 : 18,
      body: harness.objectBody, contentType: 'application/json', contentEncoding: null,
    } : null);
    await cleanup(['--platform', 'all', '--limit', '50', '--manifest', manifestPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects.map((p: any) => p.key)).toEqual([analyzeKeys[0], mapKey]);
    expect(plan.nextCursor).toBeNull();
    expect(harness.tables.telemetry_map_cache_entries).toHaveLength(2);
  });

  it("prepare-backup manifest를 그대로 apply하고 새 plan identity를 만들지 않는다", async () => {
    await cleanup(args("prepare"), env);
    const prepared = await readFile(manifestPath, "utf8");
    const plan = JSON.parse(prepared);
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0]).toMatchObject({ key: mapKey, registrySnapshot });

    await cleanup(args("apply"), { ...env, R2_RETENTION_BACKUP_UPLOAD_VERIFIED: "true" });

    expect(await readFile(manifestPath, "utf8")).toBe(prepared);
    expect(r2.deletePersonal).toHaveBeenCalledTimes(1);
    expect(harness.actions).toEqual(["r2-delete", "registry-delete"]);
  });

  it("apply가 읽은 manifest가 prepare-backup 이후 바뀌면 backup plan digest에서 차단한다", async () => {
    await cleanup(args("prepare"), env);
    const changed = JSON.parse(await readFile(manifestPath, "utf8"));
    changed.planId = "changed-after-backup";
    await (await import("node:fs/promises")).writeFile(manifestPath, JSON.stringify(changed));

    await expect(cleanup(args("apply"), { ...env, R2_RETENTION_BACKUP_UPLOAD_VERIFIED: "true" }))
      .rejects.toThrow("retention-backup-plan-mismatch");
    expect(r2.deletePersonal).not.toHaveBeenCalled();
    expect(harness.actions).toEqual([]);
  });

  it("global scan은 저장된 per-match platform proof를 적용하고 삭제 후 cursor generation을 CAS 갱신한다", async () => {
    const allArgs = ["--prepare-backup", "--platform", "all", "--limit", "1", "--manifest", manifestPath, "--backup-artifact", backupPath];
    await cleanup(allArgs, env);
    const plan = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(plan.platform).toBe("all");
    expect(plan.objects[0].platform).toBe(platform);
    expect(plan.cursorGeneration).toBe(4);
    expect(plan.nextCursor).toEqual({ played_at: playedAt, platform, match_id: matchId });

    const applyArgs = ["--apply", "--backup-upload-verified", ...allArgs.slice(1)];
    await cleanup(applyArgs, { ...env, R2_RETENTION_BACKUP_UPLOAD_VERIFIED: "true" });

    expect(harness.tables.pubg_archive_cleanup_cursor[0]).toMatchObject({
      played_at: playedAt, platform, match_id: matchId, generation: 5,
    });
    expect(harness.actions).toEqual(["r2-delete", "registry-delete", "cursor-cas-update"]);
  });

  it.each([
    ["new unpreserved account reference", () => harness.tables.pubg_player_matches.push(basic({
      account_id: "account.NewReference", player_id: "new-player",
    }))],
    ["compact checksum change", () => { harness.tables.pubg_match_performance[0].source_checksum = "f".repeat(64); }],
  ])("apply-time %s blocks every delete", async (_label, mutate) => {
    await cleanup(args("prepare"), env);
    mutate();

    await expect(cleanup(args("apply"), { ...env, R2_RETENTION_BACKUP_UPLOAD_VERIFIED: "true" }))
      .rejects.toThrow("retention-final-evidence-changed");
    expect(r2.deletePersonal).not.toHaveBeenCalled();
    expect(r2.deleteSource).not.toHaveBeenCalled();
    expect(harness.actions).toEqual([]);
  });

  it("master pointer를 먼저 비우고 registry 삭제가 모호하게 실패하면 객체·pointer·registry snapshot을 복원한다", async () => {
    harness.tables.match_master_telemetry = [{ match_id: matchId, storage_path: mapKey }];
    await cleanup(args("prepare"), env);
    harness.failRegistryDeleteAfterRemoving = true;

    await expect(cleanup(args("apply"), { ...env, R2_RETENTION_BACKUP_UPLOAD_VERIFIED: "true" }))
      .rejects.toThrow("retention-registry-cleanup-failed");

    expect(harness.actions).toEqual([
      "r2-delete", "master-clear", "registry-delete", "r2-restore", "master-restore",
      "registry-read-for-restore", "registry-insert",
    ]);
    expect(harness.tables.match_master_telemetry[0].storage_path).toBe(mapKey);
    expect(harness.tables.telemetry_map_cache_entries).toEqual([registrySnapshot]);
  });

  it("platform 열이 없는 운영 master pointer를 정확한 경로로 비우고 다른 경기는 보존한다", async () => {
    harness.tables.match_master_telemetry = [
      { match_id: matchId, storage_path: mapKey },
      { match_id: "other-match", storage_path: "other/object" },
    ];
    await cleanup(args("prepare"), env);
    await cleanup(args("apply"), env);

    expect(harness.tables.match_master_telemetry).toEqual([
      { match_id: matchId, storage_path: null },
      { match_id: "other-match", storage_path: "other/object" },
    ]);
    expect(harness.actions).toEqual(["r2-delete", "master-clear", "registry-delete"]);
  });

  it("rollback은 동시 생성된 registry identity와 활성 lease를 덮어쓰지 않는다", async () => {
    await cleanup(args("prepare"), env);
    harness.failRegistryDeleteAfterRemoving = true;
    harness.recreateConcurrentRegistryOnDeleteFailure = true;

    await expect(cleanup(args("apply"), { ...env, R2_RETENTION_BACKUP_UPLOAD_VERIFIED: "true" }))
      .rejects.toThrow("retention-delete-failed-restore-unverified");

    expect(harness.tables.telemetry_map_cache_entries).toEqual([{
      ...registrySnapshot, storage_path: "concurrent/replacement", lease_token: "active-lease",
    }]);
    expect(harness.actions).not.toContain("registry-insert");
  });
});
