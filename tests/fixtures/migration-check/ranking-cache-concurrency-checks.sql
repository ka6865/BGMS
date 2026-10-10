do $$ begin
 if (select count(*) from public.ranking_cache_test_calls)<>1 then raise exception 'Concurrent cache misses aggregated more than once';end if;
 if exists(select 1 from public.pubg_response_cache where cache_key like 'rankings:v1:%') then raise exception 'Privacy-raced query saved stale cache';end if;
 if public.get_pubg_rankings_cached('damage',array['solo'],'all',3,8,1,73)->'entries'<>'[]'::jsonb then raise exception 'Privacy-raced winner returned on retry';end if;
 raise notice 'PASS: separate service-role connections share one ranking aggregation';
 raise notice 'PASS: privacy changes committed during aggregation fail closed without cache writes';
end $$;
drop function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]);
alter function public.get_pubg_rankings_before_concurrency_test(text,text[],text,integer,integer,integer,integer,text[]) rename to get_pubg_rankings;
drop table public.ranking_cache_test_calls;
delete from public.pubg_player_matches where match_id='concurrent-ranking-match';
delete from public.pubg_response_cache where cache_key like 'rankings:v1:%';
update public.system_settings set value='[]' where key='private_players_list';
