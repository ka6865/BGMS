-- 처음 보는 필터 조합이 요청 안에서 지난주 전체를 집계하다 8초 제한에 걸려 실패했다(503).
-- 요청은 더 이상 집계하지 않는다. 결과가 없으면 대기열에 올리고 바로 "준비 중"으로 응답한다.
-- 예약 작업은 실제로 조회된 버전 조합마다 108개(탭 3 x 모드 12 x 경기 종류 3)를 모두 채운다.

-- 화면 필터(모드 4 x 시점 3)가 만드는 모드 배열. 요청 경로와 같은 정렬(가나다순)이다.
create or replace function public.pubg_ranking_mode_sets()
returns setof text[] language sql immutable set search_path='' as $$
  values (array['duo','duo-fpp','solo','solo-fpp','squad','squad-fpp']),(array['duo-fpp','solo-fpp','squad-fpp']),(array['duo','solo','squad']),
    (array['squad','squad-fpp']),(array['squad-fpp']),(array['squad']),
    (array['duo','duo-fpp']),(array['duo-fpp']),(array['duo']),
    (array['solo','solo-fpp']),(array['solo-fpp']),(array['solo']);
$$;

-- 등록 행은 이미 만료된 빈 결과라 요청에 내보내지 않는다. 이미 있으면 그대로 둔다.
create or replace function public.queue_pubg_ranking_refresh(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer
) returns void language plpgsql volatile security invoker set search_path='' as $$
declare modes text[]; ranking_key text;
begin
  if p_tab is null or p_tab not in ('damage','kills','tier')
    or p_match_type is null or p_match_type not in ('all','official','competitive')
    or p_modes is null or cardinality(p_modes)=0 or array_position(p_modes,null) is not null
    or not p_modes <@ array['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp']::text[]
    or p_calculation is null or p_filter is null or p_population is null or p_result is null
  then raise exception 'Invalid ranking query'; end if;
  select array_agg(distinct mode order by mode) into modes from unnest(p_modes) mode;
  ranking_key:=public.pubg_ranking_cache_key(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,
    public.pubg_ranking_private_keys(),(select week_start from public.pubg_ranking_week()));
  -- 예약 작업이 이 조합을 집계 중이면 기다리지 않는다(요청의 8초 잠금 제한 보호).
  if not pg_try_advisory_xact_lock(hashtextextended(ranking_key,0)) then return; end if;
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  values(ranking_key,
    jsonb_build_object('entries','[]'::jsonb,'requested_at',clock_timestamp(),
      'params',jsonb_build_object('tab',p_tab,'modes',modes,'match_type',p_match_type,'calculation',p_calculation,
        'filter',p_filter,'population',p_population,'result',p_result)),
    clock_timestamp()-interval '1 second','-infinity')
  on conflict (cache_key) do nothing;
end $$;

create or replace function public.get_pubg_rankings_cached(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer
) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  private_keys text[]; modes text[]; ranking_key text; cached jsonb; w record;
  started_at timestamptz:=clock_timestamp();
begin
  if p_tab is null or p_tab not in ('damage','kills','tier')
    or p_match_type is null or p_match_type not in ('all','official','competitive')
    or p_modes is null or cardinality(p_modes)=0 or array_position(p_modes,null) is not null
    or not p_modes <@ array['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp']::text[]
    or p_calculation is null or p_filter is null or p_population is null or p_result is null
  then raise exception 'Invalid ranking query'; end if;
  select array_agg(distinct mode order by mode) into modes from unnest(p_modes) mode;
  select * into w from public.pubg_ranking_week();
  private_keys:=public.pubg_ranking_private_keys();
  ranking_key:=public.pubg_ranking_cache_key(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,private_keys,w.week_start);
  select payload into cached from public.pubg_response_cache c
  where c.cache_key=ranking_key and c.expires_at>clock_timestamp() and c.updated_at>'-infinity'::timestamptz;
  if cached is not null then
    if public.pubg_ranking_private_keys() is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
    if public.pubg_ranking_cached_entries_public(cached->'entries',private_keys) then
      perform public.pubg_ranking_mark_requested(ranking_key,cached);
      return (cached-'params'-'requested_at')||jsonb_build_object('cache_hit',true,'pending',false,
        'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',0);
    end if;
    -- 저장 후 비공개 대상이 연결됐다. 보여 주지 않고 다시 집계하도록 표시한다.
    update public.pubg_response_cache c set updated_at='-infinity', expires_at=clock_timestamp()-interval '1 second'
    where c.cache_key=(select k.cache_key from public.pubg_response_cache k where k.cache_key=ranking_key for update skip locked);
  end if;
  perform public.queue_pubg_ranking_refresh(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result);
  return jsonb_build_object('entries','[]'::jsonb,'pending',true,'cache_hit',false,'generated_at',null,
    'week_start',w.week_start,'week_end',w.week_end,'finalized',false,
    'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',0);
