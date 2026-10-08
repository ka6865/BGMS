begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 기존 자료를 부재 추정으로 basic_only로 바꾸지 않는다.
alter table public.pubg_player_matches
  add column retention_scope text not null default 'legacy'
  check (retention_scope in ('legacy', 'basic_only', 'detail'));

create function public.preserve_player_match_retention_scope()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.retention_scope is null or new.retention_scope not in ('legacy', 'basic_only', 'detail') then
    return new;
  end if;
  if old.retention_scope = 'detail'
    or (old.retention_scope = 'legacy' and new.retention_scope = 'basic_only') then
    new.retention_scope := old.retention_scope;
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_player_match_retention_scope() from public, anon, authenticated;
grant execute on function public.preserve_player_match_retention_scope() to service_role;

create trigger preserve_player_match_retention_scope
before update on public.pubg_player_matches
for each row execute function public.preserve_player_match_retention_scope();

comment on column public.pubg_player_matches.retention_scope is
  'Per-match retention evidence: legacy=unclassified existing writer, basic_only=official basic ingestion, detail=personal analysis. Actual personal references always require a retained summary.';

-- Cursor 범위의 경기별 최소 시각만 읽고 LIMIT 전에 참가자를 중복 제거한다.
create index idx_pubg_match_retention_cursor on public.pubg_player_matches(played_at,platform,match_id,player_id);
create index idx_pubg_match_retention_identity on public.pubg_player_matches(platform,match_id,played_at);
create or replace function public.list_retention_archive_candidates(
  p_limit integer,
  p_cutoff timestamptz,
  p_after_played_at timestamptz default null,
  p_after_platform text default null,
  p_after_match_id text default null
)
returns setof public.pubg_player_matches
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000
    or p_cutoff is null
    or p_cutoff > pg_catalog.now() - interval '14 days' then
    raise exception 'retention-candidate-input-invalid' using errcode = '22023';
  end if;

  if not (
    p_after_played_at is null and p_after_platform is null and p_after_match_id is null
  ) and (
    p_after_played_at is null or p_after_platform is null or p_after_match_id is null
    or p_after_platform not in ('steam', 'kakao')
    or p_after_match_id !~ '^[A-Za-z0-9_-]{1,128}$'
    or p_after_played_at >= p_cutoff
  ) then
    raise exception 'retention-candidate-cursor-invalid' using errcode = '22023';
  end if;

  return query
  select distinct on (m.played_at,m.platform,m.match_id) m.*
  from public.pubg_player_matches m
  where m.platform in ('steam','kakao') and m.played_at < p_cutoff
    and (p_after_played_at is null
      or (m.played_at,m.platform,m.match_id) > (p_after_played_at,p_after_platform,p_after_match_id))
    and not exists(select 1 from public.pubg_player_matches earlier
      where earlier.platform=m.platform and earlier.match_id=m.match_id and earlier.played_at<m.played_at)
    and (exists(select 1 from public.telemetry_map_cache_entries c
      where c.platform=m.platform and c.match_id=m.match_id)
      or exists(select 1 from public.processed_match_telemetry t
        where t.platform=m.platform and t.match_id=m.match_id))
  order by m.played_at,m.platform,m.match_id,m.player_id
  limit p_limit;
end;
$$;

