do $$
declare v_function record;
begin
  if not (select relrowsecurity from pg_catalog.pg_class where oid='public.lol_accounts'::regclass) then raise exception 'RLS is disabled'; end if;
  if has_table_privilege('anon','public.lol_accounts','select') or has_table_privilege('authenticated','public.lol_matches','select') then raise exception 'public table grant found'; end if;
  if not has_table_privilege('service_role','public.lol_accounts','select') then raise exception 'service role table grant missing'; end if;
  if has_function_privilege('anon','public.reserve_lol_riot_request(text,text,integer)','execute')
    or has_function_privilege('authenticated','public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)','execute')
    or has_function_privilege('anon','public.get_lol_match_request_json(text,text,text)','execute') then
    raise exception 'public function grant found'; end if;
  if not has_function_privilege('service_role','public.reserve_lol_riot_request(text,text,integer)','execute') then raise exception 'service role RPC grant missing'; end if;
  for v_function in select prosecdef from pg_catalog.pg_proc where pronamespace='public'::regnamespace and proname like '%lol_%' loop
    if v_function.prosecdef then raise exception 'SECURITY DEFINER LoL function found'; end if;
  end loop;
end $$;
set role service_role;
select * from public.acquire_lol_collection_lease('service-role-rpc',10) \gset service_
select public.release_lol_collection_lease('service-role-rpc',:'service_lease_token'::uuid);
reset role;

insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route)
values ('fixture-puuid-rank','RankFixture','KR1','kr','asia');
insert into public.lol_ranked_entries (puuid,platform_id,queue_type,tier,rank,league_points,wins,losses)
values ('fixture-puuid-rank','kr','RANKED_SOLO_5x5','MASTER','I',1500,100,80);
do $$ begin
  if (select league_points from public.lol_ranked_entries where puuid='fixture-puuid-rank')<>1500 then raise exception 'high LP row not retained'; end if;
end $$;

create temp table lol_fixture as
with participants as (
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'participantId',n,'puuid',case when n=10 then null else 'fixture-player-'||n end,'teamId',case when n<=5 then 100 else 200 end,
    'championId',1,'teamPosition',case when n<=5 then 'TOP' else 'UTILITY' end,'win',n<=5,
    'kills',case when n=1 then null else 3 end,'deaths',2,'assists',5,'totalMinionsKilled',120,'neutralMinionsKilled',20,
    'goldEarned',10000,'totalDamageDealtToChampions',18000,'visionScore',22,'wardsPlaced',12,'wardsKilled',3,'damageDealtToObjectives',5000,
    'item0',1001,'item1',2003,'item2',null,'item3',null,'item4',null,'item5',null,'item6',3363,
    'perks',pg_catalog.jsonb_build_object('styles',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('style',8000,'selections',pg_catalog.jsonb_build_array())),
      'statPerks',pg_catalog.jsonb_build_object('offense',5008,'flex',5008,'defense',5002)))) as players
  from pg_catalog.generate_series(1,10) n
), raw as (
  select pg_catalog.jsonb_build_object('metadata',pg_catalog.jsonb_build_object('matchId','KR_7000','dataVersion','2'),
    'info',pg_catalog.jsonb_build_object('queueId',420,'mapId',11,'gameVersion','16.21.1','gameCreation',1699999000000,
      'gameStartTimestamp',1700000000000,'gameEndTimestamp',1700001800000,'gameDuration',1800,'teams',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('teamId',100,'win',true),pg_catalog.jsonb_build_object('teamId',200,'win',false)),
      'participants',players)) as match from participants
)
select match, match->'info'->'participants' as participants from raw;

create function pg_temp.persist_lol_fixture(p_token uuid,p_name text,p_tag text,p_ranked jsonb) returns boolean
language sql as $$
  select public.persist_lol_search_snapshot('search:fixture#kr1',p_token,'search:v1:kr:asia:16.21.1:fixture:kr1',
    '{"account":{"gameName":"Fixture","tagLine":"KR1"},"profile":{"profileIconId":12,"summonerLevel":42},"ranked":[],"matches":[],"matchStatus":"ready"}'::jsonb,
    'kr','asia','16.21.1',jsonb_build_object('puuid','fixture-puuid-main','game_name',p_name,'tag_line',p_tag,'profile_icon_id',12,'summoner_level',42),
    p_ranked,
    (select jsonb_build_array(jsonb_build_object('summary',jsonb_build_object('matchId','KR_7000'),'raw',match)) from lol_fixture));
