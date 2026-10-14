-- Runs only in the verifier's disposable PostgreSQL database.
begin;
insert into public.system_settings(key,value) values('private_players_list','[]')
on conflict(key) do update set value=excluded.value;
delete from public.pubg_response_cache where cache_key like 'rankings:v1:%';
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
select 'refresh-player-'||n,'steam','refresh-match-'||n,now()-interval '1 hour','squad','Baltic_Main',n,1000+n,1,'official','account.refresh'||n,true
from generate_series(1,5)n;

do $$
declare a jsonb; row_payload jsonb; row_expires timestamptz; requested timestamptz;
begin
  if has_function_privilege('anon','public.refresh_pubg_rankings_cache()','execute')
    or has_function_privilege('authenticated','public.refresh_pubg_rankings_cache()','execute')
    or has_function_privilege('anon','public.pubg_ranking_build(text,text[],text,integer,integer,integer,integer,text[],timestamptz)','execute')
    or has_function_privilege('anon','public.pubg_ranking_mark_requested(text,jsonb)','execute')
    or has_function_privilege('anon','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
    or not has_function_privilege('service_role','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
  then raise exception 'FAIL: ranking refresh ACL'; end if;
  if not exists(select 1 from cron.job where jobname='bgms-pubg-rankings-refresh' and schedule='10 seconds'
    and command='select public.refresh_pubg_rankings_cache();') then
    raise exception 'FAIL: ranking refresh cron job missing';
  end if;

  -- 첫 요청은 집계하고, 응답에는 내부 필드를 내보내지 않으며, 저장 결과는 20분 동안 유효하다.
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',3,8,1,73);
  if (a->>'cache_hit')::boolean or a ? 'params' or a ? 'requested_at'
    or a->'entries'->0->>'player_id'<>'refresh-player-5' then
    raise exception 'FAIL: first ranking request %', a;
  end if;
  select payload,expires_at into row_payload,row_expires from public.pubg_response_cache where cache_key like 'rankings:v1:%';
  if row_payload->'params'->>'tab'<>'damage' or row_payload->'params'->'modes'<>'["squad"]'::jsonb
    or row_payload->>'requested_at' is null
    or row_expires<clock_timestamp()+interval '19 minutes' or row_expires>clock_timestamp()+interval '21 minutes' then
    raise exception 'FAIL: stored ranking payload %', row_payload;
  end if;
  if not (public.get_pubg_rankings_cached('damage',array['squad'],'all',3,8,1,73)->>'cache_hit')::boolean then
    raise exception 'FAIL: second request should hit the stored ranking';
  end if;

  -- 갓 저장된 결과는 다시 집계하지 않는다.
  if public.refresh_pubg_rankings_cache()<>0 then raise exception 'FAIL: fresh ranking refreshed'; end if;

  -- 4분 넘게 지난 결과는 예약 집계가 새 경기를 반영하고 조회 시각을 유지한다.
  requested:=clock_timestamp()-interval '1 hour';
  update public.pubg_response_cache set updated_at=clock_timestamp()-interval '5 minutes',
    payload=jsonb_set(payload,'{requested_at}',to_jsonb(requested)) where cache_key like 'rankings:v1:%';
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
  values('refresh-newcomer','steam','refresh-match-new',now()-interval '10 minutes','squad','Baltic_Main',9,5000,1,'official','account.refreshnew',true);
  if public.refresh_pubg_rankings_cache()<>1 then raise exception 'FAIL: stale ranking not refreshed'; end if;
  select payload into row_payload from public.pubg_response_cache where cache_key like 'rankings:v1:%';
  if row_payload->'entries'->0->>'player_id'<>'refresh-newcomer'
    or (row_payload->>'requested_at')::timestamptz<>requested then
    raise exception 'FAIL: refreshed ranking payload %', row_payload;
  end if;
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',3,8,1,73);
  if not (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'refresh-newcomer' then
    raise exception 'FAIL: request did not read refreshed ranking %', a;
  end if;
  -- 1시간 전 조회 기록이 5분보다 오래됐으므로 이번 조회가 기록된다.
  if (select (payload->>'requested_at')::timestamptz from public.pubg_response_cache where cache_key like 'rankings:v1:%')<=requested then
    raise exception 'FAIL: cache hit did not record request time';
  end if;

  -- 6시간 넘게 조회되지 않은 조합은 다시 집계하지 않는다.
  update public.pubg_response_cache set updated_at=clock_timestamp()-interval '5 minutes',
    payload=jsonb_set(payload,'{requested_at}',to_jsonb(clock_timestamp()-interval '7 hours')) where cache_key like 'rankings:v1:%';
  if public.refresh_pubg_rankings_cache()<>0 then raise exception 'FAIL: idle ranking refreshed'; end if;

  -- 비공개 목록이 바뀌면 새 키로 다시 집계하고, 요청은 비공개 대상이 빠진 결과를 바로 읽는다.
  update public.pubg_response_cache set payload=jsonb_set(payload,'{requested_at}',to_jsonb(clock_timestamp()))
  where cache_key like 'rankings:v1:%';
  update public.system_settings set value='[{"platform":"steam","nickname":"refresh-newcomer","account_id":"account.refreshnew"}]'
  where key='private_players_list';
  if public.refresh_pubg_rankings_cache()<>1 then raise exception 'FAIL: privacy change not refreshed'; end if;
  if (select count(*) from public.pubg_response_cache where cache_key like 'rankings:v1:%')<>1 then
    raise exception 'FAIL: previous privacy key kept after refresh';
  end if;
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',3,8,1,73);
  if not (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'refresh-player-5'
    or exists(select 1 from jsonb_array_elements(a->'entries') e where e->>'player_id'='refresh-newcomer') then
    raise exception 'FAIL: private player in refreshed ranking %', a;
  end if;
  -- 예약 집계 실행 기록은 하루치만 남긴다.
  insert into cron.job_run_details select jobid,now()-interval '2 days' from cron.job where jobname='bgms-pubg-rankings-refresh';
  insert into cron.job_run_details select jobid,now()-interval '2 hours' from cron.job where jobname='bgms-pubg-rankings-refresh';
  perform bgms_private.cleanup_pubg_collection_clock_logs();
  if (select count(*) from cron.job_run_details d join cron.job j using(jobid) where j.jobname='bgms-pubg-rankings-refresh')<>1 then
    raise exception 'FAIL: ranking refresh logs retention';
  end if;
  -- 요청 집계가 실패한 조합은 등록만 하고, 등록 행은 요청에 내보내지 않으며, 예약 집계가 먼저 채운다.
  update public.system_settings set value='[]' where key='private_players_list';
  delete from public.pubg_response_cache where cache_key like 'rankings:v1:%';
  if has_function_privilege('anon','public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer)','execute')
    or not has_function_privilege('service_role','public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer)','execute')
  then raise exception 'FAIL: ranking queue ACL'; end if;
  perform public.queue_pubg_ranking_refresh('kills',array['squad','squad'],'all',3,8,1,73);
  select payload into row_payload from public.pubg_response_cache where cache_key like 'rankings:v1:%';
  if row_payload->'params'->'modes'<>'["squad"]'::jsonb or row_payload->>'requested_at' is null then
    raise exception 'FAIL: queued ranking payload %', row_payload;
  end if;
  if public.refresh_pubg_rankings_cache()<>1 then raise exception 'FAIL: queued ranking not built'; end if;
  a:=public.get_pubg_rankings_cached('kills',array['squad'],'all',3,8,1,73);
  if not (a->>'cache_hit')::boolean or jsonb_array_length(a->'entries')=0 then
    raise exception 'FAIL: queued ranking not served %', a;
  end if;
  -- 이미 있는 결과를 다시 등록해도 결과는 그대로 두고 조회 시각만 갱신한다.
  perform public.queue_pubg_ranking_refresh('kills',array['squad'],'all',3,8,1,73);
  if not (public.get_pubg_rankings_cached('kills',array['squad'],'all',3,8,1,73)->>'cache_hit')::boolean then
    raise exception 'FAIL: queue overwrote stored ranking';
  end if;
  raise notice 'PASS: ranking background refresh, request tracking, privacy and ACL';
end $$;
rollback;
