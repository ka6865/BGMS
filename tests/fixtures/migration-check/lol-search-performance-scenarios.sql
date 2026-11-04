begin;
set local role service_role;
do $$
declare v_players jsonb; v_raw jsonb; v_matches jsonb; v_token uuid; v_start timestamptz; v_elapsed numeric; v_before bigint;
begin
  select jsonb_agg(jsonb_build_object(
    'participantId',n,'puuid',case when n=1 then 'performance-owner' else 'performance-other-'||n end,
    'teamId',case when n<=5 then 100 else 200 end,'championId',n,'championName','Fixture','teamPosition','MIDDLE','win',n<=5,
    'kills',4,'assists',4,'deaths',2,'totalMinionsKilled',150,'neutralMinionsKilled',30,'goldEarned',12000,
    'visionScore',30,'detectorWardsPlaced',2,'wardsKilled',3,'totalDamageDealtToChampions',10000,
    'damageDealtToObjectives',1000,'damageDealtToTurrets',500,'totalDamageTaken',15000,
    'challenges',jsonb_build_object('kda',4),'padding',(select string_agg(md5(i::text),'') from generate_series(1,100) i)
  )) into v_players from generate_series(1,10) n;
  select jsonb_agg(jsonb_build_object('summary',jsonb_build_object('matchId','KR_771'||i), 'raw',
    jsonb_build_object('metadata',jsonb_build_object('matchId','KR_771'||i,'dataVersion','2'),
    'info',jsonb_build_object('gameVersion','99.81.1','queueId',420,'gameMode','CLASSIC','gameDuration',1800,
    'gameEndTimestamp',1790000000000,'gameType','MATCHED_GAME','participants',v_players,'teams','[]'::jsonb))))
    into v_matches from generate_series(1,20) i;
  select lease_token into v_token from public.acquire_lol_collection_lease('performance-search',90);
  v_start:=clock_timestamp();
  perform public.persist_lol_search_snapshot('performance-search',v_token,'performance-cache','{}','kr','asia','16.21.1',
    '{"puuid":"performance-owner","game_name":"Performance","tag_line":"FIX"}','[]',v_matches);
  v_elapsed:=extract(epoch from clock_timestamp()-v_start)*1000;
  raise notice '20-match atomic search persistence: % ms',round(v_elapsed,2);
  if v_elapsed>4000 then raise exception '20-match persistence exceeded 4s budget: % ms',v_elapsed; end if;
  if (select count(*) from public.lol_player_match_summaries where puuid='performance-owner')<>20
    or (select count(*) from public.get_lol_pending_benchmark_matches(100) where match_id like 'KR_771%')<>20 then
    raise exception '20-match persistence lost summaries or samples'; end if;
  perform public.aggregate_lol_match_benchmarks('KR_771'||i) from generate_series(1,20) i;
  select sum(sample_count) into v_before from public.lol_benchmark_aggregates;
  select lease_token into v_token from public.acquire_lol_collection_lease('performance-search',90);
  perform public.persist_lol_search_snapshot('performance-search',v_token,'performance-cache','{}','kr','asia','16.21.1',
    '{"puuid":"performance-owner","game_name":"Performance","tag_line":"FIX"}','[]',v_matches);
  if (select sum(sample_count) from public.lol_benchmark_aggregates)<>v_before then raise exception 'repeat search double-counted'; end if;
  -- 계정 백필은 해당 참가자 인덱스에 없는 원문의 JSON을 펼치지 않는다.
  insert into public.lol_matches(match_id,platform_id,regional_route,queue_id,game_version,started_at,duration_seconds,teams,data_version,request_json,expires_at)
  values ('KR_771999','kr','asia',420,'99.81.1',now(),1800,'[]',2,'{"info":{"participants":"unrelated-do-not-expand"}}',now()+interval '1 day');
  perform public.upsert_lol_player_match_summaries(null,'performance-owner');
end $$;
reset role;

do $$ declare v_role text; begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_function_privilege(v_role,'public.upsert_lol_player_match_summaries(text,text)','EXECUTE')
      or has_function_privilege(v_role,'public.aggregate_lol_match_benchmarks(text)','EXECUTE')
      or has_function_privilege(v_role,'public.get_lol_pending_benchmark_matches(integer)','EXECUTE') then
      raise exception 'optimized functions exposed'; end if;
  end loop;
end $$;
rollback;
