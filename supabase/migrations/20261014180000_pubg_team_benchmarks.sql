-- 팀 분석(듀오·스쿼드)의 비교 기준. 개인 지표가 아니라 팀 관측(squadObservation)만 모은다.
-- 같은 팀 경기는 팀원 수만큼 저장되므로 (platform, match_id, teamAccountIds)로 한 번만 센다.
-- 계산 버전·관측 버전이 다른 결과는 섞지 않는다. 표본 수 기준은 앱이 판단한다.
create table if not exists public.pubg_team_benchmarks (
  team_mode text not null check (team_mode in ('duo', 'squad')),
  calculation_version integer not null,
  observation_version integer not null,
  sample_team_matches integer not null check (sample_team_matches >= 0),
  knocks bigint not null check (knocks >= 0),
  revives bigint not null check (revives >= 0),
  trade_kills bigint not null check (trade_kills >= 0),
  trade_latency_total_ms bigint not null check (trade_latency_total_ms >= 0),
  smoke_sample_team_matches integer not null check (smoke_sample_team_matches >= 0),
  smoke_knocks bigint not null check (smoke_knocks >= 0),
  smoke_rescues bigint not null check (smoke_rescues >= 0),
  refreshed_at timestamptz not null default now(),
  primary key (team_mode, calculation_version, observation_version)
);

alter table public.pubg_team_benchmarks enable row level security;
revoke all on table public.pubg_team_benchmarks from public, anon, authenticated;
-- 집계값만 담겨 공개해도 되며, 팀 분석은 요청자 세션 클라이언트로 읽는다.
grant select on table public.pubg_team_benchmarks to anon, authenticated;
grant select, insert, update, delete on table public.pubg_team_benchmarks to service_role;
drop policy if exists "Team benchmarks are readable" on public.pubg_team_benchmarks;
create policy "Team benchmarks are readable" on public.pubg_team_benchmarks for select to anon, authenticated using (true);

create or replace function public.refresh_pubg_team_benchmarks()
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  refreshed integer;
begin
  with observed as (
    select distinct on (p.platform, p.match_id, p.data->'fullResult'->'squadObservation'->'teamAccountIds')
      case when p.data->'fullResult'->>'gameMode' in ('duo', 'duo-fpp') then 'duo' else 'squad' end as team_mode,
      (p.data->'fullResult'->>'calculationVersion')::integer as calculation_version,
      (p.data->'fullResult'->'squadObservation'->>'version')::integer as observation_version,
      p.data->'fullResult'->'squadObservation' as observation
    from public.processed_match_telemetry as p
    where p.data->'fullResult'->'squadObservation'->>'status' = 'observed'
      and p.data->'fullResult'->>'gameMode' in ('duo', 'duo-fpp', 'squad', 'squad-fpp')
      and p.data->'fullResult'->>'calculationVersion' ~ '^[0-9]+$'
      and p.data->'fullResult'->'squadObservation'->>'version' ~ '^[0-9]+$'
    order by p.platform, p.match_id, p.data->'fullResult'->'squadObservation'->'teamAccountIds', p.updated_at desc
  ), totals as (
    select team_mode, calculation_version, observation_version,
      count(*)::integer as sample_team_matches,
      sum((observation->>'knocks')::bigint) as knocks,
      sum((observation->>'revives')::bigint) as revives,
      sum((observation->>'tradeKills')::bigint) as trade_kills,
      sum((observation->>'tradeLatencyTotalMs')::bigint) as trade_latency_total_ms,
      -- 연막 구출은 관측이 완전한 경기만 따로 센다(null 은 측정 불가).
      count(*) filter (where observation->>'smokeRescues' is not null)::integer as smoke_sample_team_matches,
      coalesce(sum((observation->>'knocks')::bigint) filter (where observation->>'smokeRescues' is not null), 0) as smoke_knocks,
      coalesce(sum((observation->>'smokeRescues')::bigint), 0) as smoke_rescues
    from observed
    group by team_mode, calculation_version, observation_version
  )
  insert into public.pubg_team_benchmarks as b (team_mode, calculation_version, observation_version, sample_team_matches,
    knocks, revives, trade_kills, trade_latency_total_ms, smoke_sample_team_matches, smoke_knocks, smoke_rescues, refreshed_at)
  select team_mode, calculation_version, observation_version, sample_team_matches,
    knocks, revives, trade_kills, trade_latency_total_ms, smoke_sample_team_matches, smoke_knocks, smoke_rescues, now()
  from totals
  on conflict (team_mode, calculation_version, observation_version) do update set
    sample_team_matches = excluded.sample_team_matches, knocks = excluded.knocks, revives = excluded.revives,
    trade_kills = excluded.trade_kills, trade_latency_total_ms = excluded.trade_latency_total_ms,
    smoke_sample_team_matches = excluded.smoke_sample_team_matches, smoke_knocks = excluded.smoke_knocks,
    smoke_rescues = excluded.smoke_rescues, refreshed_at = excluded.refreshed_at;
  get diagnostics refreshed = row_count;
  return refreshed;
end;
$$;

revoke all on function public.refresh_pubg_team_benchmarks() from public, anon, authenticated;
grant execute on function public.refresh_pubg_team_benchmarks() to service_role;

-- 새 예약 작업이 생길 때마다 정리 목록을 고치지 않도록 bgms- 작업은 모두 7일, 10초 주기 랭킹 작업은 1일만 남긴다.
create or replace function bgms_private.cleanup_pubg_collection_clock_logs()
returns void language sql security invoker set search_path = '' as $$
  delete from bgms_private.pubg_collection_requests where dispatched_at < now() - interval '7 days';
  delete from cron.job_run_details where jobid in (
    select jobid from cron.job where jobname like 'bgms-%' and jobname <> 'bgms-pubg-rankings-refresh'
  ) and end_time < now() - interval '7 days';
  delete from cron.job_run_details where jobid in (
    select jobid from cron.job where jobname = 'bgms-pubg-rankings-refresh'
  ) and end_time < now() - interval '1 day';
$$;
revoke all on function bgms_private.cleanup_pubg_collection_clock_logs() from public,anon,authenticated,service_role;

select public.refresh_pubg_team_benchmarks();
select cron.schedule('bgms-pubg-team-benchmarks-refresh', '41 4 * * *', 'select public.refresh_pubg_team_benchmarks();');
