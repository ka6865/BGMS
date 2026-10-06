begin;

create temporary table retention_binding_inputs (
  case_name text not null,
  player_id text not null,
  binding jsonb not null,
  primary key (case_name, player_id)
) on commit drop;

with fixtures(player_id, account_id, kills, damage, win_place) as (values
  ('retention_valid_a', 'account.retention-a', 0, 123, 5),
  ('retention_valid_b', 'account.retention-b', 1, 223, 4),
  ('retention_stale_processed_a', 'account.retention-c', 0, 323, 3),
  ('retention_stale_processed_b', 'account.retention-d', 1, 423, 2),
  ('retention_stale_basic_a', 'account.retention-e', 0, 523, 5),
  ('retention_stale_basic_b', 'account.retention-f', 1, 623, 4),
  ('retention_collision', 'account.retention-g', 0, 723, 3),
  ('retention_collision_other', 'account.retention-h', 0, 823, 2),
  ('retention_cross_a', 'account.retention-cross', 0, 923, 5),
  ('retention_cross_b', 'account.retention-cross', 1, 1023, 4)
)
insert into public.pubg_player_matches
  (match_id, platform, player_id, account_id, played_at, game_mode, map_name, kills, damage, win_place)
select '00000000-0000-0000-0000-000000000701', 'steam', f.player_id, null,
  '2026-08-01T00:00:00+00:00'::timestamptz, 'squad-fpp', 'Baltic_Main', f.kills, f.damage, f.win_place
from fixtures f;

insert into public.pubg_player_matches
  (match_id, platform, player_id, account_id, played_at, game_mode, map_name, kills, damage, win_place)
values
  ('00000000-0000-0000-0000-000000000702', 'kakao', 'retention_registry_only', null,
    '2026-08-02T00:00:00+00:00', 'solo-fpp', 'Erangel_Main', 0, 0, 1),
  ('00000000-0000-0000-0000-000000000703', 'steam', 'retention_no_assets', null,
    '2026-08-03T00:00:00+00:00', 'solo-fpp', 'Erangel_Main', 0, 0, 1);

insert into public.telemetry_map_cache_entries
  (match_id, platform, player_id, mode, telemetry_version, storage_path)
values
  ('00000000-0000-0000-0000-000000000702', 'kakao', 'retention_registry_only', 'full', 1,
   'retention/legacy-binding/registry-only.json');

with fixtures(player_id, account_id, kills, damage, win_place) as (values
  ('retention_valid_a', 'account.retention-a', 0, 123.7, 5),
  ('retention_valid_b', 'account.retention-b', 1, 223.7, 4),
  ('retention_stale_processed_a', 'account.retention-c', 0, 323.7, 3),
  ('retention_stale_processed_b', 'account.retention-d', 1, 423.7, 2),
  ('retention_stale_basic_a', 'account.retention-e', 0, 523.7, 5),
  ('retention_stale_basic_b', 'account.retention-f', 1, 623.7, 4),
  ('retention_collision', 'account.retention-g', 0, 723.7, 3),
  ('retention_collision_other', 'account.retention-h', 0, 823.7, 2),
  ('retention_cross_a', 'account.retention-cross', 0, 923.7, 5),
  ('retention_cross_b', 'account.retention-cross', 1, 1023.7, 4)
)
insert into public.processed_match_telemetry (match_id, platform, player_id, data)
select '00000000-0000-0000-0000-000000000701', 'steam', f.player_id,
  jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', '00000000-0000-0000-0000-000000000701',
    'platform', 'steam', 'player_id', f.player_id,
    'createdAt', '2026-08-01T00:00:00+00:00', 'matchType', 'official', 'gameMode', 'squad-fpp', 'mapName', '에란겔',
    'stats', jsonb_build_object('name', f.player_id, 'playerId', f.account_id,
      'kills', f.kills, 'damageDealt', f.damage, 'winPlace', f.win_place)
  ))
from fixtures f;

insert into retention_binding_inputs(case_name, player_id, binding)
select case_name, m.player_id,
  jsonb_build_object('before', to_jsonb(m), 'processed', to_jsonb(p),
    'accountId', p.data->'fullResult'->'stats'->>'playerId')
