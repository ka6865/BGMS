import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { backupCoreTables, BACKUP_TABLES, type TableBackupResult } from "./backup_core_tables";
import { compressJsonText } from "../lib/pubg-analysis/r2Service";

const FIXTURE_PATH = resolve("tests/fixtures/backup/core-tables-roundtrip.json.gz");
const CUTOFF = "20260801000000";
const profileId = "1d29eea7-3a0b-4d47-bbc4-145f38f2ed93";
const passwordHash = "$2b$12$roundtripFixtureHashThatMustRemainPrivateAndExact";
// 로컬 fixture의 7개 테이블만 FK 순서대로 복원한다. 나머지 백업 대상은 비어 있어야 한다.
const LOCAL_RESTORE_ORDER: readonly string[] = [
  "profiles", "posts", "comments", "pubg_player_matches", "pubg_match_performance",
  "board_post_delete_credentials", "board_comment_delete_credentials",
];

type RoundtripPayload = {
  complete: boolean;
  tables: TableBackupResult[];
  data: Record<string, Record<string, unknown>[]>;
};

const fixtureRows: Record<string, Record<string, unknown>[]> = {
  profiles: [{ id: profileId, nickname: "backup-roundtrip", role: "user", pubg_platform: "steam" }],
  posts: [{ id: 918001, user_id: profileId, title: "roundtrip post", content: "kept", author: "fixture", password_hash: null }],
  comments: [{ id: 918002, post_id: 918001, user_id: profileId, author: "fixture", content: "kept", password_hash: null }],
  board_post_delete_credentials: [{ post_id: 918001, password_hash: passwordHash }],
  board_comment_delete_credentials: [{ comment_id: 918002, password_hash: passwordHash }],
  pubg_player_matches: [{
    player_id: "account.roundtrip", platform: "steam", match_id: "match-roundtrip",
    played_at: "2026-10-09T12:00:00.000Z", game_mode: "squad", map_name: "Baltic",
    kills: 4, damage: 523, win_place: 3, created_at: "2026-10-09T12:05:00.000Z",
  }],
  pubg_match_performance: [{
    platform: "steam", account_id: "account.roundtrip", match_id: "match-roundtrip",
    player_id: "account.roundtrip", calculation_version: 73, result_version: 2,
    score: 81.25, tier: "diamond", benchmark: { fixture: true }, ranking_eligible: true,
    calculated_at: "2026-10-09T12:06:00.000Z",
  }],
};

function makeFixtureReader() {
  return {
    from: (table: string) => {
      // 백업 스크립트의 키셋 조회(eq/gt/order/limit)를 흉내 낸다. fixture 는 테이블당 1행 이하라 정렬은 생략한다.
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let limit = Number.POSITIVE_INFINITY;
      const chain = {
        select: () => chain,
        order: () => chain,
        eq: (column: string, value: unknown) => { filters.push(row => row[column] === value); return chain; },
        gt: (column: string, value: unknown) => { filters.push(row => String(row[column]) > String(value)); return chain; },
        limit: (count: number) => { limit = count; return chain; },
        abortSignal: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: (fixtureRows[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(0, limit), error: null,
        }).then(resolve),
      };
      return chain;
    },
  } as never;
}

async function writeFixture(): Promise<void> {
  const uploaded: string[] = [];
  const result = await backupCoreTables(makeFixtureReader(), async (_key, body) => { uploaded.push(body); }, {
    now: new Date("2026-10-10T00:00:00.000Z"), write: () => undefined,
  });
  if (!result.complete || uploaded.length !== 1) throw new Error("roundtrip fixture serialization was incomplete");
  const compressed = compressJsonText(uploaded[0]);
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new Error("backup fixture is not gzip");
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, compressed);
}

