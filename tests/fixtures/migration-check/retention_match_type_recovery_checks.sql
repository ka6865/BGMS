begin;

create temporary table retention_match_type_inputs (
  case_name text primary key,
  binding jsonb not null
) on commit drop;

create temporary table retention_match_type_specs (
  case_name text primary key,
  player_id text not null,
  account_id text not null,
  before_match_type text not null,
  full_match_type text,
  secondary_match_type text
) on commit drop;

insert into retention_match_type_specs values
  ('valid_airoyale', 'retention_type_airoyale', 'account.retention-type-airoyale', 'unknown', 'airoyale', null),
  ('valid_event', 'retention_type_event', 'account.retention-type-event', 'unavailable', 'event', 'event'),
  ('known_without_type', 'retention_type_known', 'account.retention-type-known', 'competitive', null, null),
  ('source_absent', 'retention_type_absent', 'account.retention-type-absent', 'unknown', null, null),
  ('source_unsupported', 'retention_type_unsupported', 'account.retention-type-unsupported', 'unavailable', 'arcade', null),
  ('secondary_array', 'retention_type_array', 'account.retention-type-array', 'unknown', 'official', null),
  ('secondary_conflict', 'retention_type_conflict', 'account.retention-type-conflict', 'unknown', 'official', 'competitive'),
  ('stale_basic', 'retention_type_stale_basic', 'account.retention-type-stale-basic', 'unknown', 'training', null),
  ('stale_full', 'retention_type_stale_full', 'account.retention-type-stale-full', 'unavailable', 'training', null);

with match_rows as (
  insert into public.pubg_player_matches
    (match_id, platform, player_id, account_id, played_at, game_mode, map_name, kills, damage, win_place, match_type)
  select '00000000-0000-0000-0000-' || lpad(row_number() over (order by case_name)::text, 12, '0'),
    'steam', player_id, null, '2026-08-01T00:00:00+00:00'::timestamptz,
    'squad-fpp', 'Baltic_Main', 2, 456, 3, before_match_type
  from retention_match_type_specs
  returning *
)
insert into public.processed_match_telemetry (match_id, platform, player_id, data)
select m.match_id, m.platform, m.player_id,
  jsonb_build_object('fullResult',
    jsonb_build_object(
      'matchId', m.match_id,
      'platform', m.platform,
      'player_id', m.player_id,
      'createdAt', '2026-08-01T00:00:00+00:00',
      'gameMode', 'squad-fpp',
      'mapName', '에란겔',
      'matchInfo', jsonb_build_object(
        'date', '2026-08-01T00:00:00+00:00',
        'map', '에란겔',
        'mode', 'squad-fpp'
      ) || case when s.secondary_match_type is null then '{}'::jsonb
        else jsonb_build_object('matchType', s.secondary_match_type) end,
      'stats', jsonb_build_object(
        'name', m.player_id,
        'playerId', s.account_id,
        'kills', 2,
        'damageDealt', 456.7,
        'winPlace', 3
      )
    ) || case when s.full_match_type is null then '{}'::jsonb
      else jsonb_build_object('matchType', s.full_match_type) end
  )
from match_rows m
join retention_match_type_specs s on s.player_id = m.player_id;

update public.processed_match_telemetry
set data = jsonb_set(data, '{fullResult,matchInfo}', '["matchType"]'::jsonb)
where player_id = 'retention_type_array';

insert into retention_match_type_inputs(case_name, binding)
select s.case_name,
  jsonb_build_object(
    'before', to_jsonb(m),
    'processed', to_jsonb(p),
    'accountId', s.account_id
  )
from retention_match_type_specs s
join public.pubg_player_matches m on m.player_id = s.player_id
join public.processed_match_telemetry p
  on p.match_id = m.match_id and p.platform = m.platform and p.player_id = m.player_id;

do $checks$
declare
  test_case text;
  payload jsonb;
  result_rows jsonb;
