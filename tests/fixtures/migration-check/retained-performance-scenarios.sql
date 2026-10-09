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

-- Global preservation is bounded by the cleanup cursor and canonical match rows.
update public.pubg_archive_cleanup_cursor
set played_at = now() - interval '60 days', platform = 'steam', match_id = 'ret-cursor-anchor',
    generation = generation + 1, updated_at = now()
where id = 1;

insert into public.pubg_player_matches
  (player_id, platform, match_id, played_at, game_mode, map_name, account_id, ranking_eligible)
values
  ('ret-global-a', 'steam', 'ret-global-a', now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retaineda', true),
  ('ret-global-b', 'steam', 'ret-global-b', now() - interval '29 days', 'squad', 'Baltic_Main', 'account.retainedb', true),
  ('ret-before-cursor', 'steam', 'ret-before-cursor', now() - interval '70 days', 'squad', 'Baltic_Main', 'account.retainedbefore', true),
  ('ret-recent', 'steam', 'ret-recent', now() - interval '2 days', 'squad', 'Baltic_Main', 'account.retainedrecent', true),
  ('ret-saved', 'steam', 'ret-saved', now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retainedsaved', true),
  ('ret-invalid-account', 'steam', 'ret-invalid-account', now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retainedbadaccount', true),
  ('ret-invalid-v', 'steam', 'ret-invalid-v', now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retainedbadv', true),
  ('ret-invalid-calculation', 'steam', 'ret-invalid-calculation', now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retainedbadcalc', true),
  ('ret-invalid-name', 'steam', 'ret-invalid-name', now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retainedbadname', true);

insert into public.processed_match_telemetry(match_id, platform, player_id, data) values
  ('ret-global-a', 'steam', 'ret-global-a', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-global-a', 'platform', 'steam', 'player_id', 'ret-global-a', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retaineda', 'name', 'ret-global-a')))),
  ('ret-global-b', 'steam', 'ret-global-b', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-global-b', 'platform', 'steam', 'player_id', 'ret-global-b', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retainedb', 'name', 'ret-global-b')))),
  ('ret-before-cursor', 'steam', 'ret-before-cursor', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-before-cursor', 'platform', 'steam', 'player_id', 'ret-before-cursor', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retainedbefore', 'name', 'ret-before-cursor')))),
  ('ret-recent', 'steam', 'ret-recent', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-recent', 'platform', 'steam', 'player_id', 'ret-recent', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retainedrecent', 'name', 'ret-recent')))),
  -- A copy on another platform must not be selected through the Steam source row.
  ('ret-global-a', 'kakao', 'ret-global-a', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-global-a', 'platform', 'kakao', 'player_id', 'ret-global-a', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retaineda', 'name', 'ret-global-a')))),
  ('ret-saved', 'steam', 'ret-saved', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-saved', 'platform', 'steam', 'player_id', 'ret-saved', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retainedsaved', 'name', 'ret-saved')))),
  ('ret-invalid-account', 'steam', 'ret-invalid-account', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-invalid-account', 'platform', 'steam', 'player_id', 'ret-invalid-account', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'not-an-account', 'name', 'ret-invalid-account')))),
  ('ret-invalid-v', 'steam', 'ret-invalid-v', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-invalid-v', 'platform', 'steam', 'player_id', 'ret-invalid-v', 'v', '73x', 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retainedbadv', 'name', 'ret-invalid-v')))),
  ('ret-invalid-calculation', 'steam', 'ret-invalid-calculation', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-invalid-calculation', 'platform', 'steam', 'player_id', 'ret-invalid-calculation', 'v', 73, 'calculationVersion', '2x',
    'stats', jsonb_build_object('playerId', 'account.retainedbadcalc', 'name', 'ret-invalid-calculation')))),
  ('ret-invalid-name', 'steam', 'ret-invalid-name', jsonb_build_object('fullResult', jsonb_build_object(
    'matchId', 'ret-invalid-name', 'platform', 'steam', 'player_id', 'ret-invalid-name', 'v', 73, 'calculationVersion', 2,
    'stats', jsonb_build_object('playerId', 'account.retainedbadname', 'name', 'different-name'))));

insert into public.pubg_match_performance
  (platform, account_id, match_id, player_id, calculation_version, result_version,
   score, tier, benchmark, ranking_eligible, summary, played_at, summary_version, source_checksum)
values
  ('steam', 'account.retainedsaved', 'ret-saved', 'ret-saved', 2, 73,
   null, null, null, false,
   jsonb_build_object('matchId', 'ret-saved', 'stats', jsonb_build_object('playerId', 'account.retainedsaved')),
   now() - interval '30 days', 1, repeat('a', 64));

do $$
declare
  n integer;
  before_cursor jsonb;
  after_cursor jsonb;
  rpc_definition text;
