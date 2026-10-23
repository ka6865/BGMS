-- 신규 열 추가 전의 원문과 영구 요약을 마련하여 migration 자체의 백필을 확인한다.
insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route)
values ('challenge-seed','Challenge Fixture','FIX','kr','asia');
insert into public.lol_matches(match_id,platform_id,regional_route,queue_id,game_version,started_at,
  duration_seconds,teams,data_version,request_json,fetched_at,expires_at)
values ('KR_887997','kr','asia',420,'16.21.1',now(),1800,'[]',2,
  '{"metadata":{"matchId":"KR_887997"},"info":{"queueId":420,"gameMode":"CLASSIC",
    "gameEndTimestamp":1790000000000,"gameDuration":1800,"participants":[
      {"puuid":"challenge-seed","championId":103,"championName":"Ahri","teamId":100,"win":true,"kills":2,
       "challenges":{"soloKills":2,"visionScorePerMinute":1.25,"teamDamagePercentage":0.3,
         "kda":"invalid","goldPerMinute":null,"skillshotsHit":true,"unknownPatchKey":999}}]}}',now(),now()+interval '7 days');
select public.upsert_lol_player_match_summaries('KR_887997',null);
insert into public.lol_player_match_summaries(puuid,match_id,platform_id,queue_id,played_at,kills)
values ('challenge-seed','KR_887996','kr',420,now(),123);
