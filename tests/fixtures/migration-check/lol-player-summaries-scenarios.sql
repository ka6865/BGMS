begin;
set local role service_role;

do $$
declare
  v_token uuid; v_raw jsonb; v_account jsonb; v_row public.lol_player_match_summaries;
  v_deleted jsonb; v_before integer; v_list text[];
begin
  if not exists (select 1 from public.lol_player_match_summaries where puuid='summary-migration-seed' and match_id='KR_889999')
    or exists (select 1 from public.lol_player_match_summaries where puuid='summary-never-searched') then
    raise exception 'migration did not backfill only searched accounts from existing raw'; end if;
  insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route,last_accessed_at)
  values ('summary-owner','Owner','SUM','kr','asia',now()-interval '100 days');
  v_raw := '{"metadata":{"matchId":"KR_880001","dataVersion":"2"},"info":{
    "queueId":420,"gameMode":"CLASSIC","gameType":"MATCHED_GAME","gameVersion":"16.21.1",
    "gameEndTimestamp":1790000000000,"gameDuration":1800,"participants":[
      {"participantId":1,"puuid":"summary-owner","riotIdGameName":"Past Owner","riotIdTagline":"SUM","teamId":100,
       "championId":103,"championName":"Ahri","teamPosition":"MIDDLE","win":true,"kills":5,"deaths":2,"assists":7,
       "totalMinionsKilled":150,"neutralMinionsKilled":10,"goldEarned":12000,"totalDamageDealtToChampions":20000,
       "totalDamageTaken":14000,"visionScore":20,"wardsPlaced":8,"wardsKilled":3,"detectorWardsPlaced":2,
       "damageDealtToObjectives":3000,"damageDealtToTurrets":1200,"champLevel":16,"summoner1Id":4,"summoner2Id":14,
       "item0":1056,"item1":0,"item2":0,"item3":0,"item4":0,"item5":0,"item6":0,
       "perks":{"styles":[{"style":8000,"selections":[{"perk":8005,"var1":999}]},{"style":8100}]}},
      {"participantId":2,"puuid":"summary-later","riotIdGameName":"Later","riotIdTagline":"SUM","teamId":100,
       "championId":86,"championName":"Garen","win":true,"kills":3},
      {"participantId":3,"puuid":"summary-other","riotIdGameName":"Other","riotIdTagline":"SUM","teamId":200,
       "championId":1,"win":false,"kills":1}
    ],"teams":[]}}';
  select lease_token into v_token from public.acquire_lol_collection_lease('summary-detail',90);
  perform public.persist_lol_match_details('summary-detail',v_token,'summary-detail','{}','kr','asia','16.21.1',
    v_raw,v_raw->'info'->'participants','[]');
  if (select count(*) from public.lol_player_match_summaries where match_id='KR_880001') <> 1 then
    raise exception 'unsearched participant gained a summary';
  end if;
  select * into strict v_row from public.lol_player_match_summaries where puuid='summary-owner' and match_id='KR_880001';
  if v_row.cs <> 160 or v_row.team_kills <> 8 or v_row.damage_taken <> 14000 or v_row.champion_level <> 16
    or v_row.damage_to_turrets <> 1200 or v_row.summoner_spells <> array[4,14] or v_row.items[1] <> 1056
    or v_row.perks <> '{"keystone":8005,"primaryStyle":8000,"subStyle":8100}'::jsonb
    or v_row.teammates <> '[{"riotId":"Later#SUM","win":true,"puuid":"summary-later"}]'::jsonb
    then raise exception 'server card summary lost fields or teammate identity'; end if;

  -- 나중에 검색된 계정은 현재 검색 결과가 비어도 기존 참가자와 원문으로 백필한다.
  v_account := '{"puuid":"summary-later","game_name":"Later","tag_line":"SUM","profile_icon_id":1,"summoner_level":30}';
  select lease_token into v_token from public.acquire_lol_collection_lease('summary-search',90);
  perform public.persist_lol_search_snapshot('summary-search',v_token,'summary-search','{}','kr','asia','16.21.1',v_account,'[]','[]');
  if not exists (select 1 from public.lol_player_match_summaries where puuid='summary-later' and match_id='KR_880001') then
    raise exception 'new searched account did not backfill existing participants'; end if;
  select count(*) into v_before from public.lol_player_match_summaries;
  perform public.upsert_lol_player_match_summaries(null,null);
  perform public.upsert_lol_player_match_summaries(null,null);
  if (select count(*) from public.lol_player_match_summaries) <> v_before then raise exception 'backfill was not idempotent'; end if;

  -- 검색 저장 경로에서도 기존 검색 계정 모두의 요약을 만든다.
  v_raw := jsonb_set(v_raw,'{metadata,matchId}','"KR_880002"');
  v_raw := jsonb_set(v_raw,'{info,gameEndTimestamp}','1790001000000');
  v_raw := jsonb_set(v_raw,'{info,participants,0,riotIdGameName}','"Owner"');
  select lease_token into v_token from public.acquire_lol_collection_lease('summary-search',90);
  perform public.persist_lol_search_snapshot('summary-search',v_token,'summary-search','{}','kr','asia','16.21.1',v_account,'[]',
    jsonb_build_array(jsonb_build_object('summary',jsonb_build_object('matchId','KR_880002'),'raw',v_raw)));
  select array_agg(match_id) into v_list from public.get_lol_player_match_summaries('summary-owner',20,null);
  if v_list <> array['KR_880002','KR_880001'] then raise exception 'summary ordering failed: %',v_list; end if;
  if (select count(*) from public.get_lol_player_match_summaries('summary-owner',1,null)) <> 1
    or (select count(*) from public.get_lol_player_match_summaries('summary-owner',20,to_timestamp(1790001000))) <> 1 then
    raise exception 'summary limit or before boundary failed'; end if;
  update public.lol_matches set fetched_at=now()-interval '8 days',expires_at=now()-interval '1 day' where match_id='KR_880002';
  perform public.cleanup_lol_expired_batch(1000);
  perform public.cleanup_lol_expired_data();
  if not exists (select 1 from public.lol_player_match_summaries where puuid='summary-owner' and match_id='KR_880002')
    or not exists (select 1 from public.lol_accounts where puuid='summary-owner')
    or exists (select 1 from public.lol_matches where match_id='KR_880002') then
    raise exception 'cleanup destroyed permanent data or kept expired raw'; end if;

  insert into public.lol_ranked_entries(puuid,platform_id,queue_type,tier,rank,league_points,wins,losses)
  values ('summary-owner','kr','RANKED_SOLO_5x5','GOLD','I',1,1,1);
  insert into public.lol_ranked_history(puuid,queue_type,tier,rank,league_points,wins,losses)
  values ('summary-owner','RANKED_SOLO_5x5','GOLD','I',1,1,1);
  select lease_token into v_token from public.acquire_lol_collection_lease('search:v10:owner#sum',90);
  v_deleted := public.delete_lol_account_data('summary-owner');
  if (v_deleted->>'account_rows')::integer <> 1 or (v_deleted->>'history_rows')::integer <> 1
    or (v_deleted->>'ranked_rows')::integer <> 1 or (v_deleted->>'summary_rows')::integer <> 2
    or (v_deleted->>'participant_rows')::integer <> 3
    or exists (select 1 from public.lol_match_participants where puuid='summary-owner')
    or exists (select 1 from public.lol_player_match_summaries where puuid='summary-owner')
    or exists (select 1 from public.lol_ranked_history where puuid='summary-owner')
    or exists (select 1 from public.lol_api_cache)
    or exists (select 1 from public.lol_player_match_summaries s, jsonb_array_elements(s.teammates) t where t->>'riotId' in ('Owner#SUM','Past Owner#SUM')) then
    raise exception 'account deletion left personal data: %',v_deleted; end if;
  begin
    perform public.persist_lol_search_snapshot('search:v10:owner#sum',v_token,'summary-race','{}','kr','asia','16.21.1',v_account,'[]','[]');
    raise exception 'in-flight collection survived account deletion';
  exception when serialization_failure then null; end;
  if not exists (select 1 from public.lol_player_match_summaries where puuid='summary-later' and match_id='KR_880001') then
    raise exception 'deleting related raw removed another account summary'; end if;
  v_deleted := public.delete_lol_account_data('summary-owner');
  if exists (select 1 from jsonb_each_text(v_deleted) t where t.value <> '0') then raise exception 'account deletion is not idempotent'; end if;
end $$;
reset role;

do $$
declare v_role text; v_fn text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_table_privilege(v_role,'public.lol_player_match_summaries','SELECT')
      or has_table_privilege(v_role,'public.lol_player_match_summaries','INSERT') then raise exception 'summary table exposed'; end if;
    foreach v_fn in array array['public.get_lol_player_match_summaries(text,integer,timestamptz)',
      'public.upsert_lol_player_match_summaries(text,text)','public.delete_lol_account_data(text)'] loop
      if has_function_privilege(v_role,v_fn,'EXECUTE') then raise exception 'summary or deletion RPC exposed'; end if;
    end loop;
  end loop;
end $$;
set local role anon;
do $$ begin
  begin
    perform * from public.get_lol_player_match_summaries('summary-owner',20,null);
    raise exception 'anon unexpectedly read summaries';
  exception when insufficient_privilege then null; end;
  begin
    perform public.delete_lol_account_data('summary-owner');
    raise exception 'anon unexpectedly deleted account';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
