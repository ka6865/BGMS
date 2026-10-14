-- 랭킹을 지난주(한국시간 월~일) 기준으로 바꾼다. 월요일 0시에 잠정 공개하고 화요일 오전 9시에 확정한다.
-- 한 주에 조합마다 잠정·확정 두 번만 집계해 10초 주기 재집계의 디스크 I/O 를 없앤다.
-- 기간이 없는 기존 호출(get_pubg_rankings 8개 인자)은 최근 7일 동작을 유지한다.
drop function if exists public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]);
create or replace function public.get_pubg_rankings(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_excluded text[] default '{}',p_from timestamptz default null,p_to timestamptz default null)
returns table(platform text,player_id text,account_id text,value double precision,secondary double precision,tier text,game_mode text,map_name text,played_at timestamptz,match_count bigint)
language sql stable security invoker set search_path='' as $$
with tier_match_keys as materialized (
    select b.platform,b.player_id,b.match_id from public.global_benchmarks b
    where p_tab='tier'
      and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
      and b.filter_version=p_filter and b.population_evidence_version=p_population
      and b.match_type in ('official','competitive') and b.score is not null
    union
    select m.platform,m.player_id,m.match_id from public.pubg_match_performance f
    join public.pubg_player_matches m on m.platform=f.platform and m.account_id=f.account_id and m.match_id=f.match_id
    where p_tab='tier'
      and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
      and f.result_version=p_result and f.ranking_eligible
      and m.played_at>=coalesce(p_from,now()-interval '7 days') and m.played_at<coalesce(p_to,now()+interval '1 microsecond')
  ), candidate_matches as (
    select m.* from tier_match_keys k join public.pubg_player_matches m using (platform,player_id,match_id) where p_tab='tier'
    union all
    select m.* from public.pubg_player_matches m where p_tab<>'tier'
  ), candidates as (
    select m.platform,m.player_id,m.account_id,m.match_id,m.played_at,m.kills,m.damage,m.ranking_eligible,
      case when m.account_id ~ '^account\.[A-Za-z0-9_-]+$' then m.account_id else 'legacy:'||m.player_id end as identity
    from candidate_matches m
    where m.played_at>=coalesce(p_from,now()-interval '7 days') and m.played_at<coalesce(p_to,now()+interval '1 microsecond')
      and m.platform in ('steam','kakao') and m.game_mode=any(p_modes)
      and m.match_type in ('official','competitive') and (p_match_type='all' or m.match_type=p_match_type)
      and not ((m.platform||':'||lower(m.player_id))=any(p_excluded)
        or (m.account_id is not null and (m.platform||':account:'||m.account_id)=any(p_excluded))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_match_discovery discovery
          where discovery.platform=m.platform and discovery.match_id=m.match_id
            and (discovery.platform||':account:'||discovery.account_id)=any(p_excluded)
        ))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_cache cache
          where cache.platform=m.platform
            and cache.lower_nickname=lower(m.player_id)
            and (cache.platform||':account:'||cache.id)=any(p_excluded)
        )))
      and m.kills>=0 and m.damage>=0
  ), eligible as (
    select m.*,
      case when p_tab='tier' or m.ranking_eligible is not true then (
        select source.score from (
          select b.score,b.calculation_version,1 as source_priority
          from public.global_benchmarks b
          where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
            and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
            and b.filter_version=p_filter and b.population_evidence_version=p_population
            and b.match_type in ('official','competitive') and b.score is not null
          union all
          select f.score,f.calculation_version,2 as source_priority
          from public.pubg_match_performance f
          where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
            and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
            and f.result_version=p_result and f.ranking_eligible
        ) source order by source.calculation_version desc,source.source_priority limit 1
      ) end as performance_score
    from candidates m
  ), ranked as (
    select e.platform,e.player_id,e.match_id,e.identity,e.played_at,
      case p_tab when 'damage' then e.damage::double precision when 'kills' then e.kills::double precision else e.performance_score end as metric,
      case p_tab when 'damage' then e.kills::double precision else e.damage::double precision end as extra
    from eligible e where p_tab in ('damage','kills','tier')
      and (e.ranking_eligible is true or e.performance_score is not null)
      and (p_tab<>'tier' or e.performance_score is not null)
  ), best as (
    select r.*,row_number() over player_matches as pos,count(*) over player_matches as n
    from ranked r
    -- 전체 경기 수를 세되, 최고 경기 선택과 같은 정렬을 한 번만 수행한다.
    window player_matches as (partition by r.platform,r.identity
      order by r.metric desc,r.extra desc,r.played_at desc,r.match_id
      rows between unbounded preceding and unbounded following)
  ), winners as (
    select b.* from best b where pos=1
    order by metric desc,extra desc,played_at desc,b.platform,b.identity limit 30
  )
  select b.platform,b.player_id,m.account_id,b.metric,b.extra,s.tier,m.game_mode,m.map_name,b.played_at,b.n
  from winners b join public.pubg_player_matches m using (platform,player_id,match_id)
  left join lateral (
    select source.score,source.tier from (
        select b.score,b.tier,b.calculation_version,1 as source_priority
        from public.global_benchmarks b
        where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
          and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
          and b.filter_version=p_filter and b.population_evidence_version=p_population
          and b.match_type in ('official','competitive') and b.score is not null
        union all
        select f.score,f.tier,f.calculation_version,2 as source_priority
        from public.pubg_match_performance f
        where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
          and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
          and f.result_version=p_result and f.ranking_eligible
      ) source order by source.calculation_version desc,source.source_priority limit 1
  ) s on true
  order by b.metric desc,b.extra desc,b.played_at desc,b.platform,b.identity;