$$;

select * from public.acquire_lol_collection_lease('search:fixture#kr1',90) \gset lease_
select pg_temp.persist_lol_fixture(:'lease_lease_token','Fixture','KR1','[{"queue_type":"RANKED_SOLO_5x5","tier":"MASTER","rank":"I","league_points":1500,"wins":100,"losses":80}]'::jsonb);
do $$
begin
  if (select count(*) from public.lol_accounts where puuid='fixture-puuid-main')<>1 then raise exception 'account missing'; end if;
  if (select count(*) from public.lol_ranked_entries where puuid='fixture-puuid-main')<>1 then raise exception 'rank missing'; end if;
  if (select count(*) from public.lol_matches where match_id='KR_7000')<>1 then raise exception 'match missing'; end if;
  if (select count(*) from public.lol_match_participants where match_id='KR_7000')<>10 then raise exception 'participant rows missing'; end if;
  if (select kills from public.lol_match_participants where match_id='KR_7000' and participant_id=1) is not null then raise exception 'null metric was coerced'; end if;
  if (select jsonb_typeof(perks) from public.lol_match_participants where match_id='KR_7000' and participant_id=1)<>'object'
    or (select jsonb_typeof(perks->'styles') from public.lol_match_participants where match_id='KR_7000' and participant_id=1)<>'array'
    or (select perks->'statPerks'->>'offense' from public.lol_match_participants where match_id='KR_7000' and participant_id=1)<>'5008' then raise exception 'perks projection mismatch'; end if;
  if (select started_at from public.lol_matches where match_id='KR_7000')<>pg_catalog.to_timestamp(1700000000) then raise exception 'gameStartTimestamp precedence failed'; end if;
  if public.get_lol_api_cache('search:v1:kr:asia:16.21.1:fixture:kr1','search','kr','asia','16.21.1')->>'matchStatus'<>'ready' then raise exception 'search DTO cache miss'; end if;
  if public.get_lol_match_request_json('KR_7000','kr','asia')->'metadata'->>'matchId'<>'KR_7000' then raise exception 'persisted match payload miss'; end if;
  if public.get_lol_match_request_json('KR_7000','euw1','europe') is not null then raise exception 'match payload region scope ignored'; end if;
end $$;
create temp table lol_original_public_id as select public_id from public.lol_accounts where puuid='fixture-puuid-main';

select * from public.acquire_lol_collection_lease('search:fixture#kr1',90) \gset duplicate_
select pg_temp.persist_lol_fixture(:'duplicate_lease_token','FixtureRenamed','KR1','[{"queue_type":"RANKED_SOLO_5x5","tier":"MASTER","rank":"I","league_points":1500,"wins":100,"losses":80}]'::jsonb);
do $$
declare v_public_id uuid;
begin
  select public_id into v_public_id from public.lol_accounts where puuid='fixture-puuid-main';
  if v_public_id is distinct from (select public_id from lol_original_public_id) then raise exception 'public account id changed after Riot ID rename'; end if;
  if (select game_name from public.lol_accounts where puuid='fixture-puuid-main')<>'FixtureRenamed' then raise exception 'Riot ID rename not applied'; end if;
  if (select count(*) from public.lol_accounts where puuid='fixture-puuid-main')<>1
    or (select count(*) from public.lol_match_participants where match_id='KR_7000')<>10 then raise exception 'duplicate upsert added rows'; end if;
end $$;

