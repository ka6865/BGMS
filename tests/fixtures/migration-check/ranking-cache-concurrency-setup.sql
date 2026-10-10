-- 일회용 migration 검증 DB에서만 실행한다. 실제 집계를 지연시켜 독립 연결의 경합을 검사한다.
insert into public.system_settings(key,value) values('private_players_list','[]') on conflict(key) do update set value=excluded.value;
delete from public.pubg_response_cache where cache_key like 'rankings:v1:%';
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,match_type,account_id,ranking_eligible)
values('concurrent-ranking','steam','concurrent-ranking-match',now(),'solo','Baltic_Main',5,1000,'official','account.concurrentranking',true);
create table public.ranking_cache_test_calls(id integer);
grant all on public.ranking_cache_test_calls to service_role;
alter function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) rename to get_pubg_rankings_before_concurrency_test;
create function public.get_pubg_rankings(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_excluded text[] default '{}')
returns table(platform text,player_id text,account_id text,value double precision,secondary double precision,tier text,game_mode text,map_name text,played_at timestamptz,match_count bigint)
language plpgsql volatile security invoker set search_path='' as $$
begin
 insert into public.ranking_cache_test_calls values(1);
 perform pg_advisory_xact_lock(20261010041817);
 perform pg_sleep(1);
 return query select * from public.get_pubg_rankings_before_concurrency_test(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result,p_excluded);
end $$;
revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) to service_role;
