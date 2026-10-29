-- 일회용 검증 DB에서만 실행한다. 벤치마커 명단 권한과 은퇴 후 정리 RPC를 확인한다.
begin;
-- 검증용 prerequisites 의 축약 테이블에 운영 컬럼을 맞춘다(트랜잭션과 함께 되돌린다).
alter table public.match_stats_raw add column if not exists platform text;
alter table public.match_stats_raw add column if not exists player_id text;
alter table public.match_stats_raw add column if not exists is_analysis_sample boolean;
alter table public.pubg_player_matches add column if not exists account_id text;
alter table public.pubg_player_matches add column if not exists retention_scope text not null default 'detail';

do $$
begin
  if has_table_privilege('anon', 'public.pubg_benchmark_cohort', 'select')
    or has_table_privilege('authenticated', 'public.pubg_benchmark_cohort', 'select')
    or not has_table_privilege('service_role', 'public.pubg_benchmark_cohort', 'insert')
    or has_function_privilege('anon', 'public.cleanup_retired_benchmark_cohort(timestamptz,boolean,integer)', 'execute')
    or has_function_privilege('authenticated', 'public.cleanup_retired_benchmark_cohort(timestamptz,boolean,integer)', 'execute')
    or not has_function_privilege('service_role', 'public.cleanup_retired_benchmark_cohort(timestamptz,boolean,integer)', 'execute')
    or not (select relrowsecurity from pg_class where oid = 'public.pubg_benchmark_cohort'::regclass) then
    raise exception 'FAIL: benchmark cohort ACL';
  end if;
  begin
    insert into public.pubg_benchmark_cohort(platform, account_id, nickname, source_shard, source_season_id, source_game_mode)
    values ('steam', 'not-an-account', 'x', 'pc-as', 's', 'squad');
    raise exception 'FAIL: invalid account id accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.cleanup_retired_benchmark_cohort(now(), false, 10);
    raise exception 'FAIL: recent cutoff accepted';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS: benchmark cohort ACL and guards';
end $$;

insert into public.pubg_benchmark_cohort(platform, account_id, nickname, collected_player_ids, source_shard, source_season_id, source_game_mode, retired_at)
values
  -- 은퇴 후 기준일이 지난 미검색 벤치마커(이름 변경 이력 포함)
  ('steam', 'account.retired', 'NewName', '{oldname,newname}', 'pc-as', 'season-1', 'squad', now() - interval '200 days'),
  -- 은퇴했지만 사용자가 검색한 플레이어: 데이터는 두고 명단만 지운다.
  ('steam', 'account.searched', 'Searched', '{searched}', 'pc-as', 'season-1', 'squad', now() - interval '200 days'),
  -- 아직 기준일이 지나지 않은 은퇴자와 현역은 건드리지 않는다.
  ('steam', 'account.recent', 'Recent', '{recent}', 'pc-as', 'season-1', 'squad', now() - interval '10 days'),
  ('steam', 'account.active', 'Active', '{active}', 'pc-as', 'season-1', 'squad', null);

insert into public.processed_match_telemetry(match_id, platform, player_id, data) values
  ('bc-1', 'steam', 'oldname', '{"fullResult":{"stats":{"playerId":"account.retired"}}}'),
  ('bc-2', 'steam', 'newname', '{"fullResult":{"stats":{"playerId":"account.retired"}}}'),
  -- 같은 옛 이름을 나중에 쓴 다른 계정의 분석 행은 남는다.
  ('bc-9', 'steam', 'oldname', '{"fullResult":{"stats":{"playerId":"account.other"}}}'),
  ('bc-3', 'steam', 'searched', '{"fullResult":{"stats":{"playerId":"account.searched"}}}'),
  ('bc-4', 'steam', 'recent', '{"fullResult":{"stats":{"playerId":"account.recent"}}}');
insert into public.global_benchmarks(match_id, platform, player_id, game_mode, match_type, tier, damage, source) values
  ('bc-1', 'steam', 'oldname', 'squad', 'official', 'A', 300, 'scraper'),
  ('bc-2', 'steam', 'newname', 'squad', 'official', 'A', 500, 'scraper'),
  ('bc-3', 'steam', 'searched', 'squad', 'official', 'A', 200, 'scraper'),
  ('bc-3b', 'steam', 'searched', 'squad', 'official', 'B', 100, 'user'),
  ('bc-4', 'steam', 'recent', 'squad', 'official', 'A', 100, 'scraper');
insert into public.weapon_meta_match_samples(match_id, platform, player_id, played_at, patch_version, weapon_category, weapon_name) values
  ('bc-1', 'steam', 'oldname', now() - interval '200 days', 'p', 'AR', 'M416'),
  ('bc-1', 'steam', 'oldname', now() - interval '200 days', 'p', 'DMR', 'Mini14');
insert into public.match_stats_raw(match_id, platform, player_id, is_analysis_sample) values
  ('bc-2', 'steam', 'newname', true);
