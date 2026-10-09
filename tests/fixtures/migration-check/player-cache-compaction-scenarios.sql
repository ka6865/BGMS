-- verify:migrations의 일회용 DB에서만 실행하고 데이터는 모두 되돌린다.
begin;
truncate public.pubg_player_cache;
do $$
declare
  result jsonb;
  batch integer;
begin
  if has_function_privilege('anon', 'public.compact_pubg_player_cache(integer,boolean,integer,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.compact_pubg_player_cache(integer,boolean,integer,integer)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.compact_pubg_player_cache(integer,boolean,integer,integer)', 'EXECUTE')
    or exists (select from pg_proc where oid = 'public.compact_pubg_player_cache(integer,boolean,integer,integer)'::regprocedure and prosecdef) then
    raise exception 'player cache compaction must remain service-only and security invoker';
  end if;

  -- 같은 시각에 수집된 캐시도 ID로 순서를 정해 최근 보존 개수를 정확히 지킨다.
  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at)
  select 'compact-' || lpad(n::text, 3, '0'), 'fixture', 'fixture', 'steam', now() - interval '1 day'
  from generate_series(1, 30) n;
  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at, search_count, season_stats_data, last_seen_at) values
    ('searched', 'fixture', 'fixture', 'steam', now() - interval '1 year', 1, null, null),
    ('season', 'fixture', 'fixture', 'steam', now() - interval '1 year', 0, '{}'::jsonb, null),
    ('seen', 'fixture', 'fixture', 'steam', now() - interval '1 year', 0, null, now()),
    ('cutoff', 'fixture', 'fixture', 'steam', now() - interval '1 year', 0, null, now() - interval '90 days');

  execute 'set local role service_role';
  result := public.compact_pubg_player_cache(90, false, 10, 3);
  if result @> '{"candidate_count":27,"deleted_count":0,"remaining_count":27,"total_count":34,"dry_run":true,"keep_recent":3}'::jsonb is not true
    or (select count(*) from public.pubg_player_cache) <> 34 then
    raise exception 'dry-run must protect recent rows without deleting: %', result;
  end if;

  for batch in 1..3 loop
    result := public.compact_pubg_player_cache(90, true, 10, 3);
    if (result->>'candidate_count')::integer <> 27 - (batch - 1) * 10
      or (result->>'deleted_count')::integer <> least(10, 27 - (batch - 1) * 10)
      or (result->>'remaining_count')::integer <> greatest(27 - batch * 10, 0)
      or (result->>'total_count')::integer <> greatest(27 - batch * 10, 0) + 7 then
      raise exception 'batch % must report real candidate, deleted, remaining and total counts: %', batch, result;
    end if;
  end loop;
  if (select array_agg(id order by id) from public.pubg_player_cache where id like 'compact-%')
    is distinct from array['compact-028', 'compact-029', 'compact-030'] then
    raise exception 'recent rows with tied timestamps must survive';
  end if;

  result := public.compact_pubg_player_cache(90, true, 10, 100);
  if result @> '{"candidate_count":0,"deleted_count":0,"remaining_count":0,"total_count":7}'::jsonb is not true then
    raise exception 'pool below the recent limit must be preserved: %', result;
  end if;

  result := public.compact_pubg_player_cache(null, null, null, null);
  if result @> '{"candidate_count":3,"deleted_count":0,"remaining_count":3,"total_count":7,"dry_run":true,"retention_days":90}'::jsonb is not true then
    raise exception 'null parameters must keep defaults and disable only the recent limit: %', result;
  end if;
  result := public.compact_pubg_player_cache(90, true, 10, 0);
  if result @> '{"candidate_count":3,"deleted_count":3,"remaining_count":0,"total_count":4}'::jsonb is not true then
    raise exception 'zero recent limit must still protect activity and season data: %', result;
  end if;

  truncate public.pubg_player_cache;
  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at)
  select 'dated-' || n, 'fixture', 'fixture', 'steam', now() from generate_series(1, 3) n;
  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at) values
    ('null-a', 'fixture', 'fixture', 'steam', null),
    ('null-b', 'fixture', 'fixture', 'steam', null),
    ('null-c', 'fixture', 'fixture', 'steam', null);
  result := public.compact_pubg_player_cache(90, true, 10, 4);
  if result @> '{"candidate_count":2,"deleted_count":2,"remaining_count":0,"total_count":4}'::jsonb is not true
    or not exists (select from public.pubg_player_cache where id = 'null-c') then
    raise exception 'null timestamps must sort last and still obey the exact recent limit: %', result;
  end if;

  begin
    perform public.compact_pubg_player_cache(90, true, 10, -1);
    raise exception 'negative recent limit accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.compact_pubg_player_cache(0, true, 10, 0);
    raise exception 'zero retention accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.compact_pubg_player_cache(90, true, 9, 0);
    raise exception 'undersized batch accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.compact_pubg_player_cache(90, true, 20001, 0);
    raise exception 'oversized batch accepted';
  exception when invalid_parameter_value then null;
  end;
  execute 'reset role';
  raise notice 'player cache compaction scenarios passed';
end $$;
rollback;
