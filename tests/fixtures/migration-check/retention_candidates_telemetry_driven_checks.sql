-- 텔레메트리 키에서 출발하는 보존 후보 조회가 기존 계약을 지키는지 확인한다.
begin;
do $$
declare
  cutoff timestamptz := now() - interval '15 days';
  picked text[];
begin
  -- 경기 A: 텔레메트리 없음(후보에서 빠져야 한다)
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values ('td_a1','steam','td-no-telemetry',now()-interval '45 days','squad','Baltic_Main',0,0,1,'official');
  -- 경기 B: map cache 에만 있음. 참가자 둘 중 player_id 가 작은 행이 대표여야 한다.
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values ('td_b2','steam','td-map-cache',now()-interval '44 days','squad','Baltic_Main',0,0,1,'official'),
         ('td_b1','steam','td-map-cache',now()-interval '44 days','squad','Baltic_Main',0,0,1,'official');
  insert into public.telemetry_map_cache_entries(match_id,platform,player_id,mode,telemetry_version,storage_path,status)
  values ('td-map-cache','steam','td_b1','lite',1,'td/map-cache.json','ready');
  -- 경기 C: processed 에만 있음, kakao. 같은 경기에 더 늦은 played_at 행이 있어도 가장 이른 행만 나온다.
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values ('td_c1','kakao','td-processed',now()-interval '43 days','squad','Baltic_Main',0,0,1,'official'),
         ('td_c0','kakao','td-processed',now()-interval '42 days','squad','Baltic_Main',0,0,1,'official');
  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values ('td-processed','kakao','td_c1','{}');
  -- 경기 D: 두 레지스트리에 모두 있어도 한 번만 나온다.
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values ('td_d1','steam','td-both',now()-interval '41 days','squad','Baltic_Main',0,0,1,'official');
  insert into public.telemetry_map_cache_entries(match_id,platform,player_id,mode,telemetry_version,storage_path,status)
  values ('td-both','steam','td_d1','full',1,'td/both.json','ready');
  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values ('td-both','steam','td_d1','{}');
  -- 경기 E: 기준일 이후라 만료 전이므로 제외된다.
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values ('td_e1','steam','td-recent',now()-interval '16 hours','squad','Baltic_Main',0,0,1,'official');
  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values ('td-recent','steam','td_e1','{}');

  select array_agg(match_id||':'||player_id order by played_at, platform, match_id) into picked
  from public.list_retention_archive_candidates(1000, cutoff)
  where match_id like 'td-%';
  if picked is distinct from array['td-map-cache:td_b1','td-processed:td_c1','td-both:td_d1'] then
    raise exception 'unexpected candidates: %', picked;
  end if;

  -- 커서는 (played_at, platform, match_id) 기준으로 그 다음 경기부터 돌려준다.
  select array_agg(match_id order by played_at, platform, match_id) into picked
  from public.list_retention_archive_candidates(1000, cutoff, now()-interval '44 days', 'steam', 'td-map-cache')
  where match_id like 'td-%';
  if picked is distinct from array['td-processed','td-both'] then
    raise exception 'cursor result mismatch: %', picked;
  end if;

  -- 개수 제한은 행이 아니라 경기 기준이다.
  select array_agg(match_id order by played_at, platform, match_id) into picked
  from public.list_retention_archive_candidates(1, cutoff, now()-interval '50 days', 'steam', 'td-before-all');
  if picked is null or cardinality(picked) <> 1 then
    raise exception 'limit must apply per match: %', picked;
  end if;

  if has_function_privilege('anon','public.list_retention_archive_candidates(integer,timestamptz,timestamptz,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.list_retention_archive_candidates(integer,timestamptz,timestamptz,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.list_retention_archive_candidates(integer,timestamptz,timestamptz,text,text)','EXECUTE') then
    raise exception 'candidate function ACL invalid';
  end if;
end;
$$;
rollback;
