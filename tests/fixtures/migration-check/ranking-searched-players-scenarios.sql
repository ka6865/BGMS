-- 일회용 PostgreSQL에서만 실행한다. 검색 이력과 수집 출처는 서로 다른 조건이다.
begin;
insert into public.system_settings(key,value) values('private_players_list','[]')
on conflict(key) do update set value=excluded.value;
delete from public.pubg_response_cache where cache_key like 'rankings:%';

insert into public.pubg_player_cache(id,platform,nickname,lower_nickname,search_count,last_seen_at)
select 'account.searched'||n,'steam','searched-'||n,'searched-'||n,1,now()-interval '1 year'
from generate_series(1,32)n;
insert into public.pubg_player_cache(id,platform,nickname,lower_nickname,search_count,last_seen_at) values
('account.scraperonly','steam','scraper-only','scraper-only',0,now()),
('account.nullsearch','steam','null-search','null-search',null,now()),
('account.renamedsearched','steam','new-searched-name','new-searched-name',1,null),
('account.legacysearched','steam','Legacy-Searched','legacy-searched',1,null),
('account.reusedname','steam','reused-name','reused-name',1,null),
('account.crossplatform','kakao','cross-platform','cross-platform',1,null),
('account.searchedscraper','steam','searched-scraper','searched-scraper',1,null);
insert into public.pubg_player_matches(player_id,platform,account_id,match_id,played_at,game_mode,map_name,kills,damage,match_type,ranking_eligible)
select 'searched-'||n,'steam','account.searched'||n,'searched-match-'||n,
  (select week_start from public.pubg_ranking_week())+interval '2 days','squad','Baltic_Main',n,1000+n,'official',true
from generate_series(1,32)n;
insert into public.pubg_player_matches(player_id,platform,account_id,match_id,played_at,game_mode,map_name,kills,damage,match_type,ranking_eligible)
select nickname,'steam',account_id,'searched-case-'||nickname,
  (select week_start from public.pubg_ranking_week())+interval '2 days','squad','Baltic_Main',kills,damage,'official',true
from (values
 ('scraper-only','account.scraperonly',99,9999),
 ('null-search','account.nullsearch',98,9998),
 ('no-cache','account.nocache',97,9997),
 ('reused-name','account.unsearchedowner',96,9996),
 ('cross-platform','account.crossplatform',95,9995),
 ('old-searched-name','account.renamedsearched',35,1500),
 ('LEGACY-SEARCHED',null,34,1400),
 ('searched-scraper','account.searchedscraper',36,1600)
) fixtures(nickname,account_id,kills,damage);
insert into public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,score,source,filter_version,population_evidence_version,calculation_version)
select match_id,platform,player_id,game_mode,match_type,'A',
  case when player_id in ('scraper-only','null-search','no-cache','reused-name','cross-platform') then 99
    when player_id='searched-scraper' then 90 else 60 end,
  case when player_id in ('scraper-only','searched-scraper') then 'scraper' else 'user' end,8,1,5
from public.pubg_player_matches where match_id like 'searched-%';

do $$ declare tab text; rows jsonb; old_key text; new_key text; a jsonb; w record;
begin
  select * into w from public.pubg_ranking_week();
  foreach tab in array array['damage','kills','tier'] loop
    select jsonb_agg(to_jsonb(r)) into rows from public.get_pubg_rankings(tab,array['squad'],'all',5,8,1,73,'{}',w.week_start,w.week_end) r;
    if jsonb_array_length(rows)<>30 or rows->0->>'player_id'<>'searched-scraper'
      or exists(select 1 from jsonb_array_elements(rows) r where r->>'player_id' in ('scraper-only','null-search','no-cache','reused-name','cross-platform'))
    then raise exception 'FAIL: searched population / TOP 30 refill for %: %',tab,rows; end if;
    if not exists(select 1 from jsonb_array_elements(rows) r where r->>'player_id'='old-searched-name')
      or not exists(select 1 from jsonb_array_elements(rows) r where r->>'player_id'='LEGACY-SEARCHED')
    then raise exception 'FAIL: searched rename / case-insensitive legacy identity for %',tab; end if;
  end loop;
  if exists(select 1 from public.get_pubg_rankings('damage',array['squad'],'all',5,8,1,73,array['steam:account:account.searchedscraper'],w.week_start,w.week_end)
    where player_id='searched-scraper') then raise exception 'FAIL: searched account privacy'; end if;

  -- 기준 전환 전의 확정 캐시가 있어도 새 키로 등록하며 이전 결과를 공개하지 않는다.
  old_key:='rankings:v2:'||md5(jsonb_build_array('damage',array['squad'],'all',5,8,1,73,array[]::text[],w.week_start)::text);
  new_key:=public.pubg_ranking_cache_key('damage',array['squad'],'all',5,8,1,73,'{}',w.week_start);
  if new_key=old_key then raise exception 'FAIL: searched population missing from cache key'; end if;
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  values(old_key,jsonb_build_object('entries',jsonb_build_array(jsonb_build_object('player_id','scraper-only')),
    'finalized',true,'requested_at',clock_timestamp(),
    'params',jsonb_build_object('tab','damage','modes',array['squad'],'match_type','all','calculation',5,'filter',8,'population',1,'result',73)),
    clock_timestamp()+interval '1 day',clock_timestamp());
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',5,8,1,73);
  if not (a->>'pending')::boolean or a->'entries'<>'[]'::jsonb then raise exception 'FAIL: reused old population cache'; end if;
  perform public.refresh_pubg_rankings_cache(); while public.refresh_pubg_rankings_cache()>0 loop end loop;
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',5,8,1,73);
  if not (a->>'cache_hit')::boolean or jsonb_array_length(a->'entries')<>30 or a->'entries'->0->>'player_id'<>'searched-scraper'
  then raise exception 'FAIL: queued searched ranking not filled'; end if;

  -- 확정본은 이후 첫 검색으로 재집계하지 않는다. 참가 자격 상실은 캐시에서도 숨긴다.
  update public.pubg_response_cache set payload=jsonb_set(payload,'{finalized}','true') where cache_key=new_key;
  update public.pubg_player_cache set search_count=1 where id='account.scraperonly';
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',5,8,1,73);
  if not (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'searched-scraper' or public.refresh_pubg_rankings_cache()<>0
  then raise exception 'FAIL: finalized ranking changed after first search'; end if;
  update public.pubg_player_cache set search_count=0 where id='account.searchedscraper';
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',5,8,1,73);
  if not (a->>'pending')::boolean or a->'entries'<>'[]'::jsonb then raise exception 'FAIL: cached unsearched winner exposed'; end if;
  perform public.refresh_pubg_rankings_cache(); while public.refresh_pubg_rankings_cache()>0 loop end loop;
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',5,8,1,73);
  if jsonb_array_length(a->'entries')<>30 or a->'entries'->0->>'player_id'<>'scraper-only'
  then raise exception 'FAIL: invalid searched cache not refilled'; end if;
  raise notice 'PASS: searched population, identity, source independence, TOP 30 refill, cache transition and finalization';
end $$;
rollback;
