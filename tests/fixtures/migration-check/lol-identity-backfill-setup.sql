insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route)
values ('identity-backfill-own','Identity Own','TEST','kr','asia');
insert into public.lol_matches(match_id,platform_id,regional_route,queue_id,game_version,started_at,
  duration_seconds,teams,data_version,request_json,fetched_at,expires_at)
values ('KR_889998','kr','asia',420,'16.21.1',now(),1800,'[]',2,
  '{"metadata":{"matchId":"KR_889998"},"info":{"queueId":420,"gameMode":"CLASSIC",
    "gameEndTimestamp":1790000000000,"gameDuration":1800,"participants":[
      {"puuid":"identity-backfill-own","championId":103,"teamId":100,"win":true},
      {"puuid":"identity-backfill-peer","riotIdGameName":"Old Peer","riotIdTagline":"TEST","teamId":100,"win":true}]}}',now(),now()+interval '7 days');
select public.upsert_lol_player_match_summaries('KR_889998',null);
insert into public.lol_player_match_summaries(puuid,match_id,platform_id,queue_id,played_at,teammates)
values ('identity-backfill-own','KR_889997','kr',420,now(),'[{"riotId":"No Raw#TEST","win":true}]');
