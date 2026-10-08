import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeFullResultSourceChecksum } from "../lib/pubg-analysis/matchRetentionCleanup";
import { buildTelemetryCacheKey, buildTelemetryPublicIdentity } from "../lib/pubg-analysis/telemetryCacheKey";
import { buildRetainedPerformanceRow } from '../lib/pubg/retainedPerformance';
import { legacyTeamRecoveryInput } from './fixtures/legacy-team-retention';

const harness = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  actions: [] as string[],
  failRegistryDeleteAfterRemoving: false,
  recreateConcurrentRegistryOnDeleteFailure: false,
  objectBody: Buffer.from('{"map":"retained"}'),
  failBinding: false,
  failPreservation: false,
  projectRegistryColumns: false,
}));
const r2 = vi.hoisted(() => ({
  read: vi.fn(),
  deletePersonal: vi.fn(),
  deleteSource: vi.fn(),
  restore: vi.fn(),
  list: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

vi.mock("@supabase/supabase-js", () => {
  class Query {
    table: string;
    action = "select";
    filters: Record<string, unknown> = {};
    payload: unknown;
    columns = '*';
    constructor(table: string) { this.table = table; }
    select(columns = '*') { this.columns = columns; return this; }
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
      if (harness.projectRegistryColumns && this.table === 'telemetry_map_cache_entries'
        && this.action === 'select' && this.columns !== '*') {
        rows = rows.map(row => Object.fromEntries(this.columns.split(',').map(key => [key, row[key]])));
      }
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
  }
  return { createClient: vi.fn(() => ({ from: (table: string) => new Query(table),
    rpc: (name: string, args: any) => {
      if (name === 'list_retention_archive_candidates') return new Query('pubg_player_matches');
      if (name === 'recover_retention_legacy_map') return { abortSignal: async () => {
        harness.actions.push('legacy-map-recovery');
        if (harness.failBinding) return { data: null, error: { code: '40001' } };
        const packet = args.p_packet;
        const index = harness.tables.pubg_player_matches.findIndex(row => row.match_id === packet.before.match_id
          && row.platform === packet.before.platform && row.player_id === packet.before.player_id);
        harness.tables.pubg_player_matches[index] = { ...packet.expectedBasic };
        harness.tables.pubg_match_performance.push(packet.performance);
        return { data: { saved: true, basic: { ...packet.expectedBasic } }, error: null };
      } };
      if (name === 'recover_retention_legacy_team') return { abortSignal: async () => {
        harness.actions.push('legacy-team-recovery');
        if (harness.failBinding) return { data: null, error: { code: '40001' } };
        const packet = args.p_packet;
        const index = harness.tables.pubg_player_matches.findIndex(row => row.match_id === packet.before.match_id
          && row.platform === packet.before.platform && row.player_id === packet.before.player_id);
        harness.tables.pubg_player_matches[index] = { ...packet.expectedBasic };
        harness.tables.pubg_match_performance.push(packet.performance);
        return { data: { saved: true, basic: { ...packet.expectedBasic } }, error: null };
      } };
      if (name !== 'bind_retention_legacy_accounts') throw new Error('unexpected-rpc');
      return { abortSignal: async () => {
        harness.actions.push('legacy-binding');
        if (harness.failBinding) return { data: null, error: { code: '40001' } };
        const linked = args.p_bindings.map((proof: any) => {
          const row = harness.tables.pubg_player_matches.find(row => row.match_id === proof.before.match_id
            && row.platform === proof.before.platform && row.player_id === proof.before.player_id);
          row.account_id = proof.accountId;
          if (row.match_type === 'unknown' || row.match_type === 'unavailable') row.match_type = proof.processed.data.fullResult.matchType;
          return { ...row };
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
  getR2BucketUsage: r2.usage,
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
  harness.projectRegistryColumns = false;
  harness.objectBody = Buffer.from('{"map":"retained"}');
  r2.read.mockReset();
  r2.deletePersonal.mockReset().mockImplementation(async () => { harness.actions.push("r2-delete"); return { deleted: true }; });
  r2.deleteSource.mockReset();
  r2.restore.mockReset().mockImplementation(async () => { harness.actions.push("r2-restore"); });
  r2.list.mockReset().mockResolvedValue({ objects: [], pages: 1, truncated: false });
  r2.usage.mockReset().mockResolvedValue({ configured: true, truncated: false, totalSizeBytes: 12345, fileCount: 50 });
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
  function multipleMatches(count: number, withAnalysis = false) {
    const ids = Array.from({ length: count }, (_, i) => `match-retention-${i + 1}`);
    const maps = ids.map(id => buildTelemetryCacheKey({ matchId: id, platform, playerId: accountId, mode: 'full', telemetryVersion: 73 }));
    harness.tables.pubg_player_matches = ids.map(id => basic({ match_id: id }));
    harness.tables.processed_match_telemetry = ids.map(id => ({ match_id: id, platform, player_id: playerId,
      data: { fullResult: { ...fullResult, data: { ...fullResult.data, id } } } }));
    harness.tables.pubg_match_performance = ids.map((id, i) => performance({ match_id: id,
      summary: { ...performance().summary, matchId: id },
      source_checksum: computeFullResultSourceChecksum(harness.tables.processed_match_telemetry[i].data.fullResult) }));
    harness.tables.telemetry_map_cache_entries = ids.map((id, i) => ({ ...registrySnapshot, id: 17 + i, match_id: id, storage_path: maps[i] }));
    const keys = new Set(maps.flatMap(key => withAnalysis ? [key, key.replace(/\.json$/, '_analyze.json')] : [key]));
    const read = async (key: string) => keys.has(key) ? { key, etag: '"archive-etag"', sizeBytes: harness.objectBody.length,
      contentType: 'application/json', contentEncoding: null, body: Buffer.from(harness.objectBody) } : null;
    r2.read.mockImplementation(read);
    const scope = ['--platform', 'all', '--limit', String(count * (withAnalysis ? 2 : 1)),
      '--manifest', manifestPath, '--backup-artifact', backupPath];
    return { ids, maps, read, scope };
  }

  it('서로 다른 경기 세 개를 겹쳐 검사해도 제한된 첫 경기 이전에 커서를 유지한다', async () => {
    const h = multipleMatches(4, true);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Set<string>();
    r2.read.mockImplementation(async key => {
      if (h.maps.includes(key)) { started.add(key); await gate; }
      return h.read(key);
    });
    const pending = cleanup(['--prepare-backup', ...h.scope, '--limit', '1'], env);
    try { await vi.waitFor(() => expect(started.size).toBe(3)); }
    finally { release(); }
    await pending;
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects.map((o: any) => o.key)).toEqual([h.maps[0].replace(/\.json$/, '_analyze.json')]);
    expect(plan.nextCursor).toBeNull();
    expect(started.has(h.maps[3])).toBe(false);
  });

  it('삭제는 최대 세 경기만 겹치며 각 경기의 분석을 지운 뒤 지도를 지운다', async () => {
    const h = multipleMatches(4, true);
    await cleanup(['--prepare-backup', ...h.scope], env);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, maximum = 0;
    const finished: string[] = [];
    r2.deletePersonal.mockImplementation(async proof => {
      active++; maximum = Math.max(maximum, active);
      if (proof.kind === 'personal-analysis' && proof.matchId !== h.ids[3]) await gate;
      finished.push(proof.key); active--;
      return { deleted: true };
    });
    const pending = cleanup(['--apply', '--backup-upload-verified', ...h.scope], env);
    try {
      await vi.waitFor(() => expect(active).toBe(3));
      expect(r2.deletePersonal.mock.calls.every(([proof]) => proof.kind === 'personal-analysis')).toBe(true);
    } finally { release(); }
    await pending;
    expect(maximum).toBe(3);
    for (const key of h.maps) expect(finished.indexOf(key)).toBeGreaterThan(finished.indexOf(key.replace(/\.json$/, '_analyze.json')));
    expect(harness.tables.telemetry_map_cache_entries).toEqual([]);
    expect(harness.tables.pubg_player_matches).toHaveLength(4);
  });

  it('한 삭제가 실패하면 새 대상을 시작하지 않고 진행 중인 삭제와 복원을 기다린다', async () => {
    const h = multipleMatches(4, true);
    await cleanup(['--prepare-backup', ...h.scope], env);
    let releaseDeletes!: () => void, releaseRestore!: () => void;
    const deletes = new Promise<void>(resolve => { releaseDeletes = resolve; });
    const restore = new Promise<void>(resolve => { releaseRestore = resolve; });
    r2.deletePersonal.mockImplementation(async proof => {
      if (proof.matchId === h.ids[0]) throw new Error('simulated-delete-failed');
      await deletes;
      return { deleted: true };
    });
    r2.restore.mockImplementation(async () => { await restore; });
    let settled = false;
    const pending = cleanup(['--apply', '--backup-upload-verified', ...h.scope], env)
      .then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(r2.restore).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      releaseDeletes();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(r2.deletePersonal.mock.calls.every(([proof]) => proof.kind === 'personal-analysis' && proof.matchId !== h.ids[3])).toBe(true);
    } finally { releaseDeletes(); releaseRestore(); }
    expect((await pending).message).toBe('simulated-delete-failed');
    expect(harness.actions).not.toContain('cursor-cas-update');
    expect(harness.tables.telemetry_map_cache_entries).toHaveLength(4);
  });

  it('여러 삭제가 함께 실패하면 다른 경기의 복원 미검증을 대표 오류로 보존한다', async () => {
    const h = multipleMatches(3, true);
    await cleanup(['--prepare-backup', ...h.scope], env);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    r2.deletePersonal.mockImplementation(async proof => {
      await gate;
      if (proof.matchId !== h.ids[2]) throw new Error('ordinary-delete-failed');
      return { deleted: true };
    });
    r2.restore.mockImplementation(async object => {
      if (object.key === h.maps[1].replace(/\.json$/, '_analyze.json')) throw new Error('restore-failed');
    });
    const pending = cleanup(['--apply', '--backup-upload-verified', ...h.scope], env).catch(error => error);
    try { await vi.waitFor(() => expect(r2.deletePersonal).toHaveBeenCalledTimes(3)); }
    finally { release(); }
    expect((await pending).message).toBe('retention-delete-failed-restore-unverified');
    expect(r2.restore).toHaveBeenCalledTimes(2);
    expect(harness.actions).not.toContain('cursor-cas-update');
  });

  it('기준 시각 뒤의 경기와 apply에서 바뀐 기준 시각을 정리하지 않는다', async () => {
    await cleanup([...args('prepare'), '--cutoff', '2026-08-31T00:00:00.000Z'], env);
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).objects).toEqual([]);
    await expect(cleanup([...args('apply'), '--cutoff', '2026-09-01T00:00:00.000Z'], env))
      .rejects.toThrow('retention-manifest-scope-invalid');
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('전체 용량 측정은 쓰지 않으며 잘린 측정을 거부한다', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await cleanup(['--measure-usage'], env);
    expect(JSON.parse(info.mock.calls[0][0])).toEqual({ mode: 'r2-usage', bytes: 12345, objects: 50 });
    expect(harness.actions).toEqual([]);
    r2.usage.mockResolvedValue({ configured: true, truncated: true, totalSizeBytes: 1, fileCount: 1 });
    await expect(cleanup(['--measure-usage'], env)).rejects.toThrow('retention-r2-usage-incomplete');
  });

  it('예약 작업의 커서가 고정 기준 밖에 있으면 빈 범위의 정상 CAS로 감싸고 다음 순회를 허용한다', async () => {
    harness.tables.pubg_archive_cleanup_cursor[0].played_at = '2026-09-24T01:00:00.000Z';
    harness.tables.pubg_archive_cleanup_cursor[0].platform = platform;
    harness.tables.pubg_archive_cleanup_cursor[0].match_id = matchId;
    const scope = ['--platform', 'all', '--limit', '1', '--manifest', manifestPath,
      '--backup-artifact', backupPath, '--cutoff', '2026-09-22T00:00:00.000Z'];
    await cleanup(['--prepare-backup', ...scope], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan).toMatchObject({ matches: [], objects: [], startedFromBeginning: false, nextCursor: null });
    await cleanup(['--apply', '--backup-upload-verified', ...scope], env);
    expect(harness.tables.pubg_archive_cleanup_cursor[0]).toMatchObject({ played_at: null, generation: 5 });
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('삭제 대상만 R2에서 다시 읽으면서 모든 현재 DB 참조를 검사한다', async () => {
    const otherKey = buildTelemetryCacheKey({ matchId, platform, playerId: accountId, mode: 'full', telemetryVersion: 74 });
    harness.tables.telemetry_map_cache_entries.push({ ...registrySnapshot, id: 18, telemetry_version: 74, storage_path: otherKey });
    r2.read.mockImplementation(async (key: string) => [mapKey, otherKey].includes(key) ? {
      key, etag: '"archive-etag"', sizeBytes: harness.objectBody.length, contentType: 'application/json', contentEncoding: null,
      body: Buffer.from(harness.objectBody),
    } : null);
    await cleanup(args('prepare'), env);
    r2.read.mockClear();
    await cleanup(args('apply'), env);
    expect(r2.read.mock.calls.map(call => call[0])).toEqual([mapKey]);
    expect(r2.deletePersonal).toHaveBeenCalledTimes(1);
    expect(harness.tables.telemetry_map_cache_entries).toEqual([{ ...registrySnapshot, id: 18, telemetry_version: 74, storage_path: otherKey }]);
  });

  it('백업할 본문이 준비 중 바뀌면 백업·삭제를 중단한다', async () => {
    let reads = 0;
    r2.read.mockImplementation(async (key: string) => key === mapKey ? {
      key, etag: ++reads === 1 ? '"archive-etag"' : '"changed"', sizeBytes: harness.objectBody.length,
      contentType: 'application/json', contentEncoding: null, body: Buffer.from(harness.objectBody),
    } : null);
    await expect(cleanup(args('prepare'), env)).rejects.toThrow('retention-backup-object-changed');
    await expect(readFile(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('보존 준비와 삭제 직전 재검증에서 지도 등록부의 전체 필드를 동일하게 대조한다', async () => {
    harness.projectRegistryColumns = true;
    harness.tables.telemetry_map_cache_entries[0].created_at = '2026-09-02T00:00:00.000Z';
    await cleanup([...args('prepare'), '--preserve-performance'], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects[0].registrySnapshot.created_at).toBe('2026-09-02T00:00:00.000Z');
    await cleanup(args('apply'), env);
    expect(r2.deletePersonal).toHaveBeenCalledTimes(1);
  });

  function missingMapFixture() {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const identity = { matchId: id, platform: 'steam' as const, playerId: accountId, mode: 'full' as const, telemetryVersion: 73 };
    const publicIdentity = buildTelemetryPublicIdentity(identity);
    const key = buildTelemetryCacheKey(identity);
    const before = basic({ account_id: null, match_id: id, kills: 1, damage: 12, win_place: 12,
      match_type: 'unavailable', knocks: null, survival_time: null });
    const payload = { identity: publicIdentity, startTime: playedAt, teammates: [publicIdentity.playerKey], teamNames: [playerId],
      mapName: '에란겔', zoneEvents: [], events: [
        { type: 'damage', time: playedAt, attackerName: playerId, attackerAccountId: publicIdentity.playerKey,
          victimName: 'enemy', victimAccountId: 'a'.repeat(32), damage: 12.06 },
        { type: 'kill', time: playedAt, attacker: playerId, attackerAccountId: publicIdentity.playerKey,
          victim: 'enemy', victimAccountId: 'a'.repeat(32) },
      ] };
    harness.tables.pubg_player_matches = [before];
    harness.tables.processed_match_telemetry = [];
    harness.tables.pubg_match_performance = [];
    harness.tables.telemetry_map_cache_entries = [{ ...registrySnapshot, match_id: id, storage_path: key }];
    harness.objectBody = Buffer.from(JSON.stringify(payload));
    r2.read.mockImplementation(async (requested: string) => requested === key ? {
      key, etag: '"map-etag"', sizeBytes: harness.objectBody.length, body: Buffer.from(harness.objectBody),
      contentType: 'application/json', contentEncoding: null,
    } : null);
    return { before, key, id };
  }

  it('구형 지도의 기본 관측을 먼저 원자 보존·재조회하고 유형을 추정하지 않은 채 exact map을 정리한다', async () => {
    const fixture = missingMapFixture();
    await cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects.map((o: any) => o.key)).toEqual([fixture.key]);
    expect(plan.preservation).toEqual({ linkedAccounts: 1, savedSummaries: 1, recoveredSummaries: 1 });
    expect(harness.tables.pubg_player_matches[0]).toEqual({ ...fixture.before, account_id: accountId });
    await cleanup(['--apply', '--backup-upload-verified', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    expect(harness.actions.indexOf('r2-delete')).toBeGreaterThan(harness.actions.indexOf('legacy-map-recovery'));
    expect(harness.tables.pubg_player_matches[0].match_type).toBe('unavailable');
    expect(harness.tables.processed_match_telemetry).toEqual([]);
    expect(harness.tables.pubg_match_performance).toHaveLength(1);
  });

  it('구형 지도 준비 쓰기 실패와 dry-run은 R2 삭제를 수행하지 않는다', async () => {
    missingMapFixture();
    await cleanup(['--platform', 'all', '--manifest', manifestPath], env);
    expect(harness.actions).toEqual([]);
    expect(harness.tables.pubg_player_matches[0].account_id).toBeNull();
    harness.failBinding = true;
    await expect(cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath + '.prepare', '--backup-artifact', backupPath], env))
      .rejects.toThrow('retention-legacy-map-write-unverified');
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('여러 경기의 보존을 병렬 준비해도 전역 복구 예산 다섯 건을 초과하지 않는다', async () => {
    const fixture = missingMapFixture();
    const original = JSON.parse(harness.objectBody.toString('utf8'));
    const ids = Array.from({ length: 6 }, (_, i) => `123e4567-e89b-42d3-a456-${String(i).padStart(12, '0')}`);
    const keys = ids.map(id => buildTelemetryCacheKey({ matchId: id, platform, playerId: accountId, mode: 'full', telemetryVersion: 73 }));
    harness.tables.pubg_player_matches = ids.map(id => ({ ...fixture.before, match_id: id }));
    harness.tables.telemetry_map_cache_entries = ids.map((id, i) => ({ ...registrySnapshot, id: 17 + i, match_id: id, storage_path: keys[i] }));
    r2.read.mockImplementation(async key => {
      const index = keys.indexOf(key);
      if (index < 0) return null;
      const identity = buildTelemetryPublicIdentity({ matchId: ids[index], platform, playerId: accountId, mode: 'full', telemetryVersion: 73 });
      const body = Buffer.from(JSON.stringify({ ...original, identity }));
      return { key, etag: '"map-etag"', sizeBytes: body.length, body, contentType: 'application/json', contentEncoding: null };
    });
    await cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--limit', '50',
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.preservation).toEqual({ linkedAccounts: 5, savedSummaries: 5, recoveredSummaries: 5 });
    expect(plan.objects).toHaveLength(5);
    expect(harness.tables.pubg_player_matches.filter(row => row.account_id === null)).toHaveLength(1);
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  function missingTeamFixture() {
    const fixture = legacyTeamRecoveryInput();
    fixture.targetBasic = { ...fixture.targetBasic, kills: 0, damage: 0, win_place: 99,
      played_at: '2026-09-02T00:00:00.000Z', game_mode: 'unknown', map_name: 'unknown', match_type: 'unavailable' };
    harness.tables.pubg_player_matches = [fixture.targetBasic, fixture.sourceBasic];
    harness.tables.processed_match_telemetry = [{ match_id: fixture.sourceBasic.match_id, platform: 'steam',
      player_id: fixture.sourceBasic.player_id, data: { fullResult: fixture.sourceFullResult } }];
    harness.tables.pubg_match_performance = [buildRetainedPerformanceRow(fixture.sourceFullResult,
      { matchId: fixture.sourceBasic.match_id, platform: 'steam', playerId: fixture.sourceBasic.player_id })];
    harness.tables.telemetry_map_cache_entries = [];
    const key = fixture.eventSource.legacyKey;
    const body = Buffer.from(JSON.stringify(fixture.eventSource.events));
    r2.read.mockImplementation(async readKey => readKey === key ? {
      key, etag: '"team-etag"', sizeBytes: body.length, body, contentType: 'application/json', contentEncoding: null,
    } : null);
    r2.list.mockResolvedValue({ objects: [{ key, etag: '"team-etag"', sizeBytes: body.length }], pages: 1, truncated: false });
    return fixture;
  }

  it('recovers a verified teammate placeholder atomically before preparing its original backup', async () => {
    const fixture = missingTeamFixture();
    const sourceSnapshot = structuredClone(harness.tables.processed_match_telemetry);
    await cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--match-id', fixture.targetBasic.match_id,
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.preservation).toEqual({ linkedAccounts: 1, savedSummaries: 1, recoveredSummaries: 1 });
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0].playedAt).toBe(fixture.sourceBasic.played_at);
    expect(harness.tables.pubg_player_matches[0]).toMatchObject({ account_id: 'account.target', kills: 3,
      damage: 400, win_place: 2, game_mode: 'squad', map_name: 'Baltic_Main', played_at: fixture.sourceBasic.played_at });
    expect(harness.tables.processed_match_telemetry).toEqual(sourceSnapshot);
    expect(harness.actions).toEqual(['legacy-team-recovery']);
    expect(r2.deletePersonal).not.toHaveBeenCalled();
  });

  it('does not prepare deletion after a failed teammate recovery transaction', async () => {
    const fixture = missingTeamFixture(); harness.failBinding = true;
    await expect(cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--match-id', fixture.targetBasic.match_id,
      '--manifest', manifestPath, '--backup-artifact', backupPath], env)).rejects.toThrow('retention-legacy-team-write-unverified');
    expect(r2.deletePersonal).not.toHaveBeenCalled();
    expect(harness.tables.pubg_player_matches[0].account_id).toBeNull();
  });

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

  it('preserves an expired special-mode result after restoring its unavailable match type', async () => {
    const { original, key } = legacyFixture();
    harness.tables.pubg_player_matches[0].match_type = 'unavailable';
    harness.tables.processed_match_telemetry[0].data.fullResult.matchType = 'event';
    await cleanup(['--prepare-backup', '--preserve-performance', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(plan.objects.map((o: any) => o.key)).toEqual([key]);
    expect(harness.tables.pubg_player_matches[0]).toEqual({ ...original, account_id: accountId, match_type: 'event' });
    expect(harness.tables.pubg_match_performance[0]).toMatchObject({ summary: { matchType: 'event' }, ranking_eligible: false });
    await cleanup(['--apply', '--backup-upload-verified', '--platform', 'all', '--limit', '1',
      '--manifest', manifestPath, '--backup-artifact', backupPath], env);
    expect(harness.actions.indexOf('r2-delete')).toBeGreaterThan(harness.actions.indexOf('preserve-performance'));
    expect(harness.tables.pubg_player_matches).toHaveLength(1);
    expect(harness.tables.pubg_match_performance).toHaveLength(1);
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
    ["new map lease", () => { harness.tables.telemetry_map_cache_entries[0].lease_token = 'new-lease'; }],
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
