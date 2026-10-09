create or replace function public.bind_retention_legacy_accounts(p_bindings jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  binding_count integer;
  updated_rows jsonb;
begin
  if jsonb_typeof(p_bindings) is distinct from 'array' then
    raise exception 'legacy-binding-scope-invalid';
  end if;

  binding_count := jsonb_array_length(p_bindings);
  if binding_count < 1 or binding_count > 40 then
    raise exception 'legacy-binding-scope-invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_bindings) as item(value)
    where jsonb_typeof(value) is distinct from 'object'
      or jsonb_typeof(value->'before') is distinct from 'object'
      or jsonb_typeof(value->'processed') is distinct from 'object'
      or jsonb_typeof(value->'accountId') is distinct from 'string'
  ) then
    raise exception 'legacy-binding-scope-invalid';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_bindings) as b("before" jsonb, processed jsonb, "accountId" text)
    where coalesce(b."before"->>'match_id', '') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      or coalesce(b."before"->>'player_id', '') !~ '^[a-z0-9._-]+$'
      or coalesce(b."before"->>'platform', '') not in ('steam', 'kakao')
      or b."before"->'account_id' is distinct from 'null'::jsonb
      or coalesce(b."accountId", '') !~ '^account\.[A-Za-z0-9_-]+$'
      or b.processed->>'match_id' is distinct from b."before"->>'match_id'
      or b.processed->>'platform' is distinct from b."before"->>'platform'
      or b.processed->>'player_id' is distinct from b."before"->>'player_id'
      or b.processed->'data'->'fullResult'->>'matchId' is distinct from b."before"->>'match_id'
      or b.processed->'data'->'fullResult'->>'platform' is distinct from b."before"->>'platform'
      or b.processed->'data'->'fullResult'->>'player_id' is distinct from b."before"->>'player_id'
      or b.processed->'data'->'fullResult'->'stats'->>'playerId' is distinct from b."accountId"
      or (
        b."before"->>'match_type' in ('unknown', 'unavailable')
        and (
          jsonb_typeof(b.processed->'data'->'fullResult'->'matchType') is distinct from 'string'
          or b.processed->'data'->'fullResult'->>'matchType' not in (
            'official', 'competitive', 'custom', 'event', 'seasonal', 'airoyale', 'training'
          )
          or jsonb_typeof(b.processed->'data'->'fullResult'->'matchInfo') not in ('object', 'null')
          or (
            (b.processed->'data'->'fullResult'->'matchInfo') ? 'matchType'
            and (
              jsonb_typeof(b.processed->'data'->'fullResult'->'matchInfo'->'matchType') is distinct from 'string'
              or b.processed->'data'->'fullResult'->'matchInfo'->>'matchType'
                is distinct from b.processed->'data'->'fullResult'->>'matchType'
            )
          )
        )
      )
      or exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'stats'->'accountId',
          b.processed->'data'->'fullResult'->'playerId',
          b.processed->'data'->'fullResult'->'accountId'
        )) as a(value)
        where a.value <> 'null'::jsonb
          and a.value #>> '{}' is distinct from b."accountId"
      )
      or lower(b.processed->'data'->'fullResult'->'stats'->>'name') is distinct from b."before"->>'player_id'
      or jsonb_typeof(b.processed->'data'->'fullResult'->'stats'->'kills') is distinct from 'number'
      or jsonb_typeof(b.processed->'data'->'fullResult'->'stats'->'damageDealt') is distinct from 'number'
      or jsonb_typeof(b.processed->'data'->'fullResult'->'stats'->'winPlace') is distinct from 'number'
      or (b.processed->'data'->'fullResult'->'stats'->>'kills')::numeric < 0
      or (b.processed->'data'->'fullResult'->'stats'->>'damageDealt')::numeric < 0
      or (b.processed->'data'->'fullResult'->'stats'->>'winPlace')::numeric < 1
      or (b.processed->'data'->'fullResult'->'stats'->>'kills')::numeric is distinct from (b."before"->>'kills')::numeric
      or (b.processed->'data'->'fullResult'->'stats'->>'winPlace')::numeric is distinct from (b."before"->>'win_place')::numeric
      or floor((b.processed->'data'->'fullResult'->'stats'->>'damageDealt')::numeric) is distinct from (b."before"->>'damage')::numeric
      or coalesce(b."before"->>'played_at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      or not pg_catalog.pg_input_is_valid(b."before"->>'played_at', 'timestamp with time zone')
      or (b."before"->>'played_at')::timestamptz >= pg_catalog.now() - interval '14 days'
      or not exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'createdAt',
          b.processed->'data'->'fullResult'->'matchInfo'->'date'
        )) as d(value)
        where d.value <> 'null'::jsonb
      )
      or exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'createdAt',
          b.processed->'data'->'fullResult'->'matchInfo'->'date'
        )) as d(value)
        where d.value <> 'null'::jsonb
          and case
            when (d.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
            then (d.value #>> '{}')::timestamptz = (b."before"->>'played_at')::timestamptz
            else false
          end is not true
      )
      or not exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'mapName',
          b.processed->'data'->'fullResult'->'matchInfo'->'map'
        )) as m(value)
        where m.value <> 'null'::jsonb
      )
      or exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'mapName',
          b.processed->'data'->'fullResult'->'matchInfo'->'map'
        )) as m(value)
        where m.value <> 'null'::jsonb
          and coalesce(m.value #>> '{}', '') is distinct from b."before"->>'map_name'
          and coalesce(m.value #>> '{}', '') is distinct from case b."before"->>'map_name'
              when 'Baltic_Main' then '에란겔' when 'Erangel_Main' then '에란겔'
              when 'Savage_Main' then '사녹' when 'Desert_Main' then '미라마'
              when 'Summerland_Main' then '카라킨' when 'Chimera_Main' then '파라모'
              when 'Tiger_Main' then '태이고' when 'Kiki_Main' then '데스턴'
              when 'Neon_Main' then '론도' when 'DihorOtok_Main' then '비켄디'
              else null
            end
      )
      or not exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'gameMode',
          b.processed->'data'->'fullResult'->'matchInfo'->'mode'
        )) as g(value)
        where g.value <> 'null'::jsonb
      )
      or exists (
        select 1
        from jsonb_array_elements(jsonb_build_array(
          b.processed->'data'->'fullResult'->'gameMode',
          b.processed->'data'->'fullResult'->'matchInfo'->'mode'
        )) as g(value)
        where g.value <> 'null'::jsonb and g.value #>> '{}' is distinct from b."before"->>'game_mode'
      )
  ) then
    raise exception 'legacy-binding-evidence-conflict';
  end if;

  if (select count(distinct (b."before"->>'match_id', b."before"->>'platform', b."before"->>'player_id'))
      from jsonb_to_recordset(p_bindings) as b("before" jsonb, processed jsonb, "accountId" text)) <> binding_count
    or (select count(distinct (b."before"->>'match_id', b."before"->>'platform', b."accountId"))
      from jsonb_to_recordset(p_bindings) as b("before" jsonb, processed jsonb, "accountId" text)) <> binding_count then
    raise exception 'legacy-binding-scope-invalid';
  end if;

  perform pg_catalog.set_config('lock_timeout', '2s', true);
  -- 짧은 테이블 잠금으로 계정 연결 중 동일 경기 계정의 동시 삽입을 막는다.
  lock table public.pubg_player_matches in share row exclusive mode;

  with expected as materialized (
    select b."before" as before_row, b.processed as processed_row, b."accountId" as account_id
    from jsonb_to_recordset(p_bindings) as b("before" jsonb, processed jsonb, "accountId" text)
  ), locked_matches as materialized (
    select m.*, e.account_id as next_account
    from public.pubg_player_matches as m
    join expected as e
      on m.match_id = e.before_row->>'match_id'
      and m.platform = e.before_row->>'platform'
      and m.player_id = e.before_row->>'player_id'
    where m.account_id is null
      and pg_catalog.to_jsonb(m) = pg_catalog.to_jsonb(
        pg_catalog.jsonb_populate_record(null::public.pubg_player_matches, e.before_row)
      )
    order by m.match_id, m.platform, m.player_id
    for update of m
  ), locked_sources as materialized (
    select p.match_id, p.platform, p.player_id
    from public.processed_match_telemetry as p
    join expected as e
      on p.match_id = e.processed_row->>'match_id'
      and p.platform = e.processed_row->>'platform'
      and p.player_id = e.processed_row->>'player_id'
    where pg_catalog.to_jsonb(p) = pg_catalog.to_jsonb(
      pg_catalog.jsonb_populate_record(null::public.processed_match_telemetry, e.processed_row)
    )
    order by p.match_id, p.platform, p.player_id
    for share of p
  ), changed as (
    update public.pubg_player_matches as m
    set account_id = l.next_account,
        match_type = case
          when m.match_type in ('unknown', 'unavailable')
            then e.processed_row->'data'->'fullResult'->>'matchType'
          else m.match_type
        end
    from locked_matches as l
    join locked_sources as p using (match_id, platform, player_id)
    join expected as e
      on e.before_row->>'match_id' = l.match_id
      and e.before_row->>'platform' = l.platform
      and e.before_row->>'player_id' = l.player_id
    where m.match_id = l.match_id and m.platform = l.platform and m.player_id = l.player_id
      and m.account_id is null
      and pg_catalog.to_jsonb(m) = pg_catalog.to_jsonb(l) - 'next_account'
      and not exists (
        select 1 from public.pubg_player_matches as other
        where other.match_id = m.match_id and other.platform = m.platform and other.account_id = l.next_account
      )
    returning pg_catalog.to_jsonb(m) as row_data
  )
  select coalesce(pg_catalog.jsonb_agg(row_data order by row_data->>'match_id', row_data->>'platform', row_data->>'player_id'), '[]'::jsonb)
  into updated_rows
  from changed;

  if pg_catalog.jsonb_array_length(updated_rows) <> binding_count then
    raise exception 'legacy-binding-current-snapshot-conflict';
  end if;

  return updated_rows;
end;
$$;

revoke all on function public.bind_retention_legacy_accounts(jsonb) from public, anon, authenticated;
grant execute on function public.bind_retention_legacy_accounts(jsonb) to service_role;
