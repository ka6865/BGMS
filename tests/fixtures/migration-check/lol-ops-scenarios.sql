begin;
set local lock_timeout = '2s';
set local role service_role;

do $$
declare
  v_status jsonb;
  v_day date := (pg_catalog.timezone('Asia/Seoul', pg_catalog.clock_timestamp()))::date;
begin
  perform public.increment_lol_ops_metric('riot_success', 2);
  perform public.increment_lol_ops_metric('riot_success', 3);
  if (select value from public.lol_ops_daily
      where day = v_day and metric = 'riot_success') <> 5 then
    raise exception 'metric increment did not accumulate';
  end if;
  v_status := public.get_lol_ops_status();
  if (v_status->>'today')::date <> v_day
     or (v_status->>'todayRiotCalls')::bigint < 5
     or jsonb_array_length(v_status->'metrics') < 1
     or jsonb_array_length(v_status->'rateLimits') <> 3
     or jsonb_array_length(v_status->'tables') <> 12 then
    raise exception 'LoL ops status contract mismatch: %', v_status;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_status->'tables') as t(value)
    where t.value->>'table' not in (
      'lol_accounts','lol_ranked_entries','lol_ranked_history','lol_matches',
      'lol_match_participants','lol_api_cache','lol_rate_limit_state',
      'lol_collection_leases','lol_ops_daily','lol_player_match_summaries',
      'lol_benchmark_processed_matches','lol_benchmark_aggregates'
    )
  ) then raise exception 'unexpected table in ops status'; end if;
  begin
    perform public.increment_lol_ops_metric('riot_secret', 1);
    raise exception 'invalid metric unexpectedly accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.increment_lol_ops_metric('riot_success', 0);
    raise exception 'invalid increment unexpectedly accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.increment_lol_ops_metric('riot_success', 1001);
    raise exception 'oversized increment unexpectedly accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.cleanup_lol_expired_batch(0);
    raise exception 'invalid cleanup limit unexpectedly accepted';
  exception when sqlstate '22023' then null;
  end;
end $$;

reset role;
do $$
declare
  v_function text;