begin
  if (select prosecdef from pg_catalog.pg_proc
      where oid = 'public.bind_retention_legacy_accounts(jsonb)'::regprocedure)
    or (select proconfig from pg_catalog.pg_proc
      where oid = 'public.bind_retention_legacy_accounts(jsonb)'::regprocedure)
      is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon', 'public.bind_retention_legacy_accounts(jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.bind_retention_legacy_accounts(jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.bind_retention_legacy_accounts(jsonb)', 'EXECUTE') then
    raise exception 'updated RPC invoker/search_path/ACL mismatch';
  end if;

  foreach test_case in array array['valid_airoyale', 'valid_event', 'known_without_type'] loop
    select jsonb_build_array(binding) into payload
    from retention_match_type_inputs where case_name = test_case;
    perform pg_catalog.set_config('role', 'service_role', true);
    result_rows := public.bind_retention_legacy_accounts(payload);
    perform pg_catalog.set_config('role', 'postgres', true);
    if jsonb_array_length(result_rows) <> 1 then
      raise exception 'expected one updated row for %', test_case;
    end if;
  end loop;

  if exists (
    select 1
    from retention_match_type_inputs i
    join public.pubg_player_matches m
      on m.player_id = (i.binding->'before'->>'player_id')
    where i.case_name in ('valid_airoyale', 'valid_event', 'known_without_type')
      and (
        m.account_id is distinct from (i.binding->'accountId' #>> '{}')
        or m.match_type is distinct from case i.case_name
          when 'valid_airoyale' then 'airoyale'
          when 'valid_event' then 'event'
          else 'competitive'
        end
        or (to_jsonb(m) - 'account_id' - 'match_type')
          is distinct from ((i.binding->'before') - 'account_id' - 'match_type')
      )
  ) then
    raise exception 'valid match type recovery changed unexpected values';
  end if;

  foreach test_case in array array['source_absent', 'source_unsupported', 'secondary_conflict', 'secondary_array'] loop
    select jsonb_build_array(binding) into payload
    from retention_match_type_inputs where case_name = test_case;
    begin
      perform public.bind_retention_legacy_accounts(payload);
      raise exception 'expected evidence conflict for %', test_case;
    exception when others then
      if sqlerrm <> 'legacy-binding-evidence-conflict' then raise; end if;
    end;
  end loop;
  if exists (
    select 1 from public.pubg_player_matches
    where player_id in ('retention_type_absent', 'retention_type_unsupported', 'retention_type_conflict', 'retention_type_array')
      and account_id is not null
  ) then
    raise exception 'invalid match type evidence partially changed rows';
  end if;

  select jsonb_build_array(binding) into payload
  from retention_match_type_inputs where case_name = 'stale_basic';
  update public.pubg_player_matches set kills = kills + 1 where player_id = 'retention_type_stale_basic';
  begin
    perform public.bind_retention_legacy_accounts(payload);
    raise exception 'stale basic snapshot unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-current-snapshot-conflict' then raise; end if;
  end;
  if (select account_id is not null or match_type <> 'unknown' or kills <> 3
      from public.pubg_player_matches where player_id = 'retention_type_stale_basic') then
    raise exception 'stale basic snapshot partially changed the match';
  end if;

  select jsonb_build_array(binding) into payload
  from retention_match_type_inputs where case_name = 'stale_full';
  update public.processed_match_telemetry
  set data = data || '{"concurrent_change":true}'::jsonb
  where player_id = 'retention_type_stale_full';
  begin
    perform public.bind_retention_legacy_accounts(payload);
    raise exception 'stale full snapshot unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-binding-current-snapshot-conflict' then raise; end if;
  end;
  if (select account_id is not null or match_type <> 'unavailable'
      from public.pubg_player_matches where player_id = 'retention_type_stale_full') then
    raise exception 'stale full snapshot partially changed the match';
  end if;
end;
$checks$;

rollback;
select 'retention match type recovery scenarios passed' as result;
