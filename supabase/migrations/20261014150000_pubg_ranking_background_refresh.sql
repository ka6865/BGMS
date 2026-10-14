-- 랭킹 집계를 방문 요청에서 분리한다.
-- 요청은 저장된 결과를 읽고, pg_cron 이 최근 조회된 조합만 10초마다 한 개씩 다시 집계한다.
-- 예약 작업이 멈추면 저장 결과가 20분 뒤 만료되어 기존처럼 요청 시 집계로 돌아간다.

create or replace function public.pubg_ranking_cache_key(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_private_keys text[]
) returns text language sql immutable set search_path='' as $$
  select 'rankings:v1:'||md5(jsonb_build_array(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys)::text);
$$;

-- 집계하고 공개 대상만 담긴 경우에만 저장한다. 비공개 대상이 섞이면 null 을 돌려준다.
create or replace function public.pubg_ranking_build(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,
  p_private_keys text[],p_requested_at timestamptz
) returns jsonb language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  entries jsonb; generated_at timestamptz; cache_expires_at timestamptz; cached jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(r)-'ordinality' order by ordinality),'[]'::jsonb) into entries
  from public.get_pubg_rankings(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys) with ordinality r;
  if not public.pubg_ranking_cached_entries_public(entries,p_private_keys) then return null; end if;
  generated_at:=clock_timestamp();
  -- 상위 경기가 7일 범위를 벗어나는 시각이 더 빠르면 그때 만료한다.
  select least(generated_at+interval '20 minutes',coalesce(min(e.played_at)+interval '7 days',generated_at+interval '20 minutes'))
    into cache_expires_at from jsonb_to_recordset(entries) e(played_at timestamptz);
  cached:=jsonb_build_object('entries',entries,'generated_at',generated_at,'requested_at',p_requested_at,
    'params',jsonb_build_object('tab',p_tab,'modes',p_modes,'match_type',p_match_type,'calculation',p_calculation,
      'filter',p_filter,'population',p_population,'result',p_result));
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  values(public.pubg_ranking_cache_key(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys),
    cached,cache_expires_at,generated_at)
  on conflict (cache_key) do update set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at;
  return cached;
end $$;

-- 조회 시각은 5분에 한 번만 기록하고, 예약 집계가 잡은 행은 기다리지 않고 건너뛴다.
create or replace function public.pubg_ranking_mark_requested(p_key text,p_cached jsonb)
returns void language plpgsql volatile security invoker set search_path='' as $$
begin
  if coalesce((p_cached->>'requested_at')::timestamptz,'-infinity')<clock_timestamp()-interval '5 minutes' then
    update public.pubg_response_cache c set payload=jsonb_set(c.payload,'{requested_at}',to_jsonb(clock_timestamp()))
    where c.cache_key=(select k.cache_key from public.pubg_response_cache k where k.cache_key=p_key for update skip locked);
  end if;
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
  ranking_key:=public.pubg_ranking_cache_key(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,private_keys);
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

-- 최근 6시간 안에 조회된 조합 중 4분 이상 지난 것 하나를 다시 집계한다. 다시 집계한 개수(0 또는 1)를 돌려준다.
create or replace function public.refresh_pubg_rankings_cache()
returns integer language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  target record; private_keys text[]; params jsonb; modes text[]; next_key text;
begin
  -- 이전 실행이 아직 끝나지 않았으면 겹쳐 돌지 않는다.
  if not pg_try_advisory_xact_lock(20261014150000) then return 0; end if;
  private_keys:=public.pubg_ranking_private_keys();
  for target in
    select c.cache_key,c.payload->'params' as params,(c.payload->>'requested_at')::timestamptz as requested_at
    from public.pubg_response_cache c
    where c.cache_key like 'rankings:v1:%' and c.payload ? 'params' and c.payload ? 'requested_at'
      and (c.payload->>'requested_at')::timestamptz>clock_timestamp()-interval '6 hours'
      and c.updated_at<clock_timestamp()-interval '4 minutes'
    order by c.updated_at
  loop
    params:=target.params;
    select array_agg(m order by m) into modes from jsonb_array_elements_text(params->'modes') m;
    next_key:=public.pubg_ranking_cache_key(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,private_keys);
    -- 같은 조합을 요청 경로가 집계 중이면 기다리지 않고 다음 조합으로 넘어간다.
    if not pg_try_advisory_xact_lock(hashtextextended(next_key,0)) then continue; end if;
    if public.pubg_ranking_build(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,
      private_keys,target.requested_at) is null then continue; end if;
    if public.pubg_ranking_private_keys() is distinct from private_keys then raise exception 'Ranking privacy changed during refresh'; end if;
    -- 비공개 목록이 바뀌어 키가 달라졌으면 이전 키는 더 이상 조회되지 않으므로 지운다.
    if next_key<>target.cache_key then
      delete from public.pubg_response_cache where cache_key=target.cache_key;
    end if;
    return 1;
  end loop;
  return 0;
end $$;

revoke all on function public.pubg_ranking_cache_key(text,text[],text,integer,integer,integer,integer,text[]) from public,anon,authenticated;
revoke all on function public.pubg_ranking_build(text,text[],text,integer,integer,integer,integer,text[],timestamptz) from public,anon,authenticated;
revoke all on function public.pubg_ranking_mark_requested(text,jsonb) from public,anon,authenticated;
revoke all on function public.refresh_pubg_rankings_cache() from public,anon,authenticated;
revoke all on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.pubg_ranking_cache_key(text,text[],text,integer,integer,integer,integer,text[]) to service_role;
grant execute on function public.pubg_ranking_build(text,text[],text,integer,integer,integer,integer,text[],timestamptz) to service_role;
grant execute on function public.pubg_ranking_mark_requested(text,jsonb) to service_role;
grant execute on function public.refresh_pubg_rankings_cache() to service_role;
grant execute on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) to service_role;

-- 10초 주기 작업은 실행 기록이 하루 8,640행 쌓이므로 하루치만 남긴다. 기존 수집 기록 정리는 그대로 둔다.
create or replace function bgms_private.cleanup_pubg_collection_clock_logs()
returns void language sql security invoker set search_path = '' as $$
  delete from bgms_private.pubg_collection_requests where dispatched_at < now() - interval '7 days';
  delete from cron.job_run_details where jobid in (
    select jobid from cron.job where jobname in ('bgms-pubg-collection','bgms-pubg-collection-log-cleanup')
  ) and end_time < now() - interval '7 days';
  delete from cron.job_run_details where jobid in (
    select jobid from cron.job where jobname = 'bgms-pubg-rankings-refresh'
  ) and end_time < now() - interval '1 day';
$$;
revoke all on function bgms_private.cleanup_pubg_collection_clock_logs() from public,anon,authenticated,service_role;

select cron.schedule('bgms-pubg-rankings-refresh','10 seconds','select public.refresh_pubg_rankings_cache();');