from (values
  ('valid', 'retention_valid_a'), ('valid', 'retention_valid_b'),
  ('stale_processed', 'retention_stale_processed_a'), ('stale_processed', 'retention_stale_processed_b'),
  ('stale_basic', 'retention_stale_basic_a'), ('stale_basic', 'retention_stale_basic_b'),
  ('collision', 'retention_collision'),
  ('cross', 'retention_cross_a'), ('cross', 'retention_cross_b')
) as selected(case_name, player_id)
join public.pubg_player_matches m using (player_id)
join public.processed_match_telemetry p using (match_id, platform, player_id);

do $checks$
declare
  payload jsonb;
  result_rows jsonb;
begin
  if (select prosecdef from pg_catalog.pg_proc
      where oid = 'public.bind_retention_legacy_accounts(jsonb)'::regprocedure) then
    raise exception 'RPC must use SECURITY INVOKER';
  end if;
  if (select proconfig from pg_catalog.pg_proc
      where oid = 'public.bind_retention_legacy_accounts(jsonb)'::regprocedure)
      is distinct from array['search_path=""']::text[] then
    raise exception 'RPC search_path must be empty';
  end if;
  if has_function_privilege('anon', 'public.bind_retention_legacy_accounts(jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.bind_retention_legacy_accounts(jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.bind_retention_legacy_accounts(jsonb)', 'EXECUTE') then
    raise exception 'RPC execute grants are incorrect';
  end if;

  if (select prosecdef from pg_catalog.pg_proc
      where oid = 'public.list_retention_archive_candidates(integer,timestamp with time zone,timestamp with time zone,text,text)'::regprocedure)
    or (select proconfig from pg_catalog.pg_proc
      where oid = 'public.list_retention_archive_candidates(integer,timestamp with time zone,timestamp with time zone,text,text)'::regprocedure)
      is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon', 'public.list_retention_archive_candidates(integer,timestamp with time zone,timestamp with time zone,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.list_retention_archive_candidates(integer,timestamp with time zone,timestamp with time zone,text,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.list_retention_archive_candidates(integer,timestamp with time zone,timestamp with time zone,text,text)', 'EXECUTE') then
    raise exception 'candidate RPC invoker/search_path/ACL mismatch';
  end if;

  perform pg_catalog.set_config('role', 'anon', true);
  begin
    perform public.bind_retention_legacy_accounts('[]'::jsonb);
    raise exception 'anon unexpectedly executed RPC';
  exception when insufficient_privilege then
    null;
  end;
  perform pg_catalog.set_config('role', 'postgres', true);

  select jsonb_build_array(binding) into payload
  from retention_binding_inputs where case_name = 'valid' and player_id = 'retention_valid_a';
  payload := jsonb_set(payload, '{0,before,played_at}',
    to_jsonb((pg_catalog.now() - interval '13 days')::text));
  perform pg_catalog.set_config('role', 'service_role', true);
  begin
    perform public.bind_retention_legacy_accounts(payload);
    raise exception 'recent legacy binding unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-evidence-conflict' then raise; end if;
  end;
  if (select count(*) from public.list_retention_archive_candidates(
      100, '2026-09-01T00:00:00+00:00'::timestamptz
    )) <> 11
    or exists (select 1 from public.list_retention_archive_candidates(
      100, '2026-09-01T00:00:00+00:00'::timestamptz
    ) where player_id = 'retention_no_assets')
    or not exists (select 1 from public.list_retention_archive_candidates(
      100, '2026-09-01T00:00:00+00:00'::timestamptz
    ) where player_id = 'retention_registry_only') then
    raise exception 'candidate source prioritization failed';
  end if;
  if (select count(*) from public.list_retention_archive_candidates(
      100, '2026-09-01T00:00:00+00:00'::timestamptz,
      '2026-08-01T00:00:00+00:00'::timestamptz, 'steam', '00000000-0000-0000-0000-000000000701'
    )) <> 1
    or not exists (select 1 from public.list_retention_archive_candidates(
      100, '2026-09-01T00:00:00+00:00'::timestamptz,
      '2026-08-01T00:00:00+00:00'::timestamptz, 'steam', '00000000-0000-0000-0000-000000000701'
    ) where player_id = 'retention_registry_only') then
    raise exception 'candidate keyset cursor failed';
  end if;
  begin
    perform * from public.list_retention_archive_candidates(100,
      pg_catalog.now() - interval '13 days');
    raise exception 'recent cutoff unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform * from public.list_retention_archive_candidates(0,
      '2026-09-01T00:00:00+00:00'::timestamptz);
    raise exception 'invalid limit unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform * from public.list_retention_archive_candidates(100,
      '2026-09-01T00:00:00+00:00'::timestamptz,
      null, 'steam', '00000000-0000-0000-0000-000000000701');
    raise exception 'partial cursor unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  perform pg_catalog.set_config('role', 'postgres', true);
  perform pg_catalog.set_config('role', 'authenticated', true);
  begin
    perform public.list_retention_archive_candidates(100, '2026-09-01T00:00:00+00:00'::timestamptz);
    raise exception 'authenticated unexpectedly executed candidate RPC';
  exception when insufficient_privilege then null;
  end;
  perform pg_catalog.set_config('role', 'postgres', true);

  select jsonb_agg(binding order by player_id) into payload
  from retention_binding_inputs where case_name = 'valid';
  perform pg_catalog.set_config('role', 'service_role', true);
  result_rows := public.bind_retention_legacy_accounts(payload);
  perform pg_catalog.set_config('role', 'postgres', true);
  if jsonb_array_length(result_rows) <> 2
    or (select count(*) from public.pubg_player_matches
        where player_id in ('retention_valid_a', 'retention_valid_b') and account_id is not null) <> 2 then
    raise exception 'valid multi-binding failed';
  end if;

  select jsonb_agg(binding order by player_id) into payload
  from retention_binding_inputs where case_name = 'stale_processed';
  update public.processed_match_telemetry set data = data || '{"changed":true}'::jsonb
  where player_id = 'retention_stale_processed_b';
  begin
    perform public.bind_retention_legacy_accounts(payload);
    raise exception 'stale processed snapshot unexpectedly succeeded';
  exception when others then
    if sqlerrm not in ('legacy-binding-current-snapshot-conflict', 'legacy-binding-evidence-conflict') then raise; end if;
  end;
  if exists (select 1 from public.pubg_player_matches
      where player_id in ('retention_stale_processed_a', 'retention_stale_processed_b') and account_id is not null) then
    raise exception 'stale processed scenario partially updated rows';
  end if;

  select jsonb_agg(binding order by player_id) into payload
  from retention_binding_inputs where case_name = 'stale_basic';
  update public.pubg_player_matches set kills = kills + 1 where player_id = 'retention_stale_basic_b';
  begin
    perform public.bind_retention_legacy_accounts(payload);
    raise exception 'stale basic snapshot unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-current-snapshot-conflict' then raise; end if;
  end;
  if exists (select 1 from public.pubg_player_matches
      where player_id in ('retention_stale_basic_a', 'retention_stale_basic_b') and account_id is not null) then
    raise exception 'stale basic scenario partially updated rows';
  end if;

  select binding into payload from retention_binding_inputs where case_name = 'collision';
  update public.pubg_player_matches set account_id = 'account.retention-g'
  where player_id = 'retention_collision_other';
  begin
    perform public.bind_retention_legacy_accounts(jsonb_build_array(payload));
    raise exception 'scoped account collision unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-current-snapshot-conflict' then raise; end if;
  end;
  if (select account_id from public.pubg_player_matches where player_id = 'retention_collision') is not null then
    raise exception 'collision scenario changed the target row';
  end if;

  select binding into payload from retention_binding_inputs where case_name = 'cross' and player_id = 'retention_cross_a';
  begin
    perform public.bind_retention_legacy_accounts(jsonb_build_array(payload, payload));
    raise exception 'duplicate identity unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-scope-invalid' then raise; end if;
  end;

  select jsonb_agg(binding order by player_id) into payload
  from retention_binding_inputs where case_name = 'cross';
  begin
    perform public.bind_retention_legacy_accounts(payload);
    raise exception 'cross-player account binding unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-scope-invalid' then raise; end if;
  end;
end;
$checks$;

rollback;
select 'retention legacy account binding scenarios passed' as result;
