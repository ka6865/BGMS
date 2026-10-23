insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route)
values ('summary-migration-seed','Migration Seed','SUM','kr','asia');
insert into public.lol_matches(match_id,platform_id,regional_route,queue_id,game_version,started_at,
  duration_seconds,teams,data_version,request_json,fetched_at,expires_at)
values ('KR_889999','kr','asia',420,'16.21.1',now(),1800,'[]',2,
  '{"metadata":{"matchId":"KR_889999"},"info":{"queueId":420,"gameMode":"CLASSIC",
    "gameEndTimestamp":1790000000000,"gameDuration":1800,"participants":[
      {"puuid":"summary-migration-seed","championId":103,"championName":"Ahri","teamId":100,"win":true,"kills":2},
      {"puuid":"summary-never-searched","championId":86,"teamId":200,"win":false,"kills":1}]}}',now(),now()+interval '7 days');