end $$;

-- 10초마다 한 조합만 집계한다(조합마다 짧은 트랜잭션). 순서: 등록 행, 확정이 필요한 잠정 행,
-- 지난 2주 안에 조회됐지만 이번 주 결과가 없는 조합. 먼저 실제로 조회된 버전마다 108개 조합을 등록한다.
create or replace function public.refresh_pubg_rankings_cache()
returns integer language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  target record; private_keys text[]; params jsonb; modes text[]; next_key text; w record; current_row record;
begin
  if not pg_try_advisory_xact_lock(20261014150000) then return 0; end if;
  select * into w from public.pubg_ranking_week();
  private_keys:=public.pubg_ranking_private_keys();
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  select public.pubg_ranking_cache_key(t.tab,m.modes,mt.match_type,v.calculation,v.filter,v.population,v.result,private_keys,w.week_start),
    -- 미리 채운 행은 실제 조회가 아니므로 조회 시각을 남기지 않는다.
    jsonb_build_object('entries','[]'::jsonb,'requested_at','-infinity'::timestamptz,
      'params',jsonb_build_object('tab',t.tab,'modes',m.modes,'match_type',mt.match_type,'calculation',v.calculation,
        'filter',v.filter,'population',v.population,'result',v.result)),
    clock_timestamp()-interval '1 second','-infinity'
  from (select distinct (c.payload->'params'->>'calculation')::integer as calculation,(c.payload->'params'->>'filter')::integer as filter,
      (c.payload->'params'->>'population')::integer as population,(c.payload->'params'->>'result')::integer as result
    from public.pubg_response_cache c
    where c.cache_key like 'rankings:v2:%' and c.payload ? 'params'
      and (c.payload->>'requested_at')::timestamptz>clock_timestamp()-interval '14 days') v
  cross join (values ('damage'),('kills'),('tier')) t(tab)
  cross join public.pubg_ranking_mode_sets() m(modes)
  cross join (values ('all'),('official'),('competitive')) mt(match_type)
  on conflict (cache_key) do nothing;
  for target in
    select c.cache_key,c.payload->'params' as params,(c.payload->>'requested_at')::timestamptz as requested_at
    from public.pubg_response_cache c
    where c.cache_key like 'rankings:v2:%' and c.payload ? 'params'
      and (c.updated_at='-infinity'::timestamptz
        or c.payload->>'week_start'=to_jsonb(w.week_start)#>>'{}'
        or (c.payload->>'requested_at')::timestamptz>clock_timestamp()-interval '14 days')
    order by c.updated_at
  loop
    params:=target.params;
    select array_agg(m order by m) into modes from jsonb_array_elements_text(params->'modes') m;
    next_key:=public.pubg_ranking_cache_key(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,private_keys,w.week_start);
    select c.updated_at,c.expires_at,(c.payload->>'finalized')::boolean as finalized into current_row
    from public.pubg_response_cache c where c.cache_key=next_key;
    if found and current_row.updated_at>'-infinity'::timestamptz and current_row.expires_at>clock_timestamp()
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

revoke all on function public.pubg_ranking_mode_sets() from public,anon,authenticated;
revoke all on function public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.refresh_pubg_rankings_cache() from public,anon,authenticated;
grant execute on function public.pubg_ranking_mode_sets() to service_role;
grant execute on function public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer) to service_role;
grant execute on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) to service_role;
grant execute on function public.refresh_pubg_rankings_cache() to service_role;

select cron.schedule('bgms-pubg-rankings-refresh','10 seconds','select public.refresh_pubg_rankings_cache();');
