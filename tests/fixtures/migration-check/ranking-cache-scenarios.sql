begin;
-- 요청은 집계하지 않으므로, 준비 중이면 예약 집계를 끝까지 돌린 뒤 다시 조회한다(처음 집계면 cache_hit=false).
create function pg_temp.rank(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer)
returns jsonb language plpgsql as $$
declare a jsonb;
begin
  a:=public.get_pubg_rankings_cached(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result);
  if not coalesce((a->>'pending')::boolean,false) then return a; end if;
  perform public.refresh_pubg_rankings_cache(); while public.refresh_pubg_rankings_cache()>0 loop end loop;
  a:=public.get_pubg_rankings_cached(p_tab,p_modes,p_match_type,p_calculation,p_filter,p_population,p_result);
  return case when coalesce((a->>'pending')::boolean,false) then a else a||jsonb_build_object('cache_hit',false) end;
end $$;
insert into public.system_settings(key,value) values('private_players_list','[]')
on conflict(key) do update set value=excluded.value;
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
select 'cache-player-'||n,'steam','cache-match-'||n,(select week_start from public.pubg_ranking_week())+interval '1 day','solo','Baltic_Main',n,1000+n,1,'official','account.cache'||n,true from generate_series(1,32)n;
do $$ declare a jsonb;b jsonb; begin
 a:=pg_temp.rank('damage',array['solo'],'all',3,8,1,73);
 b:=pg_temp.rank('damage',array['solo','solo'],'all',3,8,1,73);
 if (a->>'cache_hit')::boolean or not(b->>'cache_hit')::boolean
   or a->'entries' is distinct from b->'entries' or a->'generated_at' is distinct from b->'generated_at'
   or jsonb_array_length(a->'entries')<>30 then raise exception 'Cache reuse/order/time failed';end if;
 -- 같은 버전의 다른 탭은 미리 채워져 있지만 값은 탭별로 따로 집계한다. 다른 계산 버전은 섞지 않는다.
 if (pg_temp.rank('kills',array['solo'],'all',3,8,1,73)->'entries'->0->>'value')::numeric<>32
   or (pg_temp.rank('damage',array['solo'],'all',2,8,1,73)->>'cache_hit')::boolean
 then raise exception 'Cache query/version separation failed';end if;
end $$;
-- 관리자·고객문의가 공통 설정을 갱신한 직후에도 이전 캐시는 사용하지 않는다.
update public.system_settings set value='[{"platform":"all","nickname":"cache-player-32","account_id":"account.cache32"}]' where key='private_players_list';
do $$ declare a jsonb; begin
 a:=pg_temp.rank('damage',array['solo'],'all',3,8,1,73);
 if (a->>'cache_hit')::boolean or jsonb_array_length(a->'entries')<>30
   or a->'entries'->0->>'player_id'<>'cache-player-31'
 then raise exception 'Immediate privacy exclusion/refill failed';end if;
end $$;
update public.system_settings set value='[]' where key='private_players_list';
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,match_type,account_id,ranking_eligible)
values('MiXeD-Privacy','steam','mixed-privacy-match',(select week_start from public.pubg_ranking_week())+interval '1 day','duo','Baltic_Main',10,2000,'official',null,true);
update public.system_settings set value='[{"platform":"steam","nickname":"MIXED-PRIVACY"}]' where key='private_players_list';
do $$ begin
 if pg_temp.rank('damage',array['duo'],'all',3,8,1,73)->'entries'<>'[]'::jsonb
 then raise exception 'Case-insensitive private nickname exclusion failed';end if;
end $$;
do $$ begin
 if pg_temp.rank('damage',array['solo'],'all',3,8,1,73)->'entries'->0->>'player_id'<>'cache-player-32'
 then raise exception 'Immediate public restore failed';end if;
end $$;
-- Legacy winner becomes private through an identity link while the privacy list stays unchanged.
update public.pubg_player_matches set account_id=null where player_id='cache-player-32';
update public.system_settings set value='[{"platform":"steam","nickname":"other-private-name","account_id":"account.hidden-cache"}]' where key='private_players_list';
select pg_temp.rank('damage',array['solo'],'all',3,8,1,73) is not null;
insert into public.pubg_player_cache(id,platform,nickname,lower_nickname,updated_at,last_seen_at,search_count)
values('account.hidden-cache','steam','cache-player-32','cache-player-32',now(),now(),1);
do $$ declare a jsonb;begin
 a:=pg_temp.rank('damage',array['solo'],'all',3,8,1,73);
 if (a->>'cache_hit')::boolean or jsonb_array_length(a->'entries')<>30
   or a->'entries'->0->>'player_id'<>'cache-player-31'
 then raise exception 'Current cache identity privacy guard failed';end if;
end $$;
delete from public.pubg_player_cache where id='account.hidden-cache';
update public.pubg_response_cache set expires_at=clock_timestamp()-interval '1 second' where cache_key like 'rankings:v2:%';
select pg_temp.rank('damage',array['solo'],'all',3,8,1,73) is not null;
insert into public.pubg_player_match_discovery(platform,account_id,match_id,nickname_at_discovery,state)
values('steam','account.hidden-cache','cache-match-32','other-private-name','saved');
do $$ declare a jsonb;begin
 a:=pg_temp.rank('damage',array['solo'],'all',3,8,1,73);
 if (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'cache-player-31'
 then raise exception 'Current discovery privacy guard failed';end if;
end $$;
delete from public.pubg_player_match_discovery where match_id='cache-match-32';
update public.pubg_response_cache set expires_at=clock_timestamp()-interval '1 second' where cache_key like 'rankings:v2:%';
select pg_temp.rank('damage',array['solo'],'all',3,8,1,73) is not null;
update public.pubg_player_matches set account_id='account.hidden-cache' where player_id='cache-player-32';
do $$ declare a jsonb;begin
 a:=pg_temp.rank('damage',array['solo'],'all',3,8,1,73);
 if (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'cache-player-31'
 then raise exception 'Current match account binding privacy guard failed';end if;
end $$;
update public.system_settings set value='[]' where key='private_players_list';
update public.pubg_response_cache set expires_at=clock_timestamp()-interval '1 second' where cache_key like 'rankings:v2:%';
do $$ begin
 if (pg_temp.rank('damage',array['solo'],'all',3,8,1,73)->>'cache_hit')::boolean
 then raise exception 'Expired cache reused';end if;
end $$;
update public.system_settings set value='{"invalid":true}' where key='private_players_list';
do $$ begin
 begin
  perform pg_temp.rank('damage',array['solo'],'all',3,8,1,73);
  raise exception 'Privacy corruption was accepted';
 exception when others then
  if sqlerrm not like '%Invalid ranking privacy%' then raise;end if;
 end;
end $$;
do $$ begin
 if has_function_privilege('anon','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
   or has_function_privilege('authenticated','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
   or not has_function_privilege('service_role','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
 then raise exception 'Ranking cache ACL failed';end if;
 raise notice 'PASS: shared rankings cache, privacy/refill/identity guards, TTL and service ACL';
end $$;
rollback;