begin
  if pg_catalog.has_table_privilege('anon', 'public.lol_ops_daily', 'insert')
     or pg_catalog.has_table_privilege('authenticated', 'public.lol_ops_daily', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.lol_ops_daily', 'insert')
     or not pg_catalog.has_table_privilege('service_role', 'public.lol_ops_daily', 'select')
     or not pg_catalog.has_table_privilege('service_role', 'public.lol_ops_daily', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.lol_ops_daily', 'delete') then
    raise exception 'LoL ops table DML grants are incorrect';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class
          where oid = 'public.lol_ops_daily'::regclass) then
    raise exception 'RLS is disabled on lol_ops_daily';
  end if;
  foreach v_function in array array[
    'public.increment_lol_ops_metric(text,integer)',
    'public.preview_lol_expired_data()',
    'public.cleanup_lol_expired_batch(integer)',
    'public.get_lol_ops_status()'
  ] loop
    if pg_catalog.has_function_privilege('anon', v_function, 'execute')
       or pg_catalog.has_function_privilege('authenticated', v_function, 'execute')
       or not pg_catalog.has_function_privilege('service_role', v_function, 'execute') then
      raise exception 'function execution grants are incorrect for %', v_function;
    end if;
  end loop;
end $$;

set role service_role;
select public.cleanup_lol_expired_data();

insert into public.lol_accounts (
  puuid, game_name, tag_line, platform_id, regional_route, last_accessed_at
) values
  ('ops-stale-1', 'Ops Stale One', 'OPS1', 'kr', 'asia', now() - interval '93 days'),
  ('ops-stale-2', 'Ops Stale Two', 'OPS2', 'kr', 'asia', now() - interval '91 days'),
  ('ops-fresh', 'Ops Fresh', 'OPS3', 'kr', 'asia', now());
insert into public.lol_ranked_entries (
  puuid, platform_id, queue_type, tier, rank, league_points, wins, losses
) values ('ops-stale-1', 'kr', 'RANKED_SOLO_5x5', 'GOLD', 'I', 10, 1, 1);
insert into public.lol_ranked_history (
  puuid, queue_type, tier, rank, league_points, wins, losses
) values ('ops-stale-1', 'RANKED_SOLO_5x5', 'GOLD', 'I', 10, 1, 1);

insert into public.lol_api_cache (
  cache_key, kind, platform_id, regional_route, data_version, payload, fetched_at, expires_at
) values
  ('ops-expired-cache-1', 'search', 'kr', 'asia', '1', '{}', now() - interval '4 minutes', now() - interval '2 minutes'),
  ('ops-expired-cache-2', 'search', 'kr', 'asia', '1', '{}', now() - interval '3 minutes', now() - interval '1 minute'),
  ('ops-fresh-cache', 'search', 'kr', 'asia', '1', '{}', now(), now() + interval '1 minute');

insert into public.lol_matches (
  match_id, platform_id, regional_route, queue_id, game_version, started_at,
  duration_seconds, teams, data_version, request_json, fetched_at, expires_at
) values
  ('KR_990001', 'kr', 'asia', 420, '1', now() - interval '8 days', 1800,
   '[]', 1, '{}', now() - interval '8 days', now() - interval '1 day'),
  ('KR_990002', 'kr', 'asia', 420, '1', now() - interval '7 days', 1800,
   '[]', 1, '{}', now() - interval '7 days', now() - interval '1 hour'),
  ('KR_990003', 'kr', 'asia', 420, '1', now(), 1800,
   '[]', 1, '{}', now(), now() + interval '1 day');
insert into public.lol_match_participants (
  match_id, participant_id, team_id, champion_id, win, played_at, queue_id
) select 'KR_990001', n, 100, n, true, now() - interval '8 days', 420
  from generate_series(1, 10) n;
insert into public.lol_match_participants (
  match_id, participant_id, team_id, champion_id, win, played_at, queue_id
) values ('KR_990002', 1, 100, 1, true, now() - interval '8 days', 420);

insert into public.lol_collection_leases (
  lease_key, lease_type, lease_token, lease_until
) values
  ('ops-expired-lease-1', 'collection', gen_random_uuid(), now() - interval '1 minute'),
  ('ops-expired-lease-2', 'collection', gen_random_uuid(), now() - interval '2 minutes'),
  ('ops-fresh-lease', 'collection', gen_random_uuid(), now() + interval '1 hour');

do $$
declare
  v_preview jsonb;
  v_batch jsonb;
begin
  v_preview := public.preview_lol_expired_data();
  if (v_preview->>'cache_rows')::integer <> 2
     or (v_preview->>'match_rows')::integer <> 2
     or (v_preview->>'account_rows')::integer <> 0
     or (v_preview->>'lease_rows')::integer <> 2 then
    raise exception 'preview count mismatch: %', v_preview;
  end if;
  v_batch := public.cleanup_lol_expired_batch(1);
  if (v_batch->'deleted'->>'cache_rows')::integer <> 1
     or (v_batch->'deleted'->>'match_rows')::integer <> 1
     or (v_batch->'deleted'->>'account_rows')::integer <> 0
     or (v_batch->'deleted'->>'lease_rows')::integer <> 1
     or (v_batch->'remaining'->>'cache_rows')::integer <> 1
     or (v_batch->'remaining'->>'match_rows')::integer <> 1
     or (v_batch->'remaining'->>'account_rows')::integer <> 0
     or (v_batch->'remaining'->>'lease_rows')::integer <> 1 then
    raise exception 'batch limit/result mismatch: %', v_batch;
  end if;
  if (select count(*) from public.lol_match_participants
      where match_id in ('KR_990001', 'KR_990002')) <> 1 then
    raise exception 'expired match cascade did not remove its participants';
  end if;
  if not exists (select 1 from public.lol_ranked_entries where puuid = 'ops-stale-1')
     or not exists (select 1 from public.lol_ranked_history where puuid = 'ops-stale-1') then
    raise exception 'account cleanup removed permanent ranked rows';
  end if;
  if not exists (select 1 from public.lol_accounts where puuid = 'ops-fresh')
     or not exists (select 1 from public.lol_api_cache where cache_key = 'ops-fresh-cache')
     or not exists (select 1 from public.lol_matches where match_id = 'KR_990003')
     or not exists (select 1 from public.lol_collection_leases where lease_key = 'ops-fresh-lease') then
    raise exception 'fresh data was deleted';
  end if;
  v_preview := public.preview_lol_expired_data();
  v_batch := public.cleanup_lol_expired_batch(1000);
  if v_batch->'deleted' <> v_preview then
    raise exception 'preview and actual deleted counts differ: %, %', v_preview, v_batch;
  end if;
  if (v_batch->'remaining'->>'cache_rows')::integer <> 0
     or (v_batch->'remaining'->>'match_rows')::integer <> 0
     or (v_batch->'remaining'->>'account_rows')::integer <> 0
     or (v_batch->'remaining'->>'lease_rows')::integer <> 0 then
    raise exception 'expired data remains after full batch: %', v_batch->'remaining';
  end if;
end $$;

reset role;
rollback;
