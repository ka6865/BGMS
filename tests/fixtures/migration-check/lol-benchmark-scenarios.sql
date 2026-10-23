begin;
set local role service_role;
do $$
declare
  v_raw jsonb; v_players jsonb; v_token uuid; v_result jsonb; v_before bigint; v_metric text;
  v_summary record; v_expected double precision; v_columns text[]; v_table text; v_fields text[];
  v_metrics text[] := array['kill_participation','damage_share','death_share','cs_per_min','gold_per_min','vision_per_min',
    'control_wards','wards_killed_per_min','objective_damage_share','turret_damage_share','damage_taken_share','kda'];
  v_values double precision[] := array[0.4,0.2,0.2,6,400,1,2,0.1,0.2,0.2,0.2,4];
  v_index integer; v_edge double precision; v_sequence integer := 100; v_field text; v_player jsonb;
  v_histogram integer[]; v_before_histogram integer[];
begin
  if not exists(select 1 from public.lol_benchmark_processed_matches where match_id='KR_889999') then
    raise exception 'existing raw benchmark backfill missing'; end if;
  select jsonb_agg(jsonb_build_object(
    'participantId',n,'puuid','benchmark-secret-'||n,'riotIdGameName','private-name','riotIdTagline','PRIVATE',
    'teamId',case when n<=5 then 100 else 200 end,'championId',n,'teamPosition','MIDDLE','win',n<=5,
    'kills',4,'assists',4,'deaths',2,'totalMinionsKilled',150,'neutralMinionsKilled',30,'goldEarned',12000,
    'visionScore',30,'detectorWardsPlaced',2,'wardsKilled',3,'totalDamageDealtToChampions',10000,
    'damageDealtToObjectives',1000,'damageDealtToTurrets',500,'totalDamageTaken',15000
  )) into v_players from generate_series(1,10) n;
  v_raw := jsonb_build_object('metadata',jsonb_build_object('matchId','KR_990001','dataVersion','2'),
    'info',jsonb_build_object('gameVersion','99.1.7','queueId',420,'gameDuration',1800,'gameEndTimestamp',1790000000000,
      'gameType','MATCHED_GAME','participants',v_players,'teams','[]'::jsonb));
  select lease_token into v_token from public.acquire_lol_collection_lease('benchmark-fixture',90);
  perform public.persist_lol_match_details('benchmark-fixture',v_token,'benchmark-fixture','{}','kr','asia','16.21.1',v_raw,v_players,'[]');
  if (select count(*) from public.lol_benchmark_aggregates where patch='99.1')<>143 then
    raise exception 'all ten champion samples and champion 0 aggregate required'; end if;
  select * into strict v_summary from public.get_lol_benchmark_summary('99.1',420,'MIDDLE',0) where metric='games';
  if v_summary.sample_count<>10 or v_summary.wins<>5 or v_summary.mean<>1 or v_summary.stddev<>0 then
    raise exception 'games, wins, mean or population deviation incorrect'; end if;
  for v_index in 1..cardinality(v_metrics) loop
    select * into strict v_summary from public.get_lol_benchmark_summary('99.1',420,'MIDDLE',0) where metric=v_metrics[v_index];
    if v_summary.sample_count<>10 or abs(v_summary.mean-v_values[v_index])>0.000001
      or (select sum(n) from unnest(v_summary.histogram) n)<>10
      or v_summary.histogram[1+(select count(*) from unnest(v_summary.bounds) b where b<=v_values[v_index])]<>10 then
      raise exception 'metric or exact boundary incorrect: %',v_metrics[v_index]; end if;
  end loop;
  update public.lol_matches set expires_at=now()-interval '1 day' where match_id='KR_990001';
  if public.get_lol_benchmark_match_source('KR_990001','kr','asia') is null
    or public.get_lol_benchmark_match_source('KR_990001','jp1','asia') is not null then
    raise exception 'expired source reuse or routing guard failed'; end if;
  select sum(sample_count) into v_before from public.lol_benchmark_aggregates;
  perform public.aggregate_lol_match_benchmarks('KR_990001');
  perform public.aggregate_lol_match_benchmarks('KR_990001');
  if (select sum(sample_count) from public.lol_benchmark_aggregates)<>v_before then raise exception 'duplicate match counted twice'; end if;
  -- 검색 저장 경로도 같은 집계를 딱 한 번 수행한다.
  v_raw := jsonb_set(v_raw,'{metadata,matchId}','"KR_990002"');
  select lease_token into v_token from public.acquire_lol_collection_lease('benchmark-fixture',90);
  perform public.persist_lol_search_snapshot('benchmark-fixture',v_token,'benchmark-search','{}','kr','asia','16.21.1',
    '{"puuid":"benchmark-owner","game_name":"Benchmark","tag_line":"FIX"}','[]',
    jsonb_build_array(jsonb_build_object('summary',jsonb_build_object('matchId','KR_990002'),'raw',v_raw)));
  if (select sample_count from public.lol_benchmark_aggregates where patch='99.1' and champion_id=0 and metric='games')<>20 then
    raise exception 'search persist did not aggregate'; end if;
  -- 팀 0 분모, 결측, 음수와 불리언을 0 표본으로 오해하지 않는다.
  select jsonb_agg(p || '{"kills":0,"deaths":0,"totalDamageDealtToChampions":0,"damageDealtToObjectives":0,
    "damageDealtToTurrets":0,"totalDamageTaken":0,"visionScore":null,"wardsKilled":-1,"detectorWardsPlaced":false}')
    into v_players from jsonb_array_elements(v_players) p;
  v_raw := jsonb_set(v_raw,'{info,participants}',v_players);
  v_raw := jsonb_set(v_raw,'{info,gameVersion}','"99.2.1"');
  insert into public.lol_matches select 'KR_990003',platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
    teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_990001';
  perform public.aggregate_lol_match_benchmarks('KR_990003');
  if exists(select 1 from public.lol_benchmark_aggregates where patch='99.2' and metric in (
    'kill_participation','death_share','damage_share','objective_damage_share','turret_damage_share','damage_taken_share',
    'vision_per_min','wards_killed_per_min','control_wards')) then raise exception 'missing or zero denominator counted'; end if;
  if (select sum from public.lol_benchmark_aggregates where patch='99.2' and champion_id=0 and metric='kda')<>40 then
    raise exception 'zero deaths must use denominator one per match'; end if;
  -- 팀 합계가 불완전하면 해당 팀 비중만 제외하고 다른 지표는 남긴다.
  v_raw := jsonb_set(v_raw,'{info,gameVersion}','"99.3.1"');
  v_raw := jsonb_set(v_raw,'{info,participants}',(select request_json#>'{info,participants}' from public.lol_matches where match_id='KR_990001'));
  v_raw := v_raw #- '{info,participants,0,kills}' #- '{info,participants,0,neutralMinionsKilled}';
  insert into public.lol_matches select 'KR_990004',platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
    teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_990001';
  perform public.aggregate_lol_match_benchmarks('KR_990004');
  if (select sample_count from public.lol_benchmark_aggregates where patch='99.3' and champion_id=0 and metric='kill_participation')<>5
    or (select sample_count from public.lol_benchmark_aggregates where patch='99.3' and champion_id=0 and metric='cs_per_min')<>9 then
    raise exception 'partial team denominator or cs missing handling incorrect'; end if;
  for v_index in 1..4 loop
    v_raw := (select request_json from public.lol_matches where match_id='KR_990001');
    v_raw := case v_index when 1 then jsonb_set(v_raw,'{info,gameDuration}','299')
      when 2 then jsonb_set(v_raw,'{info,participants,0,gameEndedInEarlySurrender}','true')
      when 3 then jsonb_set(v_raw,'{info,queueId}','0')
      else jsonb_set(v_raw,'{info,gameType}','"CUSTOM_GAME"') end;
    insert into public.lol_matches select 'KR_99001'||v_index,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
      teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_990001';
    v_result := public.aggregate_lol_match_benchmarks('KR_99001'||v_index);
    if v_result->>'skipped'<>'true' then raise exception 'excluded match aggregated: %',v_index; end if;
  end loop;
  -- 모든 metric의 0과 각 경계값이 오른쪽 버킷에 정확히 누적되는지 확인한다.
  foreach v_metric in array v_metrics loop
    for v_edge in select 0::double precision union select unnest(public.lol_benchmark_bounds(v_metric)) loop
      v_sequence := v_sequence+1;
      v_raw := (select request_json from public.lol_matches where match_id='KR_990001');
      v_raw := jsonb_set(v_raw,'{info,gameVersion}','"99.9.1"');
      v_players := v_raw#>'{info,participants}';
      v_player := v_players->0;
      v_field := case v_metric when 'damage_share' then 'totalDamageDealtToChampions' when 'death_share' then 'deaths'
        when 'objective_damage_share' then 'damageDealtToObjectives' when 'turret_damage_share' then 'damageDealtToTurrets'
        when 'damage_taken_share' then 'totalDamageTaken' when 'cs_per_min' then 'totalMinionsKilled'
        when 'gold_per_min' then 'goldEarned' when 'vision_per_min' then 'visionScore'
        when 'control_wards' then 'detectorWardsPlaced' when 'wards_killed_per_min' then 'wardsKilled' else null end;
      if v_metric='kill_participation' then
        v_player := v_player || jsonb_build_object('kills',0,'assists',v_edge*100);
        for v_index in 1..4 loop
          v_players := jsonb_set(v_players,array[v_index::text,'kills'],'25');
        end loop;
      elsif v_metric='kda' then
        v_player := v_player || jsonb_build_object('kills',v_edge,'deaths',1,'assists',0);
      elsif v_metric like '%share' then
        v_player := jsonb_set(v_player,array[v_field],to_jsonb(v_edge*100));
        for v_index in 1..4 loop
          v_players := jsonb_set(v_players,array[v_index::text,v_field],to_jsonb((1-v_edge)*25));
        end loop;
      else
        v_player := jsonb_set(v_player,array[v_field],to_jsonb(v_edge*case when v_metric='control_wards' then 1 else 30 end));
        if v_metric='cs_per_min' then v_player := jsonb_set(v_player,'{neutralMinionsKilled}','0'); end if;
      end if;
      v_players := jsonb_set(v_players,'{0}',v_player);
      v_raw := jsonb_set(v_raw,'{info,participants}',v_players);
      select histogram into v_before_histogram from public.lol_benchmark_aggregates
        where patch='99.9' and champion_id=1 and metric=v_metric;
      insert into public.lol_matches select 'KR_99'||v_sequence,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,
        teams,data_version,summary_version,v_raw,fetched_at,expires_at from public.lol_matches where match_id='KR_990001';
      perform public.aggregate_lol_match_benchmarks('KR_99'||v_sequence);
      select histogram into strict v_histogram from public.lol_benchmark_aggregates
        where patch='99.9' and champion_id=1 and metric=v_metric;
      for v_index in 1..cardinality(v_histogram) loop
        if v_histogram[v_index]-coalesce(v_before_histogram[v_index],0)<>
          (case when v_index=1+(select count(*) from unnest(public.lol_benchmark_bounds(v_metric)) b where b<=v_edge) then 1 else 0 end) then
          raise exception 'histogram boundary failed: metric %, edge %, bucket %',v_metric,v_edge,v_index;
        end if;
      end loop;
    end loop;
  end loop;
  -- 두 테이블의 컬럼을 고정하여 식별 필드 추가를 검출한다.
  foreach v_table in array array['lol_benchmark_processed_matches','lol_benchmark_aggregates'] loop
    select array_agg(column_name::text order by ordinal_position) into v_columns from information_schema.columns
      where table_schema='public' and table_name=v_table;
    v_fields := case when v_table='lol_benchmark_processed_matches' then
      array['match_id','patch','queue_id','processed_at','skipped_reason'] else
      array['patch','queue_id','team_position','champion_id','metric','sample_count','sum','sum_sq','histogram','wins','updated_at'] end;
    if v_columns<>v_fields then raise exception 'anonymous column contract changed: %',v_table; end if;
  end loop;
  delete from public.lol_matches where match_id='KR_990003';
  if public.aggregate_lol_match_benchmarks('KR_990003')->>'aggregated'<>'false' then
    raise exception 'duplicate after raw expiry must remain a no-op'; end if;
  if public.get_lol_ops_status()#>>'{benchmarks,processed}' is null then raise exception 'ops benchmark counts missing'; end if;
end $$;
reset role;
do $$
declare v_role text; v_table text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_table in array array['lol_benchmark_processed_matches','lol_benchmark_aggregates'] loop
      if has_table_privilege(v_role,'public.'||v_table,'select,insert,update,delete') then raise exception 'benchmark table public access'; end if;
      if not (select relrowsecurity from pg_class where oid=('public.'||v_table)::regclass) then raise exception 'benchmark RLS missing'; end if;
    end loop;
    if has_function_privilege(v_role,'public.aggregate_lol_match_benchmarks(text)','execute')
      or has_function_privilege(v_role,'public.get_lol_benchmark_summary(text,integer,text,integer)','execute')
      or has_function_privilege(v_role,'public.get_lol_benchmark_match_source(text,text,text)','execute') then
      raise exception 'benchmark RPC public access'; end if;
  end loop;
end $$;
rollback;