insert into public.pubg_player_matches(player_id, platform, match_id, played_at, game_mode, map_name, account_id, retention_scope) values
  ('newname', 'steam', 'bc-2', now() - interval '200 days', 'squad', 'Baltic_Main', 'account.retired', 'detail'),
  -- 상세 범위가 아닌 참가자 행은 별도 보존 정책을 따른다.
  ('newname', 'steam', 'bc-8', now() - interval '200 days', 'squad', 'Baltic_Main', 'account.retired', 'basic_only');
insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, search_count) values
  ('account.retired', 'NewName', 'newname', 'steam', 0),
  ('account.searched', 'Searched', 'searched', 'steam', 3);

do $$
declare
  dry jsonb;
  applied jsonb;
  pseudonym text;
begin
  dry := public.cleanup_retired_benchmark_cohort(now() - interval '90 days', false, 10);
  if (dry->>'dry_run')::boolean is not true
    or (dry->>'candidate_players')::int <> 2
    or (dry->>'searched_players_kept')::int <> 1
    or (dry->>'processed_match_telemetry')::int <> 2
    or (dry->>'global_benchmarks_pseudonymized')::int <> 2
    or (dry->>'weapon_meta_match_samples_pseudonymized')::int <> 2
    or (dry->>'match_stats_raw_pseudonymized')::int <> 1
    or (dry->>'pubg_player_matches')::int <> 1
    or (dry->>'pubg_player_cache')::int <> 1
    or (dry->>'cohort_rows_deleted')::int <> 0
    or (dry->>'remaining_candidates')::int <> 2 then
    raise exception 'FAIL: dry-run summary %', dry;
  end if;
  if (select count(*) from public.processed_match_telemetry where match_id like 'bc-%') <> 5
    or (select count(*) from public.pubg_benchmark_cohort) <> 4
    or exists (select 1 from public.global_benchmarks where player_id like 'retired:%') then
    raise exception 'FAIL: dry-run wrote data';
  end if;
  raise notice 'PASS: benchmark cohort cleanup dry-run only counts';

  applied := public.cleanup_retired_benchmark_cohort(now() - interval '90 days', true, 10);
  if (applied->>'dry_run')::boolean is not false
    or (applied->>'processed_match_telemetry')::int <> 2
    or (applied->>'cohort_rows_deleted')::int <> 2
    or (applied->>'remaining_candidates')::int <> 0 then
    raise exception 'FAIL: apply summary %', applied;
  end if;
  if exists (select 1 from public.processed_match_telemetry where match_id in ('bc-1', 'bc-2'))
    or not exists (select 1 from public.processed_match_telemetry where match_id = 'bc-9')
    or exists (select 1 from public.global_benchmarks where player_id in ('oldname', 'newname'))
    or (select count(*) from public.global_benchmarks where player_id like 'retired:%') <> 2
    or exists (select 1 from public.weapon_meta_match_samples where player_id = 'oldname')
    or exists (select 1 from public.match_stats_raw where player_id = 'newname')
    or exists (select 1 from public.pubg_player_matches where match_id = 'bc-2')
    or not exists (select 1 from public.pubg_player_matches where match_id = 'bc-8')
    or exists (select 1 from public.pubg_player_cache where id = 'account.retired') then
    raise exception 'FAIL: retired benchmarker identity remained';
  end if;
  -- 같은 경기의 표본끼리만 같은 임의 값을 쓰고, 다른 경기와는 연결되지 않는다.
  select player_id into pseudonym from public.global_benchmarks where match_id = 'bc-1';
  if (select count(distinct player_id) from public.weapon_meta_match_samples where match_id = 'bc-1') <> 1
    or (select player_id from public.weapon_meta_match_samples where match_id = 'bc-1' limit 1) <> pseudonym
    or pseudonym = (select player_id from public.global_benchmarks where match_id = 'bc-2')
    or (select damage from public.global_benchmarks where match_id = 'bc-2') <> 500 then
    raise exception 'FAIL: pseudonymized samples lost values or linked matches';
  end if;
  -- 검색된 플레이어는 데이터가 남고 명단 행만 지워진다. 기준일 전 은퇴자와 현역은 그대로다.
  if not exists (select 1 from public.processed_match_telemetry where match_id = 'bc-3')
    or not exists (select 1 from public.global_benchmarks where match_id = 'bc-3' and player_id = 'searched')
    or exists (select 1 from public.pubg_benchmark_cohort where account_id in ('account.retired', 'account.searched'))
    or (select count(*) from public.pubg_benchmark_cohort where account_id in ('account.recent', 'account.active')) <> 2
    or not exists (select 1 from public.processed_match_telemetry where match_id = 'bc-4') then
    raise exception 'FAIL: searched/recent/active members were cleaned';
  end if;
  raise notice 'PASS: benchmark cohort cleanup removes identity and keeps aggregate samples';
end $$;
rollback;
