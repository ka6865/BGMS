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

-- 참가자 수가 늘어도 후보 상한은 경기 수로 계산한다.
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
  with match_keys as materialized (
    select m.platform,m.match_id,min(m.played_at) as played_at
    from public.pubg_player_matches m
    where m.platform in ('steam','kakao') and m.played_at < p_cutoff
    group by m.platform,m.match_id
  ), candidates as materialized (
    select k.* from match_keys k
    where (p_after_played_at is null
      or (k.played_at,k.platform,k.match_id) > (p_after_played_at,p_after_platform,p_after_match_id))
      and (exists(select 1 from public.telemetry_map_cache_entries c
        where c.platform=k.platform and c.match_id=k.match_id)
        or exists(select 1 from public.processed_match_telemetry t
          where t.platform=k.platform and t.match_id=k.match_id))
    order by k.played_at,k.platform,k.match_id
    limit p_limit
  )
  select representative.* from candidates k
  cross join lateral (
    select m.* from public.pubg_player_matches m
    where m.platform=k.platform and m.match_id=k.match_id and m.played_at=k.played_at
    order by m.player_id limit 1
  ) representative
  order by k.played_at,k.platform,k.match_id;
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
    select m.match_id,m.platform
    from public.pubg_player_matches m cross join public.pubg_archive_cleanup_cursor c
    where p_player_id is null and c.id=1
      and m.platform in ('steam','kakao') and m.played_at<now()-interval '14 days'
    group by m.platform,m.match_id,c.played_at,c.platform,c.match_id
    having c.played_at is null or (min(m.played_at),m.platform,m.match_id)>(c.played_at,c.platform,c.match_id)
    order by min(m.played_at),m.platform,m.match_id
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
commit;