begin
  if to_regprocedure('public.list_unretained_match_performance(integer,text)') is null then
    raise exception 'list_unretained_match_performance(integer,text) is missing';
  end if;
  if has_function_privilege('anon','public.list_unretained_match_performance(integer,text)','execute')
    or has_function_privilege('authenticated','public.list_unretained_match_performance(integer,text)','execute')
    or not has_function_privilege('service_role','public.list_unretained_match_performance(integer,text)','execute') then
    raise exception 'retained performance listing must be service-only';
  end if;
  select pg_get_functiondef('public.list_unretained_match_performance(integer,text)'::regprocedure)
    into rpc_definition;
  if position('MATERIALIZED' in upper(rpc_definition)) = 0 then
    raise exception 'global source scope must materialize its bounded telemetry read';
  end if;

  select to_jsonb(c) into before_cursor from public.pubg_archive_cleanup_cursor c where id = 1;
  select count(*) into n from public.list_unretained_match_performance(1000, null)
    where platform = 'steam' and match_id in ('ret-global-a', 'ret-global-b');
  if n <> 2 then raise exception 'expected the two canonical expired matches, got %', n; end if;
  if exists(select from public.list_unretained_match_performance(1000, null)
      where match_id in ('ret-before-cursor','ret-recent','ret-saved','ret-invalid-account',
                         'ret-invalid-v','ret-invalid-calculation','ret-invalid-name')
        or (match_id='ret-global-a' and platform<>'steam')) then
    raise exception 'global query escaped cursor, age, platform, retention, or identity validation';
  end if;
  select to_jsonb(c) into after_cursor from public.pubg_archive_cleanup_cursor c where id = 1;
  if after_cursor is distinct from before_cursor then
    raise exception 'listing RPC must not advance or modify the cleanup cursor';
  end if;

  -- Explicit nickname scans preserve the previous behavior outside global age/cursor bounds.
  select count(*) into n from public.list_unretained_match_performance(1000, ' RET-RECENT ')
    where match_id = 'ret-recent' and platform = 'steam';
  if n <> 1 then raise exception 'scoped nickname query must still include recent matches'; end if;
  select count(*) into n from public.list_unretained_match_performance(1000, 'ret-before-cursor')
    where match_id = 'ret-before-cursor' and platform = 'steam';
  if n <> 1 then raise exception 'scoped nickname query must still include rows before the global cursor'; end if;
  select count(*) into n from public.list_unretained_match_performance(1000, 'ret-saved');
  if n <> 0 then raise exception 'scoped query must continue excluding already retained versions'; end if;
end $$;

-- The default global batch is the first 100 canonical rows in cleanup order.
delete from public.processed_match_telemetry where match_id like 'ret-%';
delete from public.pubg_player_matches where match_id like 'ret-%';
delete from public.pubg_match_performance where match_id like 'ret-%';
insert into public.pubg_player_matches
  (player_id, platform, match_id, played_at, game_mode, map_name, account_id, ranking_eligible)
select 'ret-cap-' || lpad(i::text, 3, '0'), 'steam', 'ret-cap-' || lpad(i::text, 3, '0'),
       now() - interval '30 days', 'squad', 'Baltic_Main', 'account.retcap' || i, true
from generate_series(1, 101) as g(i);
insert into public.processed_match_telemetry(match_id, platform, player_id, data)
select 'ret-cap-' || lpad(i::text, 3, '0'), 'steam', 'ret-cap-' || lpad(i::text, 3, '0'),
       jsonb_build_object('fullResult', jsonb_build_object(
         'matchId', 'ret-cap-' || lpad(i::text, 3, '0'), 'platform', 'steam',
         'player_id', 'ret-cap-' || lpad(i::text, 3, '0'), 'v', 73, 'calculationVersion', 2,
         'stats', jsonb_build_object('playerId', 'account.retcap' || i,
                                     'name', 'ret-cap-' || lpad(i::text, 3, '0'))))
from generate_series(1, 101) as g(i);
do $$ declare n integer; begin
  select count(*) into n from public.list_unretained_match_performance(1000, null)
    where match_id like 'ret-cap-%';
  if n <> 100 then raise exception 'global scan must cap its canonical batch at 100 rows, got %', n; end if;
  if not exists(select from public.list_unretained_match_performance(1000, null) where match_id='ret-cap-001')
    or exists(select from public.list_unretained_match_performance(1000, null) where match_id='ret-cap-101') then
    raise exception 'global batch did not preserve the first 100 rows in canonical order';
  end if;
end $$;

-- A scoped fixture bypasses the global 100-row source window and reaches the RPC hard cap.
insert into public.processed_match_telemetry(match_id, platform, player_id, data)
select 'ret-limit-' || lpad(i::text, 4, '0'), 'steam', 'ret-limit',
       jsonb_build_object('fullResult', jsonb_build_object(
         'matchId', 'ret-limit-' || lpad(i::text, 4, '0'), 'platform', 'steam',
         'player_id', 'ret-limit', 'v', 73, 'calculationVersion', 2,
         'stats', jsonb_build_object('playerId', 'account.retlimit', 'name', 'ret-limit')))
from generate_series(1, 1001) as g(i);
do $$ declare n integer; begin
  select count(*) into n from public.list_unretained_match_performance(5000, 'ret-limit');
  if n <> 1000 then raise exception 'RPC hard limit must clamp p_limit to 1000 rows, got %', n; end if;
end $$;

rollback;
