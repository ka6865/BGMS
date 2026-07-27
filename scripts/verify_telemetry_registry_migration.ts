import { spawn } from "node:child_process";

const psql = process.env.PSQL_BIN?.trim() || "psql";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}-missing`);
  return value;
}

const connectionArgs = [
  "-X",
  "-q",
  "-h", requireEnv("PGHOST"),
  "-p", requireEnv("PGPORT"),
  "-U", requireEnv("PGUSER"),
  "-d", requireEnv("PGDATABASE"),
  "-v", "ON_ERROR_STOP=1",
  "-At",
];

function executeSql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, [...connectionArgs, "-c", sql], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `psql-exit-${code}`));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expectCounts(output: string, expected: string, label: string): void {
  const actual = output.split(/\s+/).filter(Boolean).join("|");
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected}, actual=${actual}`);
  }
}

async function waitForSqlValue(
  sql: string,
  expected: string,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await executeSql(sql) === expected) return;
    await delay(100);
  }
  throw new Error(`${label}: expected=${expected}`);
}

async function verifyServiceRoleSequence(): Promise<void> {
  await executeSql(`
    delete from public.telemetry_map_cache_entries where match_id = 'verify-sequence';
    set role service_role;
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version, storage_path, status
    ) values (
      'verify-sequence', 'steam', 'player', 'lite', 60,
      'telemetry-map/verify-sequence.json', 'ready'
    ) on conflict (match_id, platform, player_id, mode, telemetry_version)
      do update set status = excluded.status;
  `);
  const count = await executeSql(
    "select count(*) from public.telemetry_map_cache_entries where match_id = 'verify-sequence'",
  );
  expectCounts(count, "1", "service-role-sequence");
}

async function verifyRegistryOnlyCleanup(): Promise<void> {
  await executeSql(`
    delete from public.telemetry_map_cache_entries where match_id = 'verify-registry-only';
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, updated_at
    ) values (
      'verify-registry-only', 'steam', 'player', 'lite', 58,
      'telemetry-map/verify-registry-only.json', 'ready', now() - interval '30 days'
    );
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-registry-only'], now() - interval '1 day', 59, now()
    );
  `);
  const count = await executeSql(
    "select count(*) from public.telemetry_map_cache_entries where match_id = 'verify-registry-only'",
  );
  expectCounts(count, "0", "registry-only-row-reduction");
}

async function verifyMasterOnlyCleanup(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw where match_id = 'verify-master-only';
    delete from public.processed_match_telemetry where match_id = 'verify-master-only';
    delete from public.telemetry_map_cache_entries where match_id = 'verify-master-only';
    delete from public.match_master_telemetry where match_id = 'verify-master-only';
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values (
      'verify-master-only', 'Baltic_Main', 'squad', 58,
      'old/verify-master-only.json', now() - interval '30 days'
    );
    insert into public.match_stats_raw (match_id) values ('verify-master-only');
    insert into public.processed_match_telemetry (match_id, platform, player_id, data)
      values ('verify-master-only', 'steam', 'player', '{}');
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-master-only'], now() - interval '1 day', 59, now()
    );
  `);

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry
        where match_id = 'verify-master-only'),
      (select count(*) from public.match_stats_raw
        where match_id = 'verify-master-only'),
      (select count(*) from public.processed_match_telemetry
        where match_id = 'verify-master-only');
  `);
  expectCounts(counts, "0|0|0", "master-only-atomic-cleanup");
}

async function verifyExpiredPendingCleanup(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw where match_id = 'verify-expired-pending';
    delete from public.processed_match_telemetry where match_id = 'verify-expired-pending';
    delete from public.telemetry_map_cache_entries where match_id = 'verify-expired-pending';
    delete from public.match_master_telemetry where match_id = 'verify-expired-pending';
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values (
      'verify-expired-pending', 'Baltic_Main', 'squad', 58,
      'old/verify-expired-pending.json', now() - interval '30 days'
    );
    insert into public.match_stats_raw (match_id) values ('verify-expired-pending');
    insert into public.processed_match_telemetry (match_id, platform, player_id, data)
      values ('verify-expired-pending', 'steam', 'player', '{}');
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, lease_expires_at, updated_at
    ) values (
      'verify-expired-pending', 'steam', 'player', 'lite', 58,
      'telemetry-map/verify-expired-pending.json', 'pending',
      now() - interval '1 minute', now()
    );
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-expired-pending'], now() - interval '1 day', 59, now()
    );
  `);

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry
        where match_id = 'verify-expired-pending'),
      (select count(*) from public.match_stats_raw
        where match_id = 'verify-expired-pending'),
      (select count(*) from public.processed_match_telemetry
        where match_id = 'verify-expired-pending'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-expired-pending');
  `);
  expectCounts(counts, "0|0|0|0", "expired-pending-atomic-cleanup");
}

