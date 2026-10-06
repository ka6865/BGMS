import { readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packetPath = process.env.BGMS_RETENTION_PACKET_FILE;
const host = process.env.BGMS_RETENTION_PGHOST;
const port = process.env.BGMS_RETENTION_PGPORT;
const psql = process.env.BGMS_PSQL_BIN ?? 'psql';
if (!packetPath || !host || !port) {
  throw new Error('Set BGMS_RETENTION_PACKET_FILE and isolated local PostgreSQL host/port');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !host.startsWith('/')) {
  throw new Error('Refusing a non-local PostgreSQL host');
}
if ((statSync(packetPath).mode & 0o077) !== 0) {
  throw new Error('Packet file permissions must restrict access to its owner');
}

const decoded = JSON.parse(readFileSync(packetPath, 'utf8')) as { packets?: unknown } | unknown[];
const packets = Array.isArray(decoded) ? decoded : decoded.packets;
if (!Array.isArray(packets) || packets.length < 1 || packets.length > 30) {
  throw new Error('Expected 1–30 production-shape recovery packets');
}
const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const values = packets.map((packet: any) => {
  const { before, sourceBasic, processedSource, expectedBasic, fullResult, performance } = packet ?? {};
  if (![before, sourceBasic, processedSource, expectedBasic, fullResult, performance]
    .every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Packet schema is incomplete');
  }
  const p = { before, sourceBasic, processedSource, expectedBasic, fullResult, performance };
  return `(${['before', 'sourceBasic', 'processedSource', 'expectedBasic', 'fullResult', 'performance']
    .map((key) => `convert_from(decode('${encodeJson(p[key as keyof typeof p])}','base64'),'UTF8')::jsonb`).join(',')})`;
});

const sql = `
begin;
set local timezone='UTC';
create temporary table retention_actual_packets (
  before_row jsonb not null, source_basic jsonb not null, processed_source jsonb not null,
  expected_basic jsonb not null, full_result jsonb not null, performance jsonb not null
) on commit drop;
insert into retention_actual_packets values ${values.join(',')};
insert into public.pubg_player_matches
select (pg_catalog.jsonb_populate_record(null::public.pubg_player_matches, p.before_row)).*
from retention_actual_packets p on conflict do nothing;
insert into public.pubg_player_matches
select (pg_catalog.jsonb_populate_record(null::public.pubg_player_matches, p.source_basic)).*
from retention_actual_packets p on conflict do nothing;
insert into public.processed_match_telemetry
select (pg_catalog.jsonb_populate_record(null::public.processed_match_telemetry, p.processed_source)).*
from retention_actual_packets p on conflict do nothing;
grant select on retention_actual_packets to service_role;
set local role service_role;
do $verify$
declare p record; answer jsonb; basic_row jsonb; performance_row jsonb; count_saved integer := 0;
begin
  for p in select * from retention_actual_packets loop
    answer := public.recover_retention_legacy_team(jsonb_build_object(
      'before',p.before_row,'sourceBasic',p.source_basic,'processedSource',p.processed_source,
      'expectedBasic',p.expected_basic,'fullResult',p.full_result,'performance',p.performance));
    if answer->>'saved' is distinct from 'true'
       or ((answer->'basic') - 'played_at') is distinct from (p.expected_basic - 'played_at')
       or (answer->'basic'->>'played_at')::timestamptz is distinct from (p.expected_basic->>'played_at')::timestamptz then
      raise exception 'actual packet returned unexpected basic row';
    end if;
    select pg_catalog.to_jsonb(m) into basic_row from public.pubg_player_matches m
    where m.platform=p.performance->>'platform' and m.match_id=p.performance->>'match_id'
      and m.player_id=p.performance->>'player_id';
    select pg_catalog.to_jsonb(f) into performance_row from public.pubg_match_performance f
    where f.platform=p.performance->>'platform' and f.match_id=p.performance->>'match_id'
      and f.account_id=p.performance->>'account_id'
      and f.calculation_version=(p.performance->>'calculation_version')::integer
      and f.result_version=(p.performance->>'result_version')::integer;
    if basic_row is null or (basic_row - 'played_at') is distinct from (p.expected_basic - 'played_at')
       or (basic_row->>'played_at')::timestamptz is distinct from (p.expected_basic->>'played_at')::timestamptz
       or performance_row is null
       or (performance_row - array['calculated_at','played_at']::text[]) is distinct from (p.performance - 'played_at')
       or (performance_row->>'played_at')::timestamptz is distinct from (p.performance->>'played_at')::timestamptz
       or exists(select 1 from public.processed_match_telemetry t where t.match_id=p.performance->>'match_id'
         and t.platform=p.performance->>'platform' and t.player_id=p.performance->>'player_id') then
      raise exception 'actual packet readback mismatch';
    end if;
    count_saved := count_saved + 1;
  end loop;
  if count_saved <> ${packets.length} then raise exception 'actual packet count mismatch'; end if;
end;
$verify$;
reset role;
rollback;
select 'actual production-shape packet local RPC verification passed' as result;
`;

const result = spawnSync(psql, [
  '--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', '--host', host, '--port', port,
  '--username', 'postgres', '--dbname', 'migcheck',
], { input: sql, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0) {
  const errorDir = mkdtempSync(join(tmpdir(), 'bgms-retention-check-'));
  writeFileSync(join(errorDir, 'error.log'), result.stderr + result.stdout, { mode: 0o600, flag: 'wx' });
  process.stderr.write(`Actual production-shape recovery packet verification failed; private details: ${errorDir}\n`);
  process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout);
