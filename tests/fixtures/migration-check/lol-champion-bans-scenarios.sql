begin;
set local role service_role;
do $$
declare
  v_raw jsonb; v_players jsonb; v_token uuid; v_result jsonb; v_columns text[];
begin
  select jsonb_agg(jsonb_build_object(
    'participantId',n,'puuid','ban-secret-'||n,'teamId',case when n<=5 then 100 else 200 end,'championId',n,
    'teamPosition','MIDDLE','win',n<=5,'kills',4,'assists',4,'deaths',2,'totalMinionsKilled',150,'neutralMinionsKilled',30,
    'goldEarned',12000,'visionScore',30,'detectorWardsPlaced',2,'wardsKilled',3,'totalDamageDealtToChampions',10000,
    'damageDealtToObjectives',1000,'damageDealtToTurrets',500,'totalDamageTaken',15000
  )) into v_players from generate_series(1,10) n;
  -- 두 팀이 같은 챔피언(55)을 밴하면 한 번만 세고, -1(밴 없음)·소수·문자열은 버린다.
  v_raw := jsonb_build_object('metadata',jsonb_build_object('matchId','KR_980001','dataVersion','2'),
    'info',jsonb_build_object('gameVersion','98.1.3','queueId',420,'gameDuration',1800,'gameEndTimestamp',1790000000000,
      'gameType','MATCHED_GAME','participants',v_players,'teams',jsonb_build_array(
        jsonb_build_object('teamId',100,'win',true,'bans',jsonb_build_array(
          jsonb_build_object('championId',55,'pickTurn',1),jsonb_build_object('championId',-1,'pickTurn',2),
          jsonb_build_object('championId',12.5,'pickTurn',3),jsonb_build_object('championId','77','pickTurn',4),
          jsonb_build_object('championId',66,'pickTurn',5))),
        jsonb_build_object('teamId',200,'win',false,'bans',jsonb_build_array(
          jsonb_build_object('championId',55,'pickTurn',6),jsonb_build_object('championId',88,'pickTurn',7))))));
  select lease_token into v_token from public.acquire_lol_collection_lease('ban-fixture',90);
  perform public.persist_lol_match_details('ban-fixture',v_token,'ban-fixture','{}','kr','asia','16.21.1',v_raw,v_players,'[]');
  if (select array_agg(champion_id||':'||bans order by champion_id) from public.lol_champion_ban_aggregates where patch='98.1')
    <>array['55:1','66:1','88:1'] then raise exception 'match details path ban aggregate incorrect'; end if;
  -- 같은 경기를 다시 집계해도 누적하지 않는다.
  perform public.aggregate_lol_match_benchmarks('KR_980001');
  if public.aggregate_lol_match_bans('KR_980001')->>'aggregated'<>'false' then raise exception 'duplicate ban aggregate'; end if;
  if (select sum(bans) from public.lol_champion_ban_aggregates where patch='98.1')<>3 then raise exception 'duplicate bans counted'; end if;
  -- 검색 저장 경로도 같은 집계를 한 번 수행한다.
  v_raw := jsonb_set(v_raw,'{metadata,matchId}','"KR_980002"');
  select lease_token into v_token from public.acquire_lol_collection_lease('ban-fixture',90);
  perform public.persist_lol_search_snapshot('ban-fixture',v_token,'ban-search','{}','kr','asia','16.21.1',
    '{"puuid":"ban-owner","game_name":"Ban","tag_line":"FIX"}','[]',
    jsonb_build_array(jsonb_build_object('summary',jsonb_build_object('matchId','KR_980002'),'raw',v_raw)));
  if (select bans from public.lol_champion_ban_aggregates where patch='98.1' and queue_id=420 and champion_id=55)<>2 then
    raise exception 'search persist did not aggregate bans'; end if;
  -- 밴이 없는 팀 구성은 분모에 넣고, 팀 정보가 깨진 경기는 분모에서 뺀다.
  v_raw := jsonb_set(v_raw,'{metadata,matchId}','"KR_980003"');
  v_raw := jsonb_set(v_raw,'{info,teams}','[{"teamId":100,"bans":[]},{"teamId":200,"bans":[]}]');
  insert into public.lol_matches select 'KR_980003',platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
    teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_980001';
  perform public.aggregate_lol_match_benchmarks('KR_980003');
  v_raw := jsonb_set(v_raw,'{info,teams}','[{"teamId":100,"bans":[{"championId":99}]}]');
  insert into public.lol_matches select 'KR_980004',platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
    teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_980001';
  perform public.aggregate_lol_match_benchmarks('KR_980004');
  if (select skipped_reason from public.lol_champion_ban_processed_matches where match_id='KR_980004')<>'invalid_teams'
    or exists(select 1 from public.lol_champion_ban_aggregates where champion_id=99) then raise exception 'invalid teams counted'; end if;
  if (select array_agg(champion_id||':'||bans||'/'||matches order by champion_id) from public.get_lol_champion_ban_summary('98.1',420))
    <>array['55:2/3','66:2/3','88:2/3'] then raise exception 'ban summary or denominator incorrect'; end if;
  -- 벤치마크에서 제외한 경기(5분 미만)는 밴도 집계하지 않는다.
  v_raw := jsonb_set((select request_json from public.lol_matches where match_id='KR_980001'),'{info,gameDuration}','299');
  insert into public.lol_matches select 'KR_980005',platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
    teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_980001';
  perform public.aggregate_lol_match_benchmarks('KR_980005');
  v_result := public.aggregate_lol_match_bans('KR_980005');
  if v_result->>'reason'<>'short' or exists(select 1 from public.lol_champion_ban_processed_matches where match_id='KR_980005') then
    raise exception 'skipped benchmark match counted for bans'; end if;
  begin
    perform public.aggregate_lol_match_bans('KR_unknown');
    raise exception 'unknown match unexpectedly aggregated';
  exception when sqlstate '22023' then null;
  end;
  -- 집계 테이블에 식별 필드가 추가되지 않도록 컬럼을 고정한다.
  select array_agg(column_name::text order by ordinal_position) into v_columns from information_schema.columns
    where table_schema='public' and table_name='lol_champion_ban_aggregates';
  if v_columns<>array['patch','queue_id','champion_id','bans','updated_at'] then raise exception 'ban aggregate columns changed'; end if;
  select array_agg(column_name::text order by ordinal_position) into v_columns from information_schema.columns
    where table_schema='public' and table_name='lol_champion_ban_processed_matches';
  if v_columns<>array['match_id','patch','queue_id','processed_at','skipped_reason'] then raise exception 'ban processed columns changed'; end if;
end $$;
reset role;
do $$
declare v_role text; v_table text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_table in array array['lol_champion_ban_processed_matches','lol_champion_ban_aggregates'] loop
      if has_table_privilege(v_role,'public.'||v_table,'select,insert,update,delete') then raise exception 'ban table public access'; end if;
      if not (select relrowsecurity from pg_class where oid=('public.'||v_table)::regclass) then raise exception 'ban RLS missing'; end if;
    end loop;
    if has_function_privilege(v_role,'public.aggregate_lol_match_bans(text)','execute')
      or has_function_privilege(v_role,'public.get_lol_champion_ban_summary(text,integer)','execute') then
      raise exception 'ban RPC public access'; end if;
  end loop;
end $$;
rollback;
