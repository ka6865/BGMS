-- Preserve verified legacy map-event performance without rewriting observed
-- basic-match fields. The caller supplies complete CAS snapshots and a compact
-- summary; detailed event validation remains in the application recovery helper.
create or replace function public.recover_retention_legacy_map(p_packet jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before jsonb;
  v_registry jsonb;
  v_expected jsonb;
  v_performance jsonb;
  v_summary jsonb;
  v_stats jsonb;
  v_metrics jsonb;
  v_evidence jsonb;
  v_basic_after jsonb;
  v_match_id text;
  v_platform text;
  v_player_id text;
  v_account_id text;
  v_storage_path text;
  v_played_at timestamptz;
  v_registry_updated_at timestamptz;
  v_lock_deadline timestamptz;
  v_column_names text[];
  v_number text;
begin
  if p_packet is null
     or pg_catalog.jsonb_typeof(p_packet) is distinct from 'object'
     or pg_catalog.octet_length(p_packet::text) > 131072
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_packet)) <> 4
     or pg_catalog.jsonb_typeof(p_packet->'before') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'registry') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'expectedBasic') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'performance') is distinct from 'object' then
    raise exception 'invalid packet';
  end if;

  v_before := p_packet->'before';
  v_registry := p_packet->'registry';
  v_expected := p_packet->'expectedBasic';
  v_performance := p_packet->'performance';
  v_summary := v_performance->'summary';
  v_stats := v_summary->'stats';
  v_metrics := v_summary->'replayObservedMetrics';
  v_evidence := v_summary->'retentionRecoveryEvidence';

  select pg_catalog.array_agg(a.attname::text order by a.attnum)
    into v_column_names
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.pubg_player_matches'::pg_catalog.regclass
    and a.attnum > 0 and not a.attisdropped;
  if v_column_names is null
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_before)) <> pg_catalog.cardinality(v_column_names)
     or not (v_before ?& v_column_names)
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_before) as keys(key) where not (keys.key = any(v_column_names))) then
    raise exception 'incomplete basic snapshot';
  end if;

  select pg_catalog.array_agg(a.attname::text order by a.attnum)
    into v_column_names
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.telemetry_map_cache_entries'::pg_catalog.regclass
    and a.attnum > 0 and not a.attisdropped;
  if v_column_names is null
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_registry)) <> pg_catalog.cardinality(v_column_names)
     or not (v_registry ?& v_column_names)
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_registry) as keys(key) where not (keys.key = any(v_column_names))) then
    raise exception 'incomplete registry snapshot';
  end if;

  v_match_id := v_before->>'match_id';
  v_platform := v_before->>'platform';
  v_player_id := v_before->>'player_id';
  v_account_id := v_registry->>'player_id';
  v_storage_path := v_registry->>'storage_path';

  if v_before->'account_id' is distinct from 'null'::jsonb
     or v_platform not in ('steam','kakao')
     or coalesce(v_match_id,'') !~* '^[0-9a-f-]{36}$'
     or coalesce(v_player_id,'') !~ '^[a-z0-9._-]{1,64}$'
     or coalesce(v_account_id,'') !~ '^account\.[A-Za-z0-9_-]+$'
     or pg_catalog.jsonb_typeof(v_before->'match_id') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_before->'platform') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_before->'player_id') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_before->'map_name') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_before->'game_mode') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_before->'match_type') is distinct from 'string'
     or v_expected->>'account_id' is distinct from v_account_id
     or (v_expected - array['account_id']::text[]) is distinct from (v_before - array['account_id']::text[])
     or v_registry->>'match_id' is distinct from v_match_id
     or v_registry->>'platform' is distinct from v_platform
     or v_registry->>'player_id' is distinct from v_account_id
     or v_registry->>'mode' is distinct from 'full'
     or v_registry->>'status' is distinct from 'ready'
     or pg_catalog.jsonb_typeof(v_registry->'player_id') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_registry->'mode') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_registry->'status') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_registry->'telemetry_version') is distinct from 'number'
     or v_registry->'lease_token' is distinct from 'null'::jsonb
     or (v_registry->'lease_expires_at' is distinct from 'null'::jsonb
       and pg_catalog.jsonb_typeof(v_registry->'lease_expires_at') is distinct from 'string')
     or coalesce(v_registry->>'lease_expires_at','') <> '' and
       (not pg_catalog.pg_input_is_valid(v_registry->>'lease_expires_at','timestamp with time zone')
        or (v_registry->>'lease_expires_at')::timestamptz > pg_catalog.now())
     or coalesce(v_registry->>'telemetry_version','') !~ '^[1-9][0-9]*([.]0+)?$'
     or pg_catalog.jsonb_typeof(v_registry->'id') is distinct from 'number'
     or coalesce(v_registry->>'id','') !~ '^[1-9][0-9]*$'
     or coalesce(v_registry->>'updated_at','') = ''
     or pg_catalog.jsonb_typeof(v_registry->'updated_at') is distinct from 'string'
     or not pg_catalog.pg_input_is_valid(v_registry->>'updated_at','timestamp with time zone') then
    raise exception 'invalid identity or registry';
  end if;

  if pg_catalog.jsonb_typeof(v_before->'played_at') is distinct from 'string'
     or coalesce(v_before->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_before->>'played_at','timestamp with time zone')
     or pg_catalog.jsonb_typeof(v_before->'kills') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_before->'damage') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_before->'win_place') is distinct from 'number'
     or coalesce(v_before->>'kills','') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(v_before->>'damage','') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(v_before->>'win_place','') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(v_before->>'map_name','') = ''
     or lower(pg_catalog.btrim(v_before->>'map_name')) in ('unknown','unavailable')
     or coalesce(v_before->>'game_mode','') = ''
     or lower(pg_catalog.btrim(v_before->>'game_mode')) in ('unknown','unavailable')
     or coalesce(v_before->>'match_type','') = '' then
    raise exception 'invalid basic fields';
  end if;

  foreach v_number in array array[v_before->>'kills',v_before->>'damage',v_before->>'win_place'] loop
    if v_number::numeric > 2147483647 then raise exception 'basic integer out of range'; end if;
  end loop;
  if (v_before->>'win_place')::integer < 1
     or ((v_before->>'kills')::integer = 0 and (v_before->>'damage')::integer = 0
       and (v_before->>'win_place')::integer = 99) then
    raise exception 'placeholder basic stats';
  end if;
  v_played_at := (v_before->>'played_at')::timestamptz;
  v_registry_updated_at := (v_registry->>'updated_at')::timestamptz;
  if v_played_at >= pg_catalog.now() - interval '14 days' or v_played_at > pg_catalog.now() then
    raise exception 'match is still within retention window';
  end if;

  if coalesce(v_registry->>'telemetry_version','')::numeric <> pg_catalog.trunc((v_registry->>'telemetry_version')::numeric)
     or (v_registry->>'telemetry_version')::numeric > 9007199254740991
     or coalesce(v_storage_path,'') is distinct from
       'telemetry-map/v' || pg_catalog.trunc((v_registry->>'telemetry_version')::numeric)::text || '/' || v_platform || '/' || v_match_id || '/' ||
       pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_account_id,'UTF8')),'hex'),1,32) || '/full.json' then
    raise exception 'invalid telemetry key';
  end if;

  if pg_catalog.jsonb_typeof(v_summary) is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_summary)) <> 14
     or pg_catalog.octet_length(v_summary::text) > 32768
     or not (v_summary ?& array['matchId','createdAt','mapName','gameMode','matchType','v','isSummary',
       'summarySource','performanceOnly','performanceHistorical','retentionRecoveryContext','stats',
       'replayObservedMetrics','retentionRecoveryEvidence']::text[])
     or pg_catalog.jsonb_typeof(v_summary->'matchId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_summary->'createdAt') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_summary->'mapName') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_summary->'gameMode') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_summary->'matchType') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_summary->'summarySource') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_summary->'retentionRecoveryContext') is distinct from 'string'
     or v_summary->>'matchId' is distinct from v_match_id
     or not pg_catalog.pg_input_is_valid(v_summary->>'createdAt','timestamp with time zone')
     or (v_summary->>'createdAt')::timestamptz is distinct from v_played_at
     or v_summary->>'mapName' is distinct from v_before->>'map_name'
     or v_summary->>'gameMode' is distinct from v_before->>'game_mode'
     or v_summary->>'matchType' is distinct from v_before->>'match_type'
     or pg_catalog.jsonb_typeof(v_summary->'v') is distinct from 'number'
     or v_summary->>'v' is distinct from '0'
     or v_summary->'isSummary' is distinct from 'true'::jsonb
     or v_summary->>'summarySource' is distinct from 'pubg_match_performance'
     or v_summary->'performanceOnly' is distinct from 'true'::jsonb
     or v_summary->'performanceHistorical' is distinct from 'true'::jsonb
     or v_summary->>'retentionRecoveryContext' is distinct from 'partial-legacy-map-events'
     or pg_catalog.jsonb_typeof(v_stats) is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_stats)) not between 6 and 8
     or not (v_stats ?& array['name','playerId','kills','damageDealt','winPlace','rank']::text[])
     or exists (select 1 from pg_catalog.jsonb_object_keys(v_stats) as keys(key)
       where keys.key <> all(array['name','playerId','kills','damageDealt','winPlace','rank','DBNOs','timeSurvived']::text[]))
     or pg_catalog.jsonb_typeof(v_stats->'name') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_stats->'playerId') is distinct from 'string'
     or lower(v_stats->>'name') is distinct from lower(v_player_id)
     or v_stats->>'playerId' is distinct from v_account_id
     or pg_catalog.jsonb_typeof(v_stats->'kills') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_stats->'damageDealt') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_stats->'winPlace') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_stats->'rank') is distinct from 'number'
     or coalesce(v_stats->>'kills','') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(v_stats->>'winPlace','') !~ '^[1-9][0-9]*$'
     or pg_catalog.floor((v_stats->>'damageDealt')::numeric) is distinct from (v_before->>'damage')::numeric
     or (v_stats->>'kills')::numeric is distinct from (v_before->>'kills')::numeric
     or (v_stats->>'winPlace')::numeric is distinct from (v_before->>'win_place')::numeric
     or v_stats->>'rank' is distinct from v_before->>'win_place'
     or (v_stats->>'damageDealt')::numeric < 0
     or (v_stats->>'damageDealt')::numeric >= (v_before->>'damage')::numeric + 1
     or (v_before->'knocks' is not distinct from 'null'::jsonb and v_stats ? 'DBNOs')
     or (v_before->'knocks' is distinct from 'null'::jsonb and
       (pg_catalog.jsonb_typeof(v_stats->'DBNOs') is distinct from 'number'
        or v_stats->>'DBNOs' is distinct from v_before->>'knocks'))
     or (v_before->'survival_time' is not distinct from 'null'::jsonb and v_stats ? 'timeSurvived')
     or (v_before->'survival_time' is distinct from 'null'::jsonb and
       (pg_catalog.jsonb_typeof(v_stats->'timeSurvived') is distinct from 'number'
        or v_stats->>'timeSurvived' is distinct from v_before->>'survival_time'))
     or pg_catalog.jsonb_typeof(v_metrics) is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_metrics)) <> 3
     or not (v_metrics ?& array['knocks','shotEvents','reviveEvents']::text[])
     or pg_catalog.jsonb_typeof(v_metrics->'knocks') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_metrics->'shotEvents') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_metrics->'reviveEvents') is distinct from 'number'
     or coalesce(v_metrics->>'knocks','') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(v_metrics->>'shotEvents','') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(v_metrics->>'reviveEvents','') !~ '^(0|[1-9][0-9]*)$'
     or (v_metrics->>'knocks')::numeric > 100000
     or (v_metrics->>'shotEvents')::numeric > 100000
     or (v_metrics->>'reviveEvents')::numeric > 100000
     or coalesce(v_evidence->>'kind','') is distinct from 'legacy-map-retention-v1'
     or v_evidence->>'key' is distinct from v_storage_path
     or coalesce(v_evidence->>'sha256','') !~ '^[a-f0-9]{64}$'
     or coalesce(pg_catalog.btrim(v_evidence->>'etag'),'') = ''
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_evidence)) <> 8
     or not (v_evidence ?& array['kind','key','sha256','etag','sizeBytes','basicSnapshot','registryId','registryUpdatedAt']::text[])
     or pg_catalog.jsonb_typeof(v_evidence->'kind') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_evidence->'key') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_evidence->'sha256') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_evidence->'etag') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_evidence->'sizeBytes') is distinct from 'number'
     or coalesce(v_evidence->>'sizeBytes','') !~ '^[1-9][0-9]*$'
     or (v_evidence->>'sizeBytes')::numeric > 8388608
     or pg_catalog.jsonb_typeof(v_evidence->'registryId') is distinct from 'number'
     or v_evidence->>'registryId' is distinct from v_registry->>'id'
     or pg_catalog.jsonb_typeof(v_evidence->'registryUpdatedAt') is distinct from 'string'
     or not pg_catalog.pg_input_is_valid(v_evidence->>'registryUpdatedAt','timestamp with time zone')
     or (v_evidence->>'registryUpdatedAt')::timestamptz is distinct from v_registry_updated_at
     or pg_catalog.jsonb_typeof(v_evidence->'basicSnapshot') is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_evidence->'basicSnapshot')) <> 13
     or v_evidence->'basicSnapshot' is distinct from pg_catalog.jsonb_build_object(
       'account_id',v_account_id,'player_id',v_player_id,'platform',v_platform,'match_id',v_match_id,
       'played_at',v_before->'played_at','game_mode',v_before->'game_mode','map_name',v_before->'map_name',
       'kills',v_before->'kills','damage',v_before->'damage','win_place',v_before->'win_place',
       'match_type',v_before->'match_type','knocks',v_before->'knocks','survival_time',v_before->'survival_time') then
    raise exception 'invalid retained summary';
  end if;

  if pg_catalog.jsonb_typeof(v_performance->'calculation_version') is distinct from 'number'
     or v_performance->>'calculation_version' is distinct from '0'
     or pg_catalog.jsonb_typeof(v_performance->'result_version') is distinct from 'number'
     or v_performance->>'result_version' is distinct from '0'
     or pg_catalog.jsonb_typeof(v_performance->'summary_version') is distinct from 'number'
     or v_performance->>'summary_version' is distinct from '1'
     or v_performance->>'platform' is distinct from v_platform
     or v_performance->>'account_id' is distinct from v_account_id
     or v_performance->>'match_id' is distinct from v_match_id
     or v_performance->>'player_id' is distinct from v_player_id
     or not pg_catalog.pg_input_is_valid(v_performance->>'played_at','timestamp with time zone')
     or (v_performance->>'played_at')::timestamptz is distinct from v_played_at
     or coalesce(v_performance->>'source_checksum','') !~* '^[a-f0-9]{64}$'
     or v_performance->'score' is distinct from 'null'::jsonb
     or v_performance->'tier' is distinct from 'null'::jsonb
     or v_performance->'benchmark' is distinct from 'null'::jsonb
     or v_performance->'ranking_eligible' is distinct from 'false'::jsonb then
    raise exception 'invalid performance row';
  end if;

  perform pg_catalog.set_config('lock_timeout','1s',true);
  lock table public.telemetry_map_cache_entries,
    public.pubg_player_match_discovery,
    public.pubg_performance_jobs,
    public.pubg_player_matches,
    public.processed_match_telemetry,
    public.pubg_match_performance in share row exclusive mode nowait;
  v_lock_deadline := pg_catalog.clock_timestamp() + interval '1 second';

  if exists (select 1 from public.telemetry_map_cache_entries c
      where c.match_id = v_match_id and c.platform = v_platform
        and (c.lease_token is not null or c.lease_expires_at > pg_catalog.now()))
     or exists (select 1 from public.pubg_player_match_discovery d
      where d.match_id = v_match_id and d.platform = v_platform
        and (d.state in ('pending','retry','running') or d.lease_token is not null or d.lease_expires_at > pg_catalog.now()))
     or exists (select 1 from public.pubg_performance_jobs j
      where j.match_id = v_match_id and j.platform = v_platform
        and (j.state in ('pending','retry','running') or j.lease_token is not null or j.lease_expires_at > pg_catalog.now())) then
    raise exception 'active discovery or lease';
  end if;

  if exists (select 1 from public.processed_match_telemetry p
      where p.match_id = v_match_id and p.platform = v_platform and p.player_id = v_player_id)
     or exists (select 1 from public.pubg_match_performance p
      where p.match_id = v_match_id and p.platform = v_platform
        and (p.account_id = v_account_id or p.player_id = v_player_id))
     or exists (select 1 from public.pubg_player_matches m
      where m.match_id = v_match_id and m.platform = v_platform
        and m.account_id = v_account_id and m.player_id <> v_player_id) then
    raise exception 'analysis or account already exists';
  end if;

  if not exists (select 1 from public.pubg_player_matches m
      where m.match_id = v_match_id and m.platform = v_platform and m.player_id = v_player_id
        and m.account_id is null and pg_catalog.to_jsonb(m) = v_before)
     or not exists (select 1 from public.telemetry_map_cache_entries c
      where c.id = (v_registry->>'id')::bigint and c.match_id = v_match_id and c.platform = v_platform
        and c.player_id = v_account_id and pg_catalog.to_jsonb(c) = v_registry) then
    raise exception 'source snapshot changed';
  end if;

  if pg_catalog.clock_timestamp() > v_lock_deadline then raise exception 'recovery lock budget exceeded'; end if;
  update public.pubg_player_matches m
    set account_id = v_account_id
  where m.match_id = v_match_id and m.platform = v_platform and m.player_id = v_player_id
    and m.account_id is null and pg_catalog.to_jsonb(m) = v_before
  returning pg_catalog.to_jsonb(m) into v_basic_after;
  if v_basic_after is null or v_basic_after is distinct from v_expected then
    raise exception 'basic account link failed';
  end if;

  insert into public.pubg_match_performance (
    platform,account_id,match_id,player_id,calculation_version,result_version,
    score,tier,benchmark,ranking_eligible,calculated_at,summary,played_at,summary_version,source_checksum
  ) values (
    v_platform,v_account_id,v_match_id,v_player_id,0,0,
    null,null,null,false,pg_catalog.now(),v_summary,v_played_at,1,pg_catalog.lower(v_performance->>'source_checksum')
  );

  if pg_catalog.clock_timestamp() > v_lock_deadline then raise exception 'recovery lock budget exceeded'; end if;
  return pg_catalog.jsonb_build_object('saved',true,'basic',v_basic_after);
exception when others then
  raise exception 'legacy-map-retention-recovery-failed' using errcode = 'P0001';
end;
$$;

revoke all on function public.recover_retention_legacy_map(jsonb) from public, anon, authenticated;
grant execute on function public.recover_retention_legacy_map(jsonb) to service_role;
