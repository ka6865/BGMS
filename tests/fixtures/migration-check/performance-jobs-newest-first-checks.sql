-- 성과 작업은 최근 경기부터 처리하고, 하루 상한은 300까지 허용한다.
begin;
do $$
declare j public.pubg_performance_jobs; n integer;
begin
  delete from public.pubg_performance_jobs;
  delete from public.pubg_performance_budget;
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible) values
    ('newest','steam','perf-order-new',now()-interval '1 hour','duo','Baltic_Main',1,100,5,'competitive','account.perforder',true),
    ('newest','steam','perf-order-old',now()-interval '6 days','duo','Baltic_Main',1,100,5,'competitive','account.perforder',true);
  -- 오래된 경기가 먼저 예약돼 있어도 최근 경기를 먼저 가져간다.
  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,next_attempt_at) values
    ('steam','account.perforder','perf-order-old','newest',3,73,now()-interval '1 day'),
    ('steam','account.perforder','perf-order-new','newest',3,73,now());
  select * into j from public.claim_pubg_performance_job(300);
  if j.match_id is distinct from 'perf-order-new' then raise exception 'newest match not claimed first: %', j.match_id; end if;
  if not public.finish_pubg_performance_job(j.lease_token,'done','{"benchmark":{"score":50,"tier":"B"},"rankingEligible":true}',null) then
    raise exception 'finish failed';
  end if;
  -- 하루 상한 300 까지 허용, 그 이상은 막는다.
  update public.pubg_performance_budget set used=299 where day=(now() at time zone 'UTC')::date;
  select * into j from public.claim_pubg_performance_job(1000);
  if j.match_id is distinct from 'perf-order-old' then raise exception 'cap below 300 or old job not claimed'; end if;
  perform public.finish_pubg_performance_job(j.lease_token,'done','{"benchmark":{"score":40,"tier":"C"},"rankingEligible":true}',null);
  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version)
    values ('steam','account.perforder','perf-order-extra','newest',3,73);
  select count(*) into n from public.claim_pubg_performance_job(1000);
  if n<>0 then raise exception 'daily cap 300 not enforced'; end if;
  if has_function_privilege('anon','public.claim_pubg_performance_job(integer)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_pubg_performance_job(integer)','EXECUTE') then
    raise exception 'claim function ACL changed';
  end if;
end;
$$;
rollback;
