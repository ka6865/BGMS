-- 검색 이력 계정만 TOP 30 선정에 참가한다. 원본 경기·점수·수집 표본은 보존한다.
-- 이미 알려진 계정 ID가 다르면 닉네임으로 우회하지 않는다.
do $migration$
declare definition text; updated_definition text;
begin
  select pg_get_functiondef('public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz)'::regprocedure)
  into definition;
  updated_definition:=replace(definition,
    $old$and m.platform in ('steam','kakao') and m.game_mode=any(p_modes)$old$,
    $new$and m.platform in ('steam','kakao') and m.game_mode=any(p_modes)
      and exists (
        select 1 from public.pubg_player_cache searched
        where searched.platform=m.platform and searched.search_count>0
          and (searched.id=m.account_id
            or (m.account_id is null and searched.lower_nickname=lower(m.player_id)))
      )$new$);
  if definition=updated_definition then raise exception 'searched-rankings: unexpected ranking definition'; end if;
  execute updated_definition;

  -- 저장된 순위도 현재 검색 계정 연결을 확인한다. 삭제·계정 연결 변경 시 재집계한다.
  select pg_get_functiondef('public.pubg_ranking_cached_entries_public(jsonb,text[])'::regprocedure)
  into definition;
  updated_definition:=replace(definition,
    $old$or not exists (select 1 from public.pubg_player_matches m$old$,
    $new$or not exists (
        select 1 from public.pubg_player_cache searched
        where searched.platform=e.platform and searched.search_count>0
          and (searched.id=e.account_id
            or (e.account_id is null and searched.lower_nickname=lower(e.player_id)))
      )
      or not exists (select 1 from public.pubg_player_matches m$new$);
  if definition=updated_definition then raise exception 'searched-rankings: unexpected cache guard definition'; end if;
  execute updated_definition;
end $migration$;

-- 접두사는 예약 처리와 공유한다. 참가 기준 버전만 바꿔 이전 확정본을 재사용하지 않는다.
create or replace function public.pubg_ranking_cache_key(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_private_keys text[],p_week_start timestamptz
) returns text language sql immutable set search_path='' as $$
  select 'rankings:v2:'||md5(jsonb_build_array('searched-players-v1',p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_private_keys,p_week_start)::text);
$$;

revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) to service_role;
revoke all on function public.pubg_ranking_cached_entries_public(jsonb,text[]) from public,anon,authenticated;
grant execute on function public.pubg_ranking_cached_entries_public(jsonb,text[]) to service_role;