revoke all on function public.list_retention_archive_candidates(integer, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.list_retention_archive_candidates(integer, timestamptz, timestamptz, text, text)
  to service_role;

-- 큰 분석 JSON을 전체 전적에서 펼치지 않고 정리 cursor의 다음 100경기 범위만 읽는다.
-- 닉네임 지정 검증은 기존 범위 조회를 유지하며, 이 함수는 cursor를 이동하지 않는다.
create or replace function public.list_unretained_match_performance(p_limit integer default 100,p_player_id text default null)
returns setof public.processed_match_telemetry
language sql stable security invoker set search_path='' as $$
  with scope_rows as materialized (
    select distinct m.played_at,m.platform,m.match_id
    from public.pubg_player_matches m cross join public.pubg_archive_cleanup_cursor c
    where p_player_id is null and c.id=1
      and m.platform in ('steam','kakao') and m.played_at<now()-interval '14 days'
      and (c.played_at is null or (m.played_at,m.platform,m.match_id)>(c.played_at,c.platform,c.match_id))
      and not exists(select 1 from public.pubg_player_matches earlier
        where earlier.platform=m.platform and earlier.match_id=m.match_id and earlier.played_at<m.played_at)
    order by m.played_at,m.platform,m.match_id
    limit 100
  ), scope_keys as materialized (
    select distinct match_id,platform from scope_rows
  ), sources as materialized (
    select s.* from public.processed_match_telemetry s
      where p_player_id is not null and s.player_id=lower(trim(p_player_id))
    union all
    select s.* from scope_keys k join public.processed_match_telemetry s
      on s.match_id=k.match_id and s.platform=k.platform
      where p_player_id is null
  )
  select s.* from sources s
  where s.platform in ('steam','kakao')
    and s.data->'fullResult'->'stats'->>'playerId' ~ '^account\.[A-Za-z0-9_-]+$'
    and s.data->'fullResult'->>'v' ~ '^[0-9]+$'
    and coalesce(s.data->'fullResult'->>'calculationVersion','0') ~ '^[0-9]+$'
    and lower(trim(s.data->'fullResult'->'stats'->>'name'))=s.player_id
    and not exists (select 1 from public.pubg_match_performance p where p.platform=s.platform
      and p.player_id=s.player_id and p.match_id=s.match_id
      and p.account_id=s.data->'fullResult'->'stats'->>'playerId'
      and p.result_version=(s.data->'fullResult'->>'v')::integer
      and p.calculation_version=coalesce(s.data->'fullResult'->>'calculationVersion','0')::integer
      and p.summary_version=1 and p.summary is not null)
  order by s.updated_at,s.platform,s.player_id,s.match_id
  limit greatest(0,least(coalesce(p_limit,100),1000));
$$;
revoke all on function public.list_unretained_match_performance(integer,text) from public,anon,authenticated;
grant execute on function public.list_unretained_match_performance(integer,text) to service_role;

-- retention_scope 컬럼 추가 뒤 같은 migration에 포함할 보완안. 운영 적용하지 않음.
-- 누락 키만 legacy로 보완하며 명시된 값, CAS, 잠금, 권한, 보존 근거는 유지한다.
do $migration$
declare
  patch record;
  definition text;
begin
  for patch in
    select * from (values
      (
        'public.bind_retention_legacy_accounts(jsonb)',
        $binding_old$  if exists (
    select 1
    from jsonb_to_recordset(p_bindings) as b("before" jsonb, processed jsonb, "accountId" text)$binding_old$,
        $binding_new$  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(item.value, '{before}',
      '{"retention_scope":"legacy"}'::jsonb || (item.value->'before'), false)
    order by item.ordinality)
  into p_bindings
  from pg_catalog.jsonb_array_elements(p_bindings) with ordinality as item(value, ordinality);

  if exists (
    select 1
    from jsonb_to_recordset(p_bindings) as b("before" jsonb, processed jsonb, "accountId" text)$binding_new$
      ),
      (
        'public.recover_retention_legacy_map(jsonb)',
        $map_old$  v_before := p_packet->'before';
  v_registry := p_packet->'registry';
  v_expected := p_packet->'expectedBasic';$map_old$,
        $map_new$  v_before := '{"retention_scope":"legacy"}'::jsonb || (p_packet->'before');
  v_registry := p_packet->'registry';
  v_expected := '{"retention_scope":"legacy"}'::jsonb || (p_packet->'expectedBasic');$map_new$
      ),
      (
        'public.recover_retention_legacy_team(jsonb)',
        $team_old$  v_before := p_packet->'before';
  v_source_basic := p_packet->'sourceBasic';
  v_source_processed := p_packet->'processedSource';
  v_expected := p_packet->'expectedBasic';$team_old$,
        $team_new$  v_before := '{"retention_scope":"legacy"}'::jsonb || (p_packet->'before');
  v_source_basic := '{"retention_scope":"legacy"}'::jsonb || (p_packet->'sourceBasic');
  v_source_processed := p_packet->'processedSource';
  v_expected := '{"retention_scope":"legacy"}'::jsonb || (p_packet->'expectedBasic');$team_new$
      )
    ) as patches(signature, old_text, new_text)
  loop
    select pg_catalog.pg_get_functiondef(patch.signature::regprocedure) into definition;
    if pg_catalog.array_length(pg_catalog.string_to_array(definition, patch.old_text), 1) <> 2 then
      raise exception 'unexpected retention scope compatibility function definition';
    end if;
    execute pg_catalog.replace(definition, patch.old_text, patch.new_text);
  end loop;
end;
$migration$;

-- 선택한 경기의 참가자 전적이 부분 저장되면 기존 저장 확인으로 재시도를 건너뛸 수 있다.
create function public.upsert_pubg_participant_matches(p_records jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare expected_count integer; saved_count integer;
begin
  if p_records is null or jsonb_typeof(p_records) is distinct from 'array'
    or jsonb_array_length(p_records) not between 1 and 100
    or octet_length(p_records::text)>131072 then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  expected_count := jsonb_array_length(p_records);
  if exists(select 1 from jsonb_array_elements(p_records) x where jsonb_typeof(x) <> 'object'
    or coalesce(x->>'account_id','') !~ '^account\.[A-Za-z0-9_-]+$'
    or coalesce(x->>'platform','') not in ('steam','kakao')
    or coalesce(x->>'match_id','') !~ '^[A-Za-z0-9_.-]{1,128}$'
    or coalesce(x->>'retention_scope','') not in ('basic_only','detail')
    or length(coalesce(x->>'player_id','')) not between 1 and 64
    or x->>'player_id' is distinct from lower(trim(x->>'player_id'))
    or jsonb_typeof(x->'ranking_eligible') is distinct from 'boolean'
    or coalesce(lower(x->>'game_mode'),'') in ('','unknown','unavailable')
    or coalesce(lower(x->>'map_name'),'') in ('','unknown','unavailable')
    or coalesce(x->>'match_type','') in ('','unavailable')
    or coalesce(x->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
    or not pg_catalog.pg_input_is_valid(coalesce(x->>'played_at',''),'timestamp with time zone')
    or jsonb_typeof(x->'kills') is distinct from 'number'
    or jsonb_typeof(x->'damage') is distinct from 'number'
    or jsonb_typeof(x->'win_place') is distinct from 'number') then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  if (select count(distinct (r.platform,r.match_id,r.played_at)) from jsonb_to_recordset(p_records)
      r(platform text,match_id text,played_at timestamptz))<>1
    or (select count(distinct x->>'account_id') from jsonb_array_elements(p_records) x)<>expected_count
    or (select count(distinct x->>'player_id') from jsonb_array_elements(p_records) x)<>expected_count then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_records) r(kills numeric,damage numeric,win_place numeric,knocks numeric,survival_time numeric)
    where r.kills not between 0 and 2147483647 or r.kills<>trunc(r.kills)
      or r.damage not between 0 and 2147483647 or r.damage<>trunc(r.damage)
      or r.win_place not between 1 and 2147483647 or r.win_place<>trunc(r.win_place)
      or (r.knocks is not null and (r.knocks not between 0 and 2147483647 or r.knocks<>trunc(r.knocks)))
      or (r.survival_time is not null and (r.survival_time not between 0 and 2147483647 or r.survival_time<>trunc(r.survival_time)))) then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  insert into public.pubg_player_matches as stored
    (account_id,retention_scope,ranking_eligible,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,knocks,survival_time)
  select r.account_id,r.retention_scope,r.ranking_eligible,r.player_id,r.platform,r.match_id,r.played_at,r.game_mode,r.map_name,
    r.kills,r.damage,r.win_place,r.match_type,r.knocks,r.survival_time
  from jsonb_to_recordset(p_records) r(account_id text,retention_scope text,ranking_eligible boolean,player_id text,
    platform text,match_id text,played_at timestamptz,game_mode text,map_name text,kills integer,damage integer,win_place integer,
    match_type text,knocks integer,survival_time integer)
  order by r.player_id
  on conflict(player_id,platform,match_id) do update set
    account_id=excluded.account_id,retention_scope=excluded.retention_scope,ranking_eligible=excluded.ranking_eligible,
    played_at=excluded.played_at,game_mode=excluded.game_mode,map_name=excluded.map_name,
    kills=excluded.kills,damage=excluded.damage,win_place=excluded.win_place,match_type=excluded.match_type,
    knocks=coalesce(excluded.knocks,stored.knocks),survival_time=coalesce(excluded.survival_time,stored.survival_time)
  where stored.account_id is null or stored.account_id=excluded.account_id;
  get diagnostics saved_count=row_count;
  if saved_count<>expected_count then
    raise exception 'participant-match-account-conflict' using errcode='22023';
  end if;
  return saved_count;
end;
$$;
revoke all on function public.upsert_pubg_participant_matches(jsonb) from public,anon,authenticated;
grant execute on function public.upsert_pubg_participant_matches(jsonb) to service_role;
commit;