async function verifyLeaseSnapshotBoundary(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw where match_id = 'verify-lease-boundary';
    delete from public.processed_match_telemetry where match_id = 'verify-lease-boundary';
    delete from public.telemetry_map_cache_entries where match_id = 'verify-lease-boundary';
    delete from public.match_master_telemetry where match_id = 'verify-lease-boundary';
  `);

  await executeSql(`
    begin;
    set statement_timeout = '4s';
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values (
      'verify-lease-boundary', 'Baltic_Main', 'squad', 58,
      'old/verify-lease-boundary.json', now() - interval '30 days'
    );
    insert into public.match_stats_raw (match_id) values ('verify-lease-boundary');
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, lease_expires_at, updated_at
    ) values (
      'verify-lease-boundary', 'steam', 'player', 'lite', 58,
      'telemetry-map/verify-lease-boundary.json', 'pending',
      clock_timestamp() + interval '500 milliseconds', now()
    );
    select pg_sleep(1);
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-lease-boundary'], now() - interval '1 day', 59, now()
    );
    commit;
  `);

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry
        where match_id = 'verify-lease-boundary'),
      (select count(*) from public.match_stats_raw
        where match_id = 'verify-lease-boundary'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-lease-boundary');
  `);
  expectCounts(counts, "1|1|1", "lease-snapshot-boundary-protection");
}

async function verifyWriterFirst(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw where match_id = 'verify-writer-first';
    delete from public.processed_match_telemetry where match_id = 'verify-writer-first';
    delete from public.telemetry_map_cache_entries where match_id = 'verify-writer-first';
    delete from public.match_master_telemetry where match_id = 'verify-writer-first';
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values (
      'verify-writer-first', 'Baltic_Main', 'squad', 58,
      'old/verify-writer-first.json', now() - interval '30 days'
    );
    insert into public.match_stats_raw (match_id) values ('verify-writer-first');
  `);

  const writer = executeSql(`
    begin;
    set role service_role;
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, lease_expires_at, updated_at
    ) values (
      'verify-writer-first', 'steam', 'player', 'lite', 60,
      'telemetry-map/verify-writer-first.json', 'pending',
      now() + interval '15 minutes', now()
    );
    select pg_sleep(1.5);
    commit;
  `);
  await delay(250);
  const cleanup = executeSql(`
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-writer-first'], now() - interval '1 day', 59, now()
    );
  `);
  await Promise.all([writer, cleanup]);

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry where match_id = 'verify-writer-first'),
      (select count(*) from public.match_stats_raw where match_id = 'verify-writer-first'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-writer-first' and status = 'pending');
  `);
  expectCounts(counts, "1|1|1", "writer-first-active-lease");
}

async function verifyCleanupFirst(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw where match_id = 'verify-cleanup-first';
    delete from public.processed_match_telemetry where match_id = 'verify-cleanup-first';
    delete from public.telemetry_map_cache_entries where match_id = 'verify-cleanup-first';
    delete from public.match_master_telemetry where match_id = 'verify-cleanup-first';
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values (
      'verify-cleanup-first', 'Baltic_Main', 'squad', 58,
      'old/verify-cleanup-first.json', now() - interval '30 days'
    );
    insert into public.match_stats_raw (match_id) values ('verify-cleanup-first');
    insert into public.processed_match_telemetry (match_id, platform, player_id, data)
      values ('verify-cleanup-first', 'steam', 'old-player', '{}');
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, updated_at
    ) values (
      'verify-cleanup-first', 'steam', 'old-player', 'lite', 58,
      'telemetry-map/verify-cleanup-first-old.json', 'ready', now() - interval '30 days'
    );
  `);

  const cleanup = executeSql(`
    begin;
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-cleanup-first'], now() - interval '1 day', 59, now()
    );
    select pg_sleep(1.5);
    commit;
  `);
  await delay(250);
  const writer = executeSql(`
    begin;
    set role service_role;
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, lease_expires_at, updated_at
    ) values (
      'verify-cleanup-first', 'steam', 'new-player', 'lite', 60,
      'telemetry-map/verify-cleanup-first-new.json', 'pending',
      now() + interval '15 minutes', now()
    );
    select public.finalize_telemetry_cache_write(
      'verify-cleanup-first',
      'Baltic_Main',
      'squad',
      60,
      'telemetry-map/verify-cleanup-first-new.json',
      'steam',
      'new-player',
      'lite',
      60,
      now(),
      'new-player',
      'steam',
      '{}',
      now()
    );
    commit;
  `);
  await Promise.all([cleanup, writer]);

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry
        where match_id = 'verify-cleanup-first' and telemetry_version = 60),
      (select count(*) from public.processed_match_telemetry
        where match_id = 'verify-cleanup-first' and player_id = 'new-player'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-cleanup-first' and status = 'ready'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-cleanup-first' and status = 'pending');
  `);
  expectCounts(counts, "1|1|1|0", "cleanup-first-full-lifecycle");
}

