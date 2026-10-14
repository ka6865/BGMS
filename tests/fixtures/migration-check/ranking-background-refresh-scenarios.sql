-- Runs only in the verifier's disposable PostgreSQL database.
begin;
insert into public.system_settings(key,value) values('private_players_list','[]')
on conflict(key) do update set value=excluded.value;
delete from public.pubg_response_cache where cache_key like 'rankings:%';
-- 지난주 경기 5개와 이번 주 경기 1개. 이번 주 기록은 딜량이 가장 높아도 지난주 랭킹에 들어가면 안 된다.
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
select 'week-player-'||n,'steam','week-match-'||n,(select week_start from public.pubg_ranking_week())+interval '2 days','squad','Baltic_Main',n,1000+n,1,'official','account.week'||n,true
from generate_series(1,5)n;
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
values('this-week-player','steam','this-week-match',(select week_end from public.pubg_ranking_week())+interval '1 minute','squad','Baltic_Main',30,9000,1,'official','account.thisweek',true);

do $$
declare a jsonb; row_payload jsonb; w record; key text; past_finalize boolean; refreshed integer;
begin
  select * into w from public.pubg_ranking_week();
  past_finalize:=clock_timestamp()>=w.finalize_at;
  if w.week_end-w.week_start<>interval '7 days' or extract(isodow from w.week_end at time zone 'Asia/Seoul')<>1
    or (w.week_end at time zone 'Asia/Seoul')::time<>'00:00' or w.finalize_at<>w.week_end+interval '1 day 9 hours' then
    raise exception 'FAIL: previous KST week bounds %', row_to_json(w);
  end if;
  if has_function_privilege('anon','public.refresh_pubg_rankings_cache()','execute')
    or has_function_privilege('anon','public.queue_pubg_ranking_refresh(text,text[],text,integer,integer,integer,integer)','execute')
    or has_function_privilege('anon','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
    or not has_function_privilege('service_role','public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer)','execute')
  then raise exception 'FAIL: ranking ACL'; end if;
  if not exists(select 1 from cron.job where jobname='bgms-pubg-rankings-refresh' and schedule='10 seconds') then
    raise exception 'FAIL: ranking refresh cron schedule';
  end if;

  -- 첫 요청은 집계하지 않고 등록만 한 뒤 준비 중으로 응답한다.
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',3,8,1,73);
  if not (a->>'pending')::boolean or a->'entries'<>'[]'::jsonb or (a->>'week_start')::timestamptz<>w.week_start then
    raise exception 'FAIL: first request should be pending %', a;
  end if;
  -- 예약 집계는 먼저 108개 조합을 등록만 하고(집계 0) 다음 실행부터 하나씩 채운다.
  refreshed:=public.refresh_pubg_rankings_cache();
  if refreshed<>0
    or (select count(*) from public.pubg_response_cache where cache_key like 'rankings:v2:%' and updated_at='-infinity'::timestamptz)<>108 then
    raise exception 'FAIL: seeding should register combinations without aggregating';
  end if;
  perform public.refresh_pubg_rankings_cache(); while public.refresh_pubg_rankings_cache()>0 loop end loop;
  if (select count(*) from public.pubg_response_cache where cache_key like 'rankings:v2:%' and updated_at>'-infinity'::timestamptz
      and expires_at>clock_timestamp())<>108 then
    raise exception 'FAIL: all filter combinations prebuilt';
  end if;
  a:=public.get_pubg_rankings_cached('damage',array['squad'],'all',3,8,1,73);
  if not (a->>'cache_hit')::boolean or (a->>'pending')::boolean or a ? 'params' or a ? 'requested_at'
    or a->'entries'->0->>'player_id'<>'week-player-5' or jsonb_array_length(a->'entries')<>5
    or (a->>'week_start')::timestamptz<>w.week_start or (a->>'week_end')::timestamptz<>w.week_end
    or (a->>'finalized')::boolean<>past_finalize then
    raise exception 'FAIL: previous week ranking %', a;
  end if;
  -- 기간을 주지 않는 기존 호출은 최근 7일을 유지한다.
  if not exists(select 1 from public.get_pubg_rankings('damage',array['squad'],'all',3,8,1,73) r where r.player_id='this-week-player') then
    raise exception 'FAIL: default seven day window';
  end if;
  if not (public.get_pubg_rankings_cached('damage',array['squad','squad-fpp'],'competitive',3,8,1,73)->>'cache_hit')::boolean then
    raise exception 'FAIL: a never-requested filter should already be served';
  end if;

  -- 이번 주 결과가 이미 있으면 다시 집계하지 않는다(확정 전이거나 이미 확정본).
  if public.refresh_pubg_rankings_cache()<>0 then raise exception 'FAIL: fresh ranking refreshed'; end if;
  -- 확정 시각이 지났는데 잠정 결과면 확정본으로 다시 집계한다.
  update public.pubg_response_cache set payload=jsonb_set(payload,'{finalized}','false')
  where cache_key=(select cache_key from public.pubg_response_cache where payload->'params'->>'tab'='damage' and payload->'params'->'modes'='["squad"]'::jsonb and payload->'params'->>'match_type'='all');
  if public.refresh_pubg_rankings_cache()<>(case when past_finalize then 1 else 0 end) then
    raise exception 'FAIL: finalize refresh';
  end if;

  -- 월요일에는 지난 2주 안에 조회된 조합을 이번 주 키로 미리 채운다.
  select cache_key,payload into key,row_payload from public.pubg_response_cache
  where payload->'params'->>'tab'='damage' and payload->'params'->'modes'='["squad"]'::jsonb and payload->'params'->>'match_type'='all';
  delete from public.pubg_response_cache where cache_key=key;
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  values('rankings:v2:previous-week-fixture',jsonb_set(row_payload,'{requested_at}',to_jsonb(clock_timestamp()-interval '3 days')),clock_timestamp()+interval '1 day',clock_timestamp()-interval '7 days');
  perform public.refresh_pubg_rankings_cache();
  refreshed:=public.refresh_pubg_rankings_cache();
  if refreshed<>1 or not exists(select 1 from public.pubg_response_cache where cache_key=key) then
    raise exception 'FAIL: prewarm current week from previous week request % %', refreshed, key;
  end if;
  raise notice 'PASS: previous week window, finalize and prewarm';
end $$;
rollback;

begin;
insert into public.system_settings(key,value) values('private_players_list','[]')
on conflict(key) do update set value=excluded.value;
delete from public.pubg_response_cache where cache_key like 'rankings:%';
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
select 'queue-player-'||n,'steam','queue-match-'||n,(select week_start from public.pubg_ranking_week())+interval '3 days','squad','Baltic_Main',n,500+n,1,'official','account.queue'||n,true
from generate_series(1,3)n;
do $$
declare a jsonb;
begin
  -- 요청 집계가 실패한 조합은 등록만 하고 내보내지 않으며 예약 집계가 먼저 채운다.
  perform public.queue_pubg_ranking_refresh('kills',array['squad','squad'],'all',3,8,1,73);
  perform public.refresh_pubg_rankings_cache();
  if public.refresh_pubg_rankings_cache()<>1 then raise exception 'FAIL: queued ranking not built'; end if;
  perform public.refresh_pubg_rankings_cache(); while public.refresh_pubg_rankings_cache()>0 loop end loop;
  a:=public.get_pubg_rankings_cached('kills',array['squad'],'all',3,8,1,73);
  if not (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'queue-player-3' then
    raise exception 'FAIL: queued ranking not served %', a;
  end if;
  -- 비공개 목록이 바뀌면 새 키로 다시 집계하고 요청은 비공개 대상이 빠진 결과를 읽는다.
  update public.system_settings set value='[{"platform":"steam","nickname":"queue-player-3","account_id":"account.queue3"}]' where key='private_players_list';
  a:=public.get_pubg_rankings_cached('kills',array['squad'],'all',3,8,1,73);
  if not (a->>'pending')::boolean then raise exception 'FAIL: privacy change should not serve the old key %', a; end if;
  perform public.refresh_pubg_rankings_cache(); while public.refresh_pubg_rankings_cache()>0 loop end loop;
  a:=public.get_pubg_rankings_cached('kills',array['squad'],'all',3,8,1,73);
  if not (a->>'cache_hit')::boolean or a->'entries'->0->>'player_id'<>'queue-player-2' then
    raise exception 'FAIL: private player in refreshed ranking %', a;
  end if;
  -- 30초 작업 실행 기록은 하루치만 남긴다.
  insert into cron.job_run_details select jobid,now()-interval '2 days' from cron.job where jobname='bgms-pubg-rankings-refresh';
  insert into cron.job_run_details select jobid,now()-interval '2 hours' from cron.job where jobname='bgms-pubg-rankings-refresh';
  perform bgms_private.cleanup_pubg_collection_clock_logs();
  if (select count(*) from cron.job_run_details d join cron.job j using(jobid) where j.jobname='bgms-pubg-rankings-refresh')<>1 then
    raise exception 'FAIL: ranking refresh logs retention';
  end if;
  raise notice 'PASS: previous week rankings, finalize, prewarm, queue, privacy and ACL';
end $$;
rollback;
