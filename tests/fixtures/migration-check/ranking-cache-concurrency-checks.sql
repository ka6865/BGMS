do $$ begin
 if exists(select 1 from public.pubg_response_cache where cache_key like 'rankings:v2:%' and updated_at>'-infinity'::timestamptz) then raise exception 'Privacy-raced refresh saved stale cache';end if;
 if public.get_pubg_rankings_cached('damage',array['solo'],'all',3,8,1,73)->'entries'<>'[]'::jsonb then raise exception 'Privacy-raced winner returned on retry';end if;
 raise notice 'PASS: concurrent requests queue once and concurrent refreshes aggregate once';
 raise notice 'PASS: privacy changes committed during aggregation fail closed without cache writes';
end $$;
drop function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz);
alter function public.get_pubg_rankings_before_concurrency_test(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) rename to get_pubg_rankings;
drop table public.ranking_cache_test_calls;
delete from public.pubg_player_matches where match_id='concurrent-ranking-match';
delete from public.pubg_response_cache where cache_key like 'rankings:v2:%';
update public.system_settings set value='[]' where key='private_players_list';
