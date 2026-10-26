begin;
set local lock_timeout = '2s';

-- 계정 삭제가 현재 검색 캐시 버전(search:v11 등)의 lease도 지우도록 조건만 바꾸고 나머지 계약은 유지한다.
create or replace function public.delete_lol_account_data(p_puuid text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_riot_id text; v_riot_ids text[]; v_match_ids text[];
  v_accounts bigint; v_ranked bigint; v_history bigint; v_summaries bigint;
  v_teammates bigint; v_participants bigint; v_matches bigint; v_cache bigint; v_leases bigint;
begin
  if p_puuid is null or length(p_puuid) not between 1 and 128 then
    raise exception 'invalid PUUID' using errcode='22023';
  end if;
  select game_name || '#' || tag_line into v_riot_id from public.lol_accounts where puuid=p_puuid for update;
  select coalesce(array_agg(match_id),'{}'::text[]) into v_match_ids from public.lol_matches m
  where exists (select 1 from jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p where p->>'puuid'=p_puuid)
    or exists (select 1 from public.lol_match_participants p where p.match_id=m.match_id and p.puuid=p_puuid);
  select array_agg(distinct lower(riot_id)) into v_riot_ids from (
    select v_riot_id as riot_id
    union all
    select (p->>'riotIdGameName') || '#' || (p->>'riotIdTagline')
    from public.lol_matches m, jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p
    where m.match_id=any(v_match_ids) and p->>'puuid'=p_puuid
  ) ids where riot_id is not null;
  -- 계정·관련 경기의 수집만 취소하고 다른 계정과 운영 정리 lease는 보존한다.
  delete from public.lol_collection_leases l where l.lease_type='collection' and (
    l.lease_key='collect:' || p_puuid
    or l.lease_key=any(array(select 'match:' || id from unnest(v_match_ids) id))
    -- 검색 캐시 버전이 올라가도 해당 Riot ID의 검색 lease를 모두 취소한다.
    or (l.lease_key ~ '^search:v[0-9]+:' and substring(l.lease_key from '^search:v[0-9]+:(.*)$')=any(v_riot_ids))
  );
  get diagnostics v_leases = row_count;
  select count(*) into v_ranked from public.lol_ranked_entries where puuid=p_puuid;
  select count(*) into v_history from public.lol_ranked_history where puuid=p_puuid;
  select count(*) into v_summaries from public.lol_player_match_summaries where puuid=p_puuid;
  -- DTO 내부의 과거 이름과 동료 참조도 제거하려고 짧은 캐시는 모두 무효화한다.
  delete from public.lol_api_cache;
  get diagnostics v_cache = row_count;
  update public.lol_player_match_summaries s set teammates=(
    select coalesce(jsonb_agg(t order by n),'[]'::jsonb)
    from jsonb_array_elements(s.teammates) with ordinality x(t,n)
    where t->>'puuid' is distinct from p_puuid and not coalesce(lower(t->>'riotId')=any(v_riot_ids),false)
  ) where exists (
    select 1 from jsonb_array_elements(s.teammates) t where t->>'puuid'=p_puuid or lower(t->>'riotId')=any(v_riot_ids)
  );
  get diagnostics v_teammates = row_count;
  select count(*) into v_participants from public.lol_match_participants where match_id=any(v_match_ids);
  -- 원문의 식별자를 재사용하거나 다시 백필하지 않도록 관련 원문도 제거한다.
  delete from public.lol_matches where match_id=any(v_match_ids);
  get diagnostics v_matches = row_count;
  delete from public.lol_accounts where puuid=p_puuid;
  get diagnostics v_accounts = row_count;
  return jsonb_build_object('account_rows',v_accounts,'ranked_rows',v_ranked,'history_rows',v_history,
    'summary_rows',v_summaries,'teammate_rows',v_teammates,'participant_rows',v_participants,'match_rows',v_matches,'cache_rows',v_cache,'lease_rows',v_leases);
end;
$$;

revoke all on function public.delete_lol_account_data(text) from public, anon, authenticated;
grant execute on function public.delete_lol_account_data(text) to service_role;

commit;