function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}): string {
  return execFileSync(command, args, { cwd: options.cwd, input: options.input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function findPgBin(): string {
  const configured = process.env.BGMS_PG_BIN?.trim();
  if (configured) return configured;
  try {
    return join(run("brew", ["--prefix", "postgresql@17"]).trim(), "bin");
  } catch {
    throw new Error("PostgreSQL 17 로컬 실행 파일이 필요합니다 (BGMS_PG_BIN 또는 Homebrew)");
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function insertSql(table: string, rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const json = sqlString(JSON.stringify(rows));
  return `insert into public.${table} (${columns.map(column => `"${column}"`).join(",")})\n` +
    `select ${columns.map(column => `r."${column}"`).join(",")} from jsonb_populate_recordset(null::public.${table}, ${json}::jsonb) r;\n`;
}

export function localMigrationSql(sql: string): string {
  // 호스트 확장 설치만 제외한다. 애플리케이션 SQL은 원문 그대로 검증한다.
  return sql.replace(/^create extension if not exists (?:pg_cron with schema pg_catalog|pg_net with schema extensions);\r?\n/gm, "");
}

export function assertRoundtripPayload(payload: RoundtripPayload): void {
  if (payload.complete !== true) throw new Error("roundtrip fixture is marked incomplete");
  const expected = JSON.stringify([...BACKUP_TABLES].sort());
  if (JSON.stringify(Object.keys(payload.data).sort()) !== expected
    || !Array.isArray(payload.tables)
    || JSON.stringify(payload.tables.map(row => row.table).sort()) !== expected) {
    throw new Error("roundtrip fixture table list mismatch");
  }
  for (const metadata of payload.tables) {
    const rows = payload.data[metadata.table];
    if (!Array.isArray(rows) || metadata.rowCount !== rows.length) {
      throw new Error(`roundtrip fixture row count mismatch: ${metadata.table}`);
    }
    if (metadata.skipped !== false || metadata.error !== null) {
      throw new Error(`roundtrip fixture has incomplete table: ${metadata.table}`);
    }
    if (rows.length > 0 && !LOCAL_RESTORE_ORDER.includes(metadata.table)) {
      throw new Error(`roundtrip fixture has unrestored rows: ${metadata.table}`);
    }
  }
}

function verifyRoundtrip(): void {
  const pgBin = findPgBin();
  for (const executable of ["initdb", "pg_ctl", "psql"]) {
    if (!existsSync(join(pgBin, executable))) throw new Error(`PostgreSQL 17 executable missing: ${executable}`);
  }
  if (!existsSync(FIXTURE_PATH)) throw new Error(`gzip backup fixture missing: ${FIXTURE_PATH}`);
  const bytes = readFileSync(FIXTURE_PATH);
  const payload = JSON.parse(gunzipSync(bytes).toString("utf8")) as RoundtripPayload;
  assertRoundtripPayload(payload);

  const dataDir = mkdtempSync(join(tmpdir(), "bgms-backup-roundtrip-data."));
  const socketDir = mkdtempSync(join(tmpdir(), "bgms-backup-roundtrip-socket."));
  const port = String(56000 + (process.pid % 7000));
  let started = false;
  try {
    run(join(pgBin, "initdb"), ["-D", dataDir, "-A", "trust", "-U", "postgres", "--no-locale"]);
    run(join(pgBin, "pg_ctl"), ["-D", dataDir, "-o", `-p ${port} -k ${socketDir}`, "-l", join(dataDir, "postgres.log"), "start"]);
    started = true;
    const psql = (database: string, sql: string) => run(join(pgBin, "psql"), ["-h", socketDir, "-p", port, "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-q"], { input: sql });
    psql("postgres", "create database backup_roundtrip;");
    psql("backup_roundtrip", `
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator nologin; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
`);
    psql("backup_roundtrip", readFileSync(resolve("tests/fixtures/migration-check/baseline-schema.sql"), "utf8"));
    psql("backup_roundtrip", readFileSync(resolve("tests/fixtures/migration-check/pubg-cron-extension-stubs.sql"), "utf8")
      .replace("create schema vault;", "create schema if not exists vault;"));

    const migrations = readdirSync(resolve("supabase/migrations"))
      .filter(file => file.endsWith(".sql") && file.slice(0, 14) >= CUTOFF)
      .sort();
    for (const migration of migrations) {
      psql("backup_roundtrip", localMigrationSql(readFileSync(resolve("supabase/migrations", migration), "utf8")));
    }

    // Auth는 public 백업 범위 밖의 플랫폼 데이터다. FK가 참조할 fixture 계정만 준비한다.
    const authIds = payload.data.profiles.map(row => ({ id: row.id }));
    psql("backup_roundtrip", `insert into auth.users (id)
select r.id from jsonb_populate_recordset(null::auth.users, ${sqlString(JSON.stringify(authIds))}::jsonb) r;`);

    const restore = LOCAL_RESTORE_ORDER.map(table => insertSql(table, payload.data[table])).join("\n");
    psql("backup_roundtrip", restore + `
do $$ begin
  if not exists (select 1 from public.posts where id=918001 and password_hash is null) then raise exception 'post row/password redaction mismatch'; end if;
  if not exists (select 1 from public.comments where id=918002 and password_hash is null) then raise exception 'comment row/password redaction mismatch'; end if;
  if not exists (
    select 1 from public.comments c join public.posts p on p.id=c.post_id
    join public.profiles u on u.id=p.user_id join auth.users a on a.id=u.id
    where c.id=918002 and p.id=918001 and u.id='${profileId}' and c.user_id=u.id
  ) then raise exception 'restored row relationships mismatch'; end if;
  if (select password_hash from public.board_post_delete_credentials where post_id=918001) is distinct from '${passwordHash}' then raise exception 'post deletion secret mismatch'; end if;
  if (select password_hash from public.board_comment_delete_credentials where comment_id=918002) is distinct from '${passwordHash}' then raise exception 'comment deletion secret mismatch'; end if;
  if not exists (select 1 from public.pubg_match_performance where calculation_version=73 and result_version=2 and match_id='match-roundtrip') then raise exception 'analysis versions mismatch'; end if;
end $$;
`);
    const restoredTables = LOCAL_RESTORE_ORDER.filter(table => payload.data[table].length > 0).length;
    console.info(`backup roundtrip passed: ${BACKUP_TABLES.length} tables validated, ${restoredTables} fixture tables restored, ${BACKUP_TABLES.length - restoredTables} empty tables, ${migrations.length} migrations`);
  } finally {
    if (started) {
      try { run(join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"]); } catch { /* cleanup below owns this temporary cluster */ }
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
}

const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  void (async () => {
    if (process.argv.includes("--write-fixture")) {
      await writeFixture();
      console.info(`wrote ${FIXTURE_PATH}`);
    } else verifyRoundtrip();
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