$$;
revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) to service_role;

-- 지난주 시작·끝과 확정 시각(이번 주 화요일 09:00 KST).
create or replace function public.pubg_ranking_week()
returns table(week_start timestamptz, week_end timestamptz, finalize_at timestamptz)
language sql stable set search_path='' as $$
  select monday - interval '7 days', monday, monday + interval '1 day 9 hours'
  from (select (date_trunc('week', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as monday) w;
$$;

drop function if exists public.pubg_ranking_cache_key(text,text[],text,integer,integer,integer,integer,text[]);
create or replace function public.pubg_ranking_cache_key(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_private_keys text[],p_week_start timestamptz
) returns text language sql immutable set search_path='' as $$
  select 'rankings:v2:'||md5(jsonb_build_array(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys,p_week_start)::text);
$$;

drop function if exists public.pubg_ranking_build(text,text[],text,integer,integer,integer,integer,text[],timestamptz);
create or replace function public.pubg_ranking_build(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,
  p_private_keys text[],p_requested_at timestamptz
) returns jsonb language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  entries jsonb; generated_at timestamptz; cached jsonb; w record; finalized boolean;
begin
  select * into w from public.pubg_ranking_week();
  select coalesce(jsonb_agg(to_jsonb(r)-'ordinality' order by ordinality),'[]'::jsonb) into entries
  from public.get_pubg_rankings(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys,w.week_start,w.week_end) with ordinality r;
  if not public.pubg_ranking_cached_entries_public(entries,p_private_keys) then return null; end if;
  generated_at:=clock_timestamp();
  finalized:=generated_at>=w.finalize_at;
  cached:=jsonb_build_object('entries',entries,'generated_at',generated_at,'requested_at',p_requested_at,
    'week_start',w.week_start,'week_end',w.week_end,'finalized',finalized,
    'params',jsonb_build_object('tab',p_tab,'modes',p_modes,'match_type',p_match_type,'calculation',p_calculation,
      'filter',p_filter,'population',p_population,'result',p_result));
  -- 잠정 결과는 확정 후 1시간까지 보여 주며 그 사이 예약 집계가 확정본으로 바꾼다. 확정본은 다음 주가 끝날 때까지 둔다.
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  values(public.pubg_ranking_cache_key(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys,w.week_start),
    cached,case when finalized then w.week_end+interval '7 days 1 hour' else w.finalize_at+interval '1 hour' end,generated_at)
  on conflict (cache_key) do update set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at;
  return cached;
end $$;

create or replace function public.get_pubg_rankings_cached(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer
) returns jsonb language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  private_keys text[]; current_excluded text[]; modes text[]; ranking_key text;
  cached jsonb; started_at timestamptz:=clock_timestamp(); aggregation_started timestamptz; aggregation_ms numeric:=0;
  attempt integer; is_public boolean;
begin
  if p_tab is null or p_tab not in ('damage','kills','tier')
    or p_match_type is null or p_match_type not in ('all','official','competitive')
    or p_modes is null or cardinality(p_modes)=0 or array_position(p_modes,null) is not null
    or not p_modes <@ array['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp']::text[]
    or p_calculation is null or p_filter is null or p_population is null or p_result is null
  then raise exception 'Invalid ranking query'; end if;
  select array_agg(distinct mode order by mode) into modes from unnest(p_modes) mode;
  private_keys:=public.pubg_ranking_private_keys();
  ranking_key:=public.pubg_ranking_cache_key(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,private_keys,(select week_start from public.pubg_ranking_week()));
  for attempt in 1..2 loop
    -- 트랜잭션 안에서 다른 캐시 키의 잠금을 추가로 잡지 않는다.
    if attempt>1 and public.pubg_ranking_private_keys() is distinct from private_keys
    then raise exception 'Ranking privacy changed during query'; end if;
    select payload into cached from public.pubg_response_cache c
    where c.cache_key=ranking_key and c.expires_at>clock_timestamp();
    if cached is null then
      -- 같은 조건의 다른 서버도 잠금 대기 후 완성된 결과를 재사용한다.
      perform pg_advisory_xact_lock(hashtextextended(ranking_key,0));
      select payload into cached from public.pubg_response_cache c
      where c.cache_key=ranking_key and c.expires_at>clock_timestamp();
    end if;
    if cached is not null then
      select public.pubg_ranking_private_keys(),public.pubg_ranking_cached_entries_public(cached->'entries',private_keys)
      into current_excluded,is_public;
      if current_excluded is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
      if is_public then
        perform public.pubg_ranking_mark_requested(ranking_key,cached);
        return (cached-'params'-'requested_at')||jsonb_build_object('cache_hit',true,
          'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',0);
      end if;
      perform pg_advisory_xact_lock(hashtextextended(ranking_key,0));
      -- 잠금 대기 중 다른 요청이 비공개 대상을 제외하고 다시 채웠을 수 있다.
      select payload into cached from public.pubg_response_cache c
      where c.cache_key=ranking_key and c.expires_at>clock_timestamp();
      select public.pubg_ranking_private_keys(),public.pubg_ranking_cached_entries_public(cached->'entries',private_keys)
      into current_excluded,is_public;
      if current_excluded is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
      if cached is not null and is_public then
        perform public.pubg_ranking_mark_requested(ranking_key,cached);
        return (cached-'params'-'requested_at')||jsonb_build_object('cache_hit',true,
          'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',0);
      end if;
    end if;
    aggregation_started:=clock_timestamp();
    cached:=public.pubg_ranking_build(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,private_keys,clock_timestamp());
    aggregation_ms:=aggregation_ms+round(extract(epoch from clock_timestamp()-aggregation_started)*1000);
    if public.pubg_ranking_private_keys() is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
    if cached is null then continue; end if;
    return (cached-'params'-'requested_at')||jsonb_build_object('cache_hit',false,
      'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',aggregation_ms);
  end loop;
  raise exception 'Ranking privacy changed during query';
end $$;

-- 30초마다 한 조합만 집계한다. 대상은 (1) 이번 주 등록·잠정 결과 중 확정 시각이 지난 것,
-- (2) 지난 2주 안에 조회된 조합인데 이번 주 결과가 아직 없는 것(월요일 0시 이후 미리 채움)이다.
create or replace function public.refresh_pubg_rankings_cache()
returns integer language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  target record; private_keys text[]; params jsonb; modes text[]; next_key text; w record; current_row record;
begin
  if not pg_try_advisory_xact_lock(20261014150000) then return 0; end if;
  select * into w from public.pubg_ranking_week();
  private_keys:=public.pubg_ranking_private_keys();
  for target in
    select c.cache_key,c.payload->'params' as params,(c.payload->>'requested_at')::timestamptz as requested_at
    from public.pubg_response_cache c
    where c.cache_key like 'rankings:v2:%' and c.payload ? 'params' and c.payload ? 'requested_at'
      and (c.payload->>'requested_at')::timestamptz>clock_timestamp()-interval '14 days'
    order by c.updated_at
  loop
    params:=target.params;
    select array_agg(m order by m) into modes from jsonb_array_elements_text(params->'modes') m;
    next_key:=public.pubg_ranking_cache_key(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,private_keys,w.week_start);
    select c.updated_at,(c.payload->>'finalized')::boolean as finalized into current_row
    from public.pubg_response_cache c where c.cache_key=next_key;
    if found and current_row.updated_at>'-infinity'::timestamptz
      and (coalesce(current_row.finalized,false) or clock_timestamp()<w.finalize_at) then continue; end if;
    if not pg_try_advisory_xact_lock(hashtextextended(next_key,0)) then continue; end if;
    if public.pubg_ranking_build(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,
      private_keys,target.requested_at) is null then continue; end if;
    if public.pubg_ranking_private_keys() is distinct from private_keys then raise exception 'Ranking privacy changed during refresh'; end if;
    return 1;
  end loop;
  return 0;
end $$;

create or replace function public.queue_pubg_ranking_refresh(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer
) returns void language plpgsql volatile security invoker set search_path='' as $$
declare modes text[];
begin
  if p_tab is null or p_tab not in ('damage','kills','tier')
    or p_match_type is null or p_match_type not in ('all','official','competitive')
    or p_modes is null or cardinality(p_modes)=0 or array_position(p_modes,null) is not null
    or not p_modes <@ array['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp']::text[]
    or p_calculation is null or p_filter is null or p_population is null or p_result is null
  then raise exception 'Invalid ranking query'; end if;
  select array_agg(distinct mode order by mode) into modes from unnest(p_modes) mode;
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  values(
    public.pubg_ranking_cache_key(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,public.pubg_ranking_private_keys(),(select week_start from public.pubg_ranking_week())),
    jsonb_build_object('entries','[]'::jsonb,'requested_at',clock_timestamp(),
      'params',jsonb_build_object('tab',p_tab,'modes',modes,'match_type',p_match_type,'calculation',p_calculation,
        'filter',p_filter,'population',p_population,'result',p_result)),
    clock_timestamp()-interval '1 second','-infinity')
  -- 이미 저장 결과가 있으면 조회 시각만 갱신한다.
  on conflict (cache_key) do update set payload=jsonb_set(public.pubg_response_cache.payload,'{requested_at}',to_jsonb(clock_timestamp()));
end $$;

revoke all on function public.pubg_ranking_week() from public,anon,authenticated;
revoke all on function public.pubg_ranking_cache_key(text,text[],text,integer,integer,integer,integer,text[],timestamptz) from public,anon,authenticated;
revoke all on function public.pubg_ranking_build(text,text[],text,integer,integer,integer,integer,text[],timestamptz) from public,anon,authenticated;
revoke all on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.refresh_pubg_rankings_cache() from public,anon,authenticated;
revoke all on function public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.pubg_ranking_week() to service_role;
grant execute on function public.pubg_ranking_cache_key(text,text[],text,integer,integer,integer,integer,text[],timestamptz) to service_role;
grant execute on function public.pubg_ranking_build(text,text[],text,integer,integer,integer,integer,text[],timestamptz) to service_role;
grant execute on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) to service_role;
grant execute on function public.refresh_pubg_rankings_cache() to service_role;
grant execute on function public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer) to service_role;

-- 최근 7일 결과(v1)는 더 이상 쓰지 않는다.
delete from public.pubg_response_cache where cache_key like 'rankings:v1:%';
select cron.schedule('bgms-pubg-rankings-refresh','30 seconds','select public.refresh_pubg_rankings_cache();');
