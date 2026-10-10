import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { backupCoreTables, BACKUP_TABLES } from "./backup_core_tables";
import { compressJsonText } from "../lib/pubg-analysis/r2Service";

const FIXTURE_PATH = resolve("tests/fixtures/backup/core-tables-roundtrip.json.gz");
const CUTOFF = "20260801000000";
const profileId = "1d29eea7-3a0b-4d47-bbc4-145f38f2ed93";
const passwordHash = "$2b$12$roundtripFixtureHashThatMustRemainPrivateAndExact";

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
      let from = 0;
      let to = -1;
      const chain = {
        select: () => chain,
        order: () => chain,
        range: (start: number, end: number) => { from = start; to = end; return chain; },
        abortSignal: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: (fixtureRows[table] ?? []).slice(from, to + 1), error: null,
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

function verifyRoundtrip(): void {
  const pgBin = findPgBin();
  for (const executable of ["initdb", "pg_ctl", "psql"]) {
    if (!existsSync(join(pgBin, executable))) throw new Error(`PostgreSQL 17 executable missing: ${executable}`);
  }
  if (!existsSync(FIXTURE_PATH)) throw new Error(`gzip backup fixture missing: ${FIXTURE_PATH}`);
  const bytes = readFileSync(FIXTURE_PATH);
  const payload = JSON.parse(gunzipSync(bytes).toString("utf8")) as { complete: boolean; data: Record<string, Record<string, unknown>[]> };
  if (!payload.complete) throw new Error("roundtrip fixture is marked incomplete");

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
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.role() returns text language sql stable as $$ select 'anon'::text $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
`);
    psql("backup_roundtrip", readFileSync(resolve("tests/fixtures/migration-check/baseline-schema.sql"), "utf8"));

    const migrations = readdirSync(resolve("supabase/migrations"))
      .filter(file => file.endsWith(".sql") && file.slice(0, 14) >= CUTOFF)
      .sort();
    for (const migration of migrations) {
      psql("backup_roundtrip", readFileSync(resolve("supabase/migrations", migration), "utf8"));
    }

    const restoreOrder = ["profiles", "posts", "comments", "pubg_player_matches", "pubg_match_performance", "board_post_delete_credentials", "board_comment_delete_credentials"];
    const restore = restoreOrder.map(table => insertSql(table, payload.data[table] ?? [])).join("\n");
    psql("backup_roundtrip", restore + `
do $$ begin
  if not exists (select 1 from public.posts where id=918001 and password_hash is null) then raise exception 'post row/password redaction mismatch'; end if;
  if not exists (select 1 from public.comments where id=918002 and password_hash is null) then raise exception 'comment row/password redaction mismatch'; end if;
  if (select password_hash from public.board_post_delete_credentials where post_id=918001) is distinct from '${passwordHash}' then raise exception 'post deletion secret mismatch'; end if;
  if (select password_hash from public.board_comment_delete_credentials where comment_id=918002) is distinct from '${passwordHash}' then raise exception 'comment deletion secret mismatch'; end if;
  if not exists (select 1 from public.pubg_match_performance where calculation_version=73 and result_version=2 and match_id='match-roundtrip') then raise exception 'analysis versions mismatch'; end if;
end $$;
`);
    console.info(`backup roundtrip passed: ${BACKUP_TABLES.length} tables in scope, ${migrations.length} migrations`);
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