async function verifyCleanupSkipsLockedMatch(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw
      where match_id in ('verify-cleanup-skip-locked', 'verify-cleanup-skip-available');
    delete from public.processed_match_telemetry
      where match_id in ('verify-cleanup-skip-locked', 'verify-cleanup-skip-available');
    delete from public.telemetry_map_cache_entries
      where match_id in ('verify-cleanup-skip-locked', 'verify-cleanup-skip-available');
    delete from public.match_master_telemetry
      where match_id in ('verify-cleanup-skip-locked', 'verify-cleanup-skip-available');
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values
      (
        'verify-cleanup-skip-locked', 'Baltic_Main', 'squad', 58,
        'old/verify-cleanup-skip-locked.json', now() - interval '30 days'
      ),
      (
        'verify-cleanup-skip-available', 'Baltic_Main', 'squad', 58,
        'old/verify-cleanup-skip-available.json', now() - interval '30 days'
      );
    insert into public.match_stats_raw (match_id) values
      ('verify-cleanup-skip-locked'),
      ('verify-cleanup-skip-available');
    insert into public.processed_match_telemetry (match_id, platform, player_id, data) values
      ('verify-cleanup-skip-locked', 'steam', 'player', '{}'),
      ('verify-cleanup-skip-available', 'steam', 'player', '{}');
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, updated_at
    ) values
      (
        'verify-cleanup-skip-locked', 'steam', 'locked-player', 'lite', 58,
        'telemetry-map/verify-cleanup-skip-locked-player.json', 'ready',
        now() - interval '30 days'
      ),
      (
        'verify-cleanup-skip-locked', 'steam', 'available-player', 'lite', 58,
        'telemetry-map/verify-cleanup-skip-available-player.json', 'ready',
        now() - interval '30 days'
      ),
      (
        'verify-cleanup-skip-available', 'steam', 'player', 'lite', 58,
        'telemetry-map/verify-cleanup-skip-available.json', 'ready',
        now() - interval '30 days'
      );
  `);

  const blocker = executeSql(`
    begin;
    set application_name = 'verify-cleanup-row-blocker';
    select id
    from public.telemetry_map_cache_entries
    where match_id = 'verify-cleanup-skip-locked'
      and player_id = 'locked-player'
    for update;
    select pg_sleep(3);
    commit;
  `);
  await waitForSqlValue(`
    select count(*)
    from pg_stat_activity
    where application_name = 'verify-cleanup-row-blocker'
      and wait_event = 'PgSleep';
  `, "1", "cleanup-row-blocker-lock");

  let firstCleanup = "";
  try {
    firstCleanup = await executeSql(`
      set statement_timeout = '1s';
      set role service_role;
      select public.cleanup_expired_telemetry_matches(
        array['verify-cleanup-skip-locked', 'verify-cleanup-skip-available'],
        now() - interval '1 day',
        59,
        now()
      );
    `);

    const counts = await executeSql(`
      select
        (select count(*) from public.match_master_telemetry
          where match_id = 'verify-cleanup-skip-locked'),
        (select count(*) from public.match_stats_raw
          where match_id = 'verify-cleanup-skip-locked'),
        (select count(*) from public.processed_match_telemetry
          where match_id = 'verify-cleanup-skip-locked'),
        (select count(*) from public.telemetry_map_cache_entries
          where match_id = 'verify-cleanup-skip-locked'),
        (select count(*) from public.match_master_telemetry
          where match_id = 'verify-cleanup-skip-available'),
        (select count(*) from public.match_stats_raw
          where match_id = 'verify-cleanup-skip-available'),
        (select count(*) from public.processed_match_telemetry
          where match_id = 'verify-cleanup-skip-available'),
        (select count(*) from public.telemetry_map_cache_entries
          where match_id = 'verify-cleanup-skip-available');
    `);
    expectCounts(counts, "1|1|1|2|0|0|0|0", "cleanup-skip-locked-isolation");
  } finally {
    await blocker;
  }
  expectCounts(firstCleanup, "verify-cleanup-skip-available", "cleanup-skip-locked-result");

  const deferredCleanup = await executeSql(`
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-cleanup-skip-locked'],
      now() - interval '1 day',
      59,
      now()
    );
  `);
  expectCounts(deferredCleanup, "verify-cleanup-skip-locked", "cleanup-deferred-next-run");

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry
        where match_id = 'verify-cleanup-skip-locked'),
      (select count(*) from public.match_stats_raw
        where match_id = 'verify-cleanup-skip-locked'),
      (select count(*) from public.processed_match_telemetry
        where match_id = 'verify-cleanup-skip-locked'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-cleanup-skip-locked');
  `);
  expectCounts(counts, "0|0|0|0", "cleanup-deferred-row-reduction");
}