select * from public.acquire_lol_collection_lease('search:fixture#kr1',90) \gset failed_refresh_
create function pg_temp.assert_failed_rank_refresh(p_token uuid) returns boolean language plpgsql as $$
declare v_raw jsonb;
begin
  select match into v_raw from lol_fixture;
  begin
    perform public.persist_lol_search_snapshot('search:fixture#kr1',p_token,'failed-refresh','{}'::jsonb,'kr','asia','16.21.1',
      '{"puuid":"fixture-puuid-main","game_name":"FixtureRenamed","tag_line":"KR1","profile_icon_id":12,"summoner_level":42}'::jsonb,
      '[]'::jsonb,pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('summary',pg_catalog.jsonb_build_object('matchId','KR_WRONG'),'raw',v_raw)));
    raise exception 'invalid refresh unexpectedly succeeded' using errcode='P0001';
  exception when sqlstate '22023' then null;
  end;
  if (select league_points from public.lol_ranked_entries where puuid='fixture-puuid-main')<>1500 then raise exception 'failed refresh erased prior rank'; end if;
  return true;
end $$;
select pg_temp.assert_failed_rank_refresh(:'failed_refresh_lease_token'::uuid);
select public.release_lol_collection_lease('search:fixture#kr1',:'failed_refresh_lease_token'::uuid);
select * from public.acquire_lol_collection_lease('search:fixture#kr1',90) \gset empty_rank_
select pg_temp.persist_lol_fixture(:'empty_rank_lease_token','FixtureRenamed','KR1','[]'::jsonb);
do $$ begin
  if exists(select 1 from public.lol_ranked_entries where puuid='fixture-puuid-main') then raise exception 'successful empty rank did not clear current entries'; end if;
  if (select ranked_checked_at from public.lol_accounts where puuid='fixture-puuid-main') is null then raise exception 'empty rank success not recorded'; end if;
end $$;

select * from public.acquire_lol_collection_lease('match:KR_7000',45) \gset details_
do $$ declare v_expire timestamptz := pg_catalog.clock_timestamp() + interval '1 day';
begin
  update public.lol_matches set fetched_at=v_expire-interval '7 days',expires_at=v_expire where match_id='KR_7000';
end $$;
create temp table lol_match_source_expiry as
select match_id,fetched_at,expires_at from public.lol_matches where match_id='KR_7000';
select public.release_lol_collection_lease('match:KR_7000',:'details_lease_token'::uuid);
select * from public.acquire_lol_collection_lease('search:fixture#kr1',90) \gset reuse_
select pg_temp.persist_lol_fixture(:'reuse_lease_token','Fixture','KR1','[{"queue_type":"RANKED_SOLO_5x5","tier":"MASTER","rank":"I","league_points":1500,"wins":100,"losses":80}]'::jsonb);
do $$ begin
  if not exists(select 1 from public.lol_matches m join lol_match_source_expiry s using(match_id)
    where m.match_id='KR_7000' and m.fetched_at=s.fetched_at and m.expires_at=s.expires_at) then
    raise exception 'reused match payload slid source TTL'; end if;
end $$;
select * from public.acquire_lol_collection_lease('match:KR_7000',45) \gset details_
select public.persist_lol_match_details('match:KR_7000',:'details_lease_token','match:v1:kr:asia:16.21.1:v3:KR_7000',
  '{"matchId":"KR_7000","queueId":420,"gameMode":"CLASSIC","gameDuration":1800,"teams":[]}'::jsonb,'kr','asia','16.21.1',
  (select match from lol_fixture),(select participants from lol_fixture),
  '[{"teamId":100,"win":true},{"teamId":200,"win":false}]'::jsonb);
do $$
begin
  if public.get_lol_api_cache('match:v1:kr:asia:16.21.1:v3:KR_7000','match_details','kr','asia','16.21.1')->>'matchId'<>'KR_7000' then raise exception 'match detail DTO cache miss'; end if;
  if (select expires_at from public.lol_api_cache where cache_key='match:v1:kr:asia:16.21.1:v3:KR_7000')
    > (select expires_at from public.lol_matches where match_id='KR_7000') then raise exception 'detail DTO outlived source match'; end if;
end $$;

