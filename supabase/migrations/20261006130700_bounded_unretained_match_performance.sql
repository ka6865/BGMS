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
      and (c.played_at is null or (m.played_at,m.platform,m.match_id)>(c.played_at,c.platform,c.match_id))
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
