-- 잡을 수 있었던 기절(적 플레이어가 100m 안에서 눕힌 아군 기절)과 그 기절의 30초 안 백업 성공 수를 팀 비교 기준에 더한다.
-- 이전 분석 결과에는 값이 없으므로 값이 있는 경기만 따로 센다. 기존 열과 비교값은 그대로다.
alter table public.pubg_team_benchmarks
  add column if not exists tradeable_sample_team_matches integer not null default 0 check (tradeable_sample_team_matches >= 0),
  add column if not exists tradeable_knocks bigint not null default 0 check (tradeable_knocks >= 0),
  add column if not exists tradeable_trade_kills bigint not null default 0 check (tradeable_trade_kills >= 0);

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
      coalesce(sum((observation->>'smokeRescues')::bigint), 0) as smoke_rescues,
      -- 잡을 수 있었던 기절은 값이 기록된 경기만 센다(이전 분석·거리 누락은 null).
      count(*) filter (where observation->>'eligibleKnocks' is not null and observation->>'eligibleTradeKills' is not null)::integer as tradeable_sample_team_matches,
      coalesce(sum((observation->>'eligibleKnocks')::bigint) filter (where observation->>'eligibleTradeKills' is not null), 0) as tradeable_knocks,
      coalesce(sum((observation->>'eligibleTradeKills')::bigint) filter (where observation->>'eligibleKnocks' is not null), 0) as tradeable_trade_kills
    from observed
    group by team_mode, calculation_version, observation_version
  )
  insert into public.pubg_team_benchmarks as b (team_mode, calculation_version, observation_version, sample_team_matches,
    knocks, revives, trade_kills, trade_latency_total_ms, smoke_sample_team_matches, smoke_knocks, smoke_rescues,
    tradeable_sample_team_matches, tradeable_knocks, tradeable_trade_kills, refreshed_at)
  select team_mode, calculation_version, observation_version, sample_team_matches,
    knocks, revives, trade_kills, trade_latency_total_ms, smoke_sample_team_matches, smoke_knocks, smoke_rescues,
    tradeable_sample_team_matches, tradeable_knocks, tradeable_trade_kills, now()
  from totals
  on conflict (team_mode, calculation_version, observation_version) do update set
    sample_team_matches = excluded.sample_team_matches, knocks = excluded.knocks, revives = excluded.revives,
    trade_kills = excluded.trade_kills, trade_latency_total_ms = excluded.trade_latency_total_ms,
    smoke_sample_team_matches = excluded.smoke_sample_team_matches, smoke_knocks = excluded.smoke_knocks,
    smoke_rescues = excluded.smoke_rescues, tradeable_sample_team_matches = excluded.tradeable_sample_team_matches,
    tradeable_knocks = excluded.tradeable_knocks, tradeable_trade_kills = excluded.tradeable_trade_kills,
    refreshed_at = excluded.refreshed_at;
  get diagnostics refreshed = row_count;
  return refreshed;
end;
$$;

revoke all on function public.refresh_pubg_team_benchmarks() from public, anon, authenticated;
grant execute on function public.refresh_pubg_team_benchmarks() to service_role;
