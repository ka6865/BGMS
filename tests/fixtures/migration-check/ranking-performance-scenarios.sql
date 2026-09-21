begin;
-- More than 500 rows for one account must not hide other candidates. Names on
-- different platforms and verified account renames remain correctly separated.
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
select 'same','steam','ranking-spam-'||n,now()-interval '1 day','squad','Baltic_Main',10,2000,1,'official','account.ranksteam',true from generate_series(1,510) n;
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible) values
('same','kakao','rank-kakao',now()-interval '2 days','squad','Baltic_Main',5,800,1,'official','account.rankkakao',true),
('renamed','steam','rank-rename',now()-interval '1 day','squad','Baltic_Main',20,3000,1,'official','account.ranksteam',true),
('too-old','steam','rank-old',now()-interval '8 days','squad','Baltic_Main',99,9999,1,'official','account.rankold',true),
('event','steam','rank-event',now(),'squad','Baltic_Main',99,9999,1,'event','account.rankevent',false);
-- Pre-migration rows can lack account_id. The discovery identity must still
-- group and hide a renamed private account's historical alias.
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
values ('old-private-name','steam','rank-private-legacy',now()-interval '1 day','squad','Baltic_Main',30,4000,1,'official',null,true);
insert into public.pubg_player_match_discovery(platform,account_id,match_id,nickname_at_discovery,state)
values ('steam','account.ranksteam','rank-private-legacy','current-private-name','saved');
-- A newer legacy row can have no account_id or discovery record yet, while
-- the player cache already knows the current nickname's stable account.
insert into public.pubg_player_cache(id,platform,nickname,lower_nickname,updated_at,last_seen_at,search_count)
values ('account.ranksteam','steam','current-private-name','current-private-name',now(),now(),1)
on conflict (id) do update set nickname=excluded.nickname,lower_nickname=excluded.lower_nickname,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at;
insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible)
values ('current-private-name','steam','rank-private-cache-legacy',now()-interval '1 day','squad','Baltic_Main',25,3500,1,'official',null,true);
do $$ declare n integer; v double precision; begin
  select count(*) into n from public.get_pubg_rankings('damage',array['squad'],'all',2,8,1,73,'{}');
  if n<>4 then raise exception 'Expected two accounts and two legacy aliases, got %',n; end if;
  select value into v from public.get_pubg_rankings('damage',array['squad'],'all',2,8,1,73,'{}') where platform='steam';
  if v<>4000 then raise exception 'Wrong highest match';end if;
  select count(*) into n from public.get_pubg_rankings('damage',array['squad'],'all',2,8,1,73,array['kakao:same']);
  if n<>3 then raise exception 'Platform nickname private exclusion failed';end if;
  select count(*) into n from public.get_pubg_rankings('damage',array['squad'],'all',2,8,1,73,array['steam:account:account.ranksteam']);
  if n<>1 then raise exception 'Account ID and legacy alias private exclusion failed';end if;
end $$;
insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version) values ('steam','account.ranksteam','rank-rename','renamed',2,73),('kakao','account.rankkakao','rank-kakao','same',2,73);
do $$ declare j public.pubg_performance_jobs;n integer;ok boolean; begin
  select * into j from public.claim_pubg_performance_job(1);
  if j.lease_token is null then raise exception 'Claim failed';end if;
  select count(*) into n from public.claim_pubg_performance_job(1);
  if n<>0 then raise exception 'Concurrent/budget bypass';end if;
  select public.finish_pubg_performance_job(j.lease_token,'done','{"benchmark":{"score":82,"tier":"S"},"rankingEligible":true}',null) into ok;
  if not ok then raise exception 'Finish failed';end if;
  if public.finish_pubg_performance_job(j.lease_token,'retry',null,null) then raise exception 'Lease reused';end if;
  select count(*) into n from public.claim_pubg_performance_job(1);
  if n<>0 then raise exception 'Daily budget bypass';end if;
  select count(*) into n from public.get_pubg_rankings('tier',array['squad'],'all',2,8,1,73,'{}');
  if n<>1 then raise exception 'Automatic score not ranked';end if;
end $$;
-- Queue repair counts a currently running lease within the same global cap.
insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version)
select 'steam','account.queue','queue-'||n,'queue',2,73 from generate_series(1,400) n;
insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,state,lease_token,lease_expires_at)
values ('steam','account.queue','queue-running','queue',2,73,'running',gen_random_uuid(),now()+interval '5 minutes');
select public.seed_pubg_performance_jobs(2,73);
do $$ declare n integer; begin
 select count(*) into n from public.pubg_performance_jobs where state in ('pending','retry','running');
 if n>300 then raise exception 'Queue cap exceeded: %',n; end if;
end $$;
-- Retention is bounded and preserves pending work even if its timestamp is old.
insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,state,updated_at)
select 'steam','account.cleanup','cleanup-'||n,'cleanup',2,73,'done',now()-interval '91 days' from generate_series(1,501) n;
do $$ declare r record; n integer; begin
 select * into r from public.cleanup_pubg_performance_retention(90);
 if r.job_rows<>500 then raise exception 'Unbounded cleanup: %',r.job_rows; end if;
 select count(*) into n from public.pubg_performance_jobs where match_id like 'cleanup-%';
 if n<>1 then raise exception 'Cleanup remainder missing'; end if;
end $$;
rollback;