async function verifyFinalizeFirst(): Promise<void> {
  await executeSql(`
    delete from public.match_stats_raw where match_id = 'verify-finalize-first';
    delete from public.processed_match_telemetry where match_id = 'verify-finalize-first';
    delete from public.telemetry_map_cache_entries where match_id = 'verify-finalize-first';
    delete from public.match_master_telemetry where match_id = 'verify-finalize-first';
    insert into public.match_master_telemetry (
      match_id, map_name, game_mode, telemetry_version, storage_path, created_at
    ) values (
      'verify-finalize-first', 'Baltic_Main', 'squad', 58,
      'old/verify-finalize-first.json', now() - interval '30 days'
    );
    insert into public.match_stats_raw (match_id) values ('verify-finalize-first');
    insert into public.telemetry_map_cache_entries (
      match_id, platform, player_id, mode, telemetry_version,
      storage_path, status, updated_at
    ) values (
      'verify-finalize-first', 'steam', 'old-player', 'lite', 58,
      'telemetry-map/verify-finalize-first-old.json', 'ready', now() - interval '30 days'
    );
  `);

  const writer = executeSql(`
    begin;
    set statement_timeout = '4s';
    set role service_role;
    select public.finalize_telemetry_cache_write(
      'verify-finalize-first',
      'Baltic_Main',
      'squad',
      60,
      'telemetry-map/verify-finalize-first-new.json',
      'steam',
      'new-player',
      'lite',
      60,
      now(),
      'new-player',
      'steam',
      '{}',
      now()
    );
    select pg_sleep(1.5);
    commit;
  `);
  await delay(250);
  const cleanup = executeSql(`
    set statement_timeout = '4s';
    set role service_role;
    select public.cleanup_expired_telemetry_matches(
      array['verify-finalize-first'], now() - interval '1 day', 59, now()
    );
  `);
  await Promise.all([writer, cleanup]);

  const counts = await executeSql(`
    select
      (select count(*) from public.match_master_telemetry
        where match_id = 'verify-finalize-first' and telemetry_version = 60),
      (select count(*) from public.processed_match_telemetry
        where match_id = 'verify-finalize-first' and player_id = 'new-player'),
      (select count(*) from public.telemetry_map_cache_entries
        where match_id = 'verify-finalize-first' and player_id = 'new-player'
          and status = 'ready'),
      (select count(*) from public.match_stats_raw
        where match_id = 'verify-finalize-first');
  `);
  expectCounts(counts, "1|1|1|1", "finalize-first-no-deadlock");
}

async function main(): Promise<void> {
  await verifyServiceRoleSequence();
  await verifyRegistryOnlyCleanup();
  await verifyMasterOnlyCleanup();
  await verifyExpiredPendingCleanup();
  await verifyLeaseSnapshotBoundary();
  await verifyWriterFirst();
  await verifyCleanupFirst();
  await verifyCleanupSkipsLockedMatch();
  await verifyFinalizeFirst();
  process.stdout.write("telemetry-registry-migration: ok\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
