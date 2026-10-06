begin;
insert into public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,
score,tier,benchmark,ranking_eligible,calculated_at) values
('steam','account.retained','retained-old','retained',2,73,80,'A','{"score":80,"tier":"A"}',true,now()-interval '400 days');
do $$ declare n integer; r record; j public.pubg_performance_jobs; c jsonb; begin
  select * into r from public.cleanup_pubg_performance_retention(90);
  if r.performance_rows<>0 then raise exception 'Historical performance deleted'; end if;
  select count(*) into n from public.pubg_match_performance where match_id='retained-old';
  if n<>1 then raise exception 'Old performance missing'; end if;
  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version)
  values('steam','account.retained','retained-no-tier','retained',2,73);
  select * into j from public.claim_pubg_performance_job(10);
  c := jsonb_build_object('platform',j.platform,'account_id',j.account_id,'match_id',j.match_id,'player_id',j.player_id,
    'calculation_version',j.calculation_version,'result_version',j.result_version,'summary_version',1,
    'source_checksum',repeat('a',64),'played_at',now()-interval '20 days',
    'ranking_eligible',false,'summary',jsonb_build_object('matchId',j.match_id,'stats',jsonb_build_object('playerId',j.account_id)));
  if not public.finish_pubg_performance_job(j.lease_token,'excluded',jsonb_build_object('retainedPerformance',c))
    then raise exception 'Excluded compact not finalized'; end if;
  select count(*) into n from public.pubg_match_performance where match_id=j.match_id and summary_version=1
    and ranking_eligible=false and score is null and benchmark is null;
  if n<>1 then raise exception 'Unranked performance not preserved'; end if;
  if has_function_privilege('anon','public.finish_pubg_performance_job(uuid,text,jsonb,text)','execute')
    or has_table_privilege('authenticated','public.pubg_match_performance','select') then raise exception 'Private performance exposed'; end if;
end $$;
rollback;
