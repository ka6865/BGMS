-- Runs only in the verifier's disposable PostgreSQL database.
begin;
delete from public.pubg_team_benchmarks;
create temporary table team_fixture(match_id text, player_id text, mode text, calc integer, status text, team jsonb, knocks integer, revives integer, trades integer, latency integer, smokes integer);
insert into team_fixture values
  -- 같은 스쿼드 팀 경기를 팀원 두 명이 저장해도 한 번만 센다.
  ('tb-1','player_a','squad',3,'observed','["a","b"]',4,2,1,6000,1),
  ('tb-1','player_b','squad',3,'observed','["a","b"]',4,2,1,6000,1),
  ('tb-2','player_a','squad-fpp',3,'observed','["a","c"]',2,0,1,4000,null),
  ('tb-3','player_a','duo',3,'observed','["a","d"]',3,1,0,0,0),
  -- 관측 실패·다른 계산 버전·솔로는 섞지 않는다.
  ('tb-4','player_a','squad',3,'missing','["a","b"]',9,9,9,9000,9),
  ('tb-5','player_a','squad',2,'observed','["a","b"]',5,1,1,1000,0),
  ('tb-6','player_a','solo',3,'observed','["a"]',7,7,7,7000,7);
insert into public.processed_match_telemetry(match_id, platform, player_id, data)
select match_id, 'steam', player_id, jsonb_build_object('fullResult', jsonb_build_object(
  'gameMode', mode, 'calculationVersion', calc,
  'squadObservation', jsonb_build_object('version', 1, 'scope', 'squad', 'status', status, 'teamAccountIds', team,
    'knocks', knocks, 'revives', revives, 'tradeKills', trades, 'tradeLatencyTotalMs', latency, 'smokeRescues', smokes)))
from team_fixture;

do $$
declare squad record; duo record; legacy record;
begin
  if has_function_privilege('anon','public.refresh_pubg_team_benchmarks()','execute')
    or not has_function_privilege('service_role','public.refresh_pubg_team_benchmarks()','execute')
    or has_table_privilege('anon','public.pubg_team_benchmarks','insert')
    or not has_table_privilege('anon','public.pubg_team_benchmarks','select') then
    raise exception 'FAIL: team benchmark ACL';
  end if;
  if not exists(select 1 from cron.job where jobname='bgms-pubg-team-benchmarks-refresh' and command='select public.refresh_pubg_team_benchmarks();') then
    raise exception 'FAIL: team benchmark cron';
  end if;
  if public.refresh_pubg_team_benchmarks() <> 3 then raise exception 'FAIL: team benchmark rows'; end if;
  select * into squad from public.pubg_team_benchmarks where team_mode='squad' and calculation_version=3;
  select * into duo from public.pubg_team_benchmarks where team_mode='duo' and calculation_version=3;
  select * into legacy from public.pubg_team_benchmarks where team_mode='squad' and calculation_version=2;
  if squad.sample_team_matches <> 2 or squad.knocks <> 6 or squad.revives <> 2 or squad.trade_kills <> 2
    or squad.trade_latency_total_ms <> 10000 or squad.smoke_sample_team_matches <> 1 or squad.smoke_knocks <> 4 or squad.smoke_rescues <> 1 then
    raise exception 'FAIL: squad team benchmark %', row_to_json(squad);
  end if;
  if duo.sample_team_matches <> 1 or duo.knocks <> 3 or duo.revives <> 1 then raise exception 'FAIL: duo team benchmark %', row_to_json(duo); end if;
  if legacy.sample_team_matches <> 1 or legacy.knocks <> 5 then raise exception 'FAIL: calculation version separation %', row_to_json(legacy); end if;
  -- 다시 실행하면 같은 값으로 갱신한다.
  perform public.refresh_pubg_team_benchmarks();
  if (select count(*) from public.pubg_team_benchmarks) <> 3 then raise exception 'FAIL: team benchmark refresh duplicated'; end if;
  raise notice 'PASS: team benchmark population, deduplication, versions and ACL';
end $$;
rollback;