do $$
declare v_now timestamptz:=pg_catalog.clock_timestamp(); v_token uuid; v_raw jsonb;
begin
  update public.lol_matches set fetched_at=v_now-interval '8 days',expires_at=v_now-interval '1 day' where match_id='KR_7000';
  select lease_token into v_token from public.acquire_lol_collection_lease('match:KR_7000',45);
  select match into v_raw from lol_fixture;
  v_raw:=pg_catalog.jsonb_set(v_raw,'{metadata,dataVersion}','"3"'::jsonb);
  perform public.persist_lol_match_details('match:KR_7000',v_token,'match:v1:kr:asia:16.21.1:v3:KR_7000',
    '{"matchId":"KR_7000","queueId":420,"gameMode":"CLASSIC","gameDuration":1800,"teams":[]}'::jsonb,
    'kr','asia','16.21.1',v_raw,v_raw->'info'->'participants','[]'::jsonb);
  if (select request_json->'metadata'->>'dataVersion' from public.lol_matches where match_id='KR_7000')<>'3'
    or (select fetched_at from public.lol_matches where match_id='KR_7000')<v_now
    or (select expires_at from public.lol_matches where match_id='KR_7000')<=v_now+interval '6 days' then
    raise exception 'expired source payload was not replaced with fresh Riot response'; end if;
end $$;

select * from public.acquire_lol_collection_lease('match:KR_7001',45) \gset rollback_
create function pg_temp.assert_lol_rollback(p_token uuid) returns boolean language plpgsql as $$
declare v_raw jsonb;
begin
  select match into v_raw from lol_fixture;
  v_raw := pg_catalog.jsonb_set(v_raw,'{metadata,matchId}','"KR_7001"'::jsonb);
  begin
    perform public.persist_lol_match_details('match:KR_7001',p_token,'match:rollback','{}'::jsonb,'kr','asia','16.21.1',v_raw,
      '[{"participantId":1,"teamId":100,"championId":1,"win":true,"kills":-1,"items":[0,0,0,0,0,0,0]}]'::jsonb,'[]'::jsonb);
    raise exception 'invalid write unexpectedly succeeded' using errcode='P0001';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.lol_matches where match_id='KR_7001') or exists(select 1 from public.lol_api_cache where cache_key='match:rollback') then
    raise exception 'failed participant write left parent/cache rows'; end if;
  return true;
end $$;
select pg_temp.assert_lol_rollback(:'rollback_lease_token'::uuid);

select * from public.acquire_lol_collection_lease('match:KR_7002',1) \gset stale_
select pg_catalog.pg_sleep(1.1);
select * from public.acquire_lol_collection_lease('match:KR_7002',30) \gset fresh_
create function pg_temp.assert_lol_lease(p_old uuid,p_new uuid) returns boolean language plpgsql as $$
declare v_raw jsonb;
begin
  select match into v_raw from lol_fixture;
  v_raw := pg_catalog.jsonb_set(v_raw,'{metadata,matchId}','"KR_7002"'::jsonb);
  begin
    perform public.persist_lol_match_details('match:KR_7002',p_old,'stale-detail','{}'::jsonb,'kr','asia','16.21.1',v_raw,
      v_raw->'info'->'participants','[]'::jsonb);
    raise exception 'stale worker completion unexpectedly succeeded' using errcode='P0001';
  exception when serialization_failure then null;
  end;
  if exists(select 1 from public.lol_matches where match_id='KR_7002') then raise exception 'stale worker wrote match data'; end if;
  if public.release_lol_collection_lease('match:KR_7002',p_old) then raise exception 'stale worker released renewed lease'; end if;
  if not public.release_lol_collection_lease('match:KR_7002',p_new) then raise exception 'current lease not released'; end if;
  return true;
end $$;
select pg_temp.assert_lol_lease(:'stale_lease_token'::uuid,:'fresh_lease_token'::uuid);

