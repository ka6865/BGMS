-- 처음 보는 무거운 조합은 요청 집계가 8초 제한을 넘겨 롤백되므로 저장 결과가 생기지 않는다.
-- 앱이 실패한 조합을 등록하면 예약 집계(refresh_pubg_rankings_cache)가 시간 제한 없이 채운다.
-- 등록 행은 이미 만료된 빈 결과라 요청에 그대로 내보내지 않는다.
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
    public.pubg_ranking_cache_key(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,public.pubg_ranking_private_keys()),
    jsonb_build_object('entries','[]'::jsonb,'requested_at',clock_timestamp(),
      'params',jsonb_build_object('tab',p_tab,'modes',modes,'match_type',p_match_type,'calculation',p_calculation,
        'filter',p_filter,'population',p_population,'result',p_result)),
    clock_timestamp()-interval '1 second','-infinity')
  -- 이미 저장 결과가 있으면 조회 시각만 갱신한다.
  on conflict (cache_key) do update set payload=jsonb_set(public.pubg_response_cache.payload,'{requested_at}',to_jsonb(clock_timestamp()));
end $$;
revoke all on function public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer) to service_role;