insert into public.lol_api_cache(cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
values ('expired-fixture','search','kr','asia','16.21.1','{}'::jsonb,now()-interval '10 minutes',now()-interval '8 minutes'),
  ('other-route-version','search','euw1','europe','16.21.2','{"route":"europe"}'::jsonb,now(),now()+interval '1 minute');
do $$
declare v_cleanup record;
begin
  if public.get_lol_api_cache('expired-fixture','search','kr','asia','16.21.1') is not null then raise exception 'expired cache exposed'; end if;
  if public.get_lol_api_cache('other-route-version','search','kr','asia','16.21.1') is not null then raise exception 'region/version cache collision'; end if;
  if public.get_lol_api_cache('other-route-version','search','euw1','europe','16.21.2')->>'route'<>'europe' then raise exception 'scoped cache not returned'; end if;
  select * into v_cleanup from public.cleanup_lol_expired_data();
  if v_cleanup.cache_rows<1 or exists(select 1 from public.lol_api_cache where cache_key='expired-fixture') then raise exception 'expired cache cleanup failed'; end if;
end $$;

update public.lol_rate_limit_state set next_permit_at=now(),min_interval_ms=1500,last_started_at=null,blocked_until='-infinity',budget_day=(timezone('UTC',now()))::date,used_count=0,max_concurrency=8 where host in ('global','asia','kr');
delete from public.lol_riot_request_log;
delete from public.lol_collection_leases where lease_type='request';
select public.record_lol_riot_rate_headers('asia','1:120','0:120','20:1','0:1');
-- Riot이 알려 준 낮은 앱 한도(2분 1회)는 이동 구간으로 지킨다.
do $$
declare v_first record; v_second record;
begin
  select * into v_first from public.reserve_lol_riot_request('asia');
  select * into v_second from public.reserve_lol_riot_request('asia');
  if not v_first.started or v_second.started or v_second.permit_at < now() + interval '100 seconds' then
    raise exception 'low observed window not enforced'; end if;
end $$;
update public.lol_rate_limit_state set blocked_until='-infinity',app_rate_limit=null where host in ('global','asia','kr');
delete from public.lol_riot_request_log;
delete from public.lol_collection_leases where lease_type='request';
select public.record_lol_riot_rate_headers('asia','100:120','80:120','20:1','0:1');
do $$
declare v_granted boolean; v_reason text; v_before timestamptz;
begin
  if (select blocked_until from public.lol_rate_limit_state where host='asia')>now() then raise exception '80 percent count must not block'; end if;
  perform public.record_lol_riot_rate_headers('asia','100:120','100:120','20:1','0:1');
  if (select blocked_until from public.lol_rate_limit_state where host='asia')<=now()
    or (select blocked_until from public.lol_rate_limit_state where host='kr')>now() then raise exception 'exhausted window did not block only its host'; end if;
  v_before := (select blocked_until from public.lol_rate_limit_state where host='asia');
  perform public.block_lol_riot_requests('asia',1);
  if (select blocked_until from public.lol_rate_limit_state where host='asia') < v_before then raise exception 'Retry-After cooldown moved backwards'; end if;
  select granted,reason into v_granted,v_reason from public.reserve_lol_riot_request('kr');
  if v_granted or v_reason<>'cooldown' then raise exception '429 cooldown was not shared across Riot hosts'; end if;
end $$;
update public.lol_rate_limit_state set blocked_until='-infinity',used_count=40,budget_day=(timezone('UTC',now()))::date where host in ('global','asia','kr');
do $$
declare v_granted boolean; v_reason text;
begin
  select granted,reason into v_granted,v_reason from public.reserve_lol_riot_request('asia');
  if v_reason='daily_budget' then raise exception 'removed daily budget is still enforced'; end if;
end $$;
update public.lol_rate_limit_state set blocked_until='-infinity',used_count=0,budget_day=(timezone('UTC',now()))::date where host in ('global','asia','kr');
do $$
declare v_granted boolean; v_reason text;
begin
  if public.record_lol_riot_rate_headers('asia','bad','0:1','20:1','0:1') then raise exception 'malformed rate window unexpectedly succeeded'; end if;
  if (select blocked_until from public.lol_rate_limit_state where host='global') <= now() then raise exception 'malformed header did not persist a global cooldown'; end if;
  select granted,reason into v_granted,v_reason from public.reserve_lol_riot_request('asia');
  if v_granted or v_reason<>'cooldown' then raise exception 'malformed header did not block subsequent requests'; end if;
end $$;
