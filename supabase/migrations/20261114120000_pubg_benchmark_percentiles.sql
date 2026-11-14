-- 단일 경기 AI 코칭의 "BGMS 기록 기준 상위 N%" 근거.
-- 이 경기의 비교 모집단 행이 있을 때만(생존 5분 이상·사람 일반전/경쟁전) 같은 모드·경기 유형의 최근 90일 행과 비교한다.
-- 저장된 tier는 경기 점수 구간이라 쓰지 않는다. 같은 구간 안의 순위는 점수와 순환한다.
-- 피해량·킬·생존 시간은 계산 버전과 무관해 버전을 섞어 센다.
create or replace function public.get_pubg_benchmark_percentiles(
  p_match_id text,
  p_platform text,
  p_player_id text
) returns table (
  metric text,
  game_mode text,
  match_type text,
  sample_count bigint,
  at_or_above bigint,
  at_or_below bigint
)
language sql stable security invoker set search_path='' as $$
  with me as (
    select b.game_mode, b.match_type, b.damage, b.kills, b.survival_time
    from public.global_benchmarks b
    where b.match_id = p_match_id and b.platform = p_platform and b.player_id = p_player_id
      and b.filter_version = 8 and b.population_evidence_version = 1 and b.calculation_version is not null
      and b.match_type in ('official', 'competitive')
      and b.game_mode in ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')
    limit 1
  ), population as (
    select b.damage, b.kills, b.survival_time
    from public.global_benchmarks b, me
    where b.game_mode = me.game_mode and b.match_type = me.match_type
      and b.filter_version = 8 and b.population_evidence_version = 1 and b.calculation_version is not null
      and b.created_at >= now() - interval '90 days'
  ), pairs as (
    select 'damage'::text as metric, me.damage::double precision as mine, p.damage::double precision as value from me, population p
    union all
    select 'kills', me.kills::double precision, p.kills::double precision from me, population p
    union all
    select 'survival_time', me.survival_time::double precision, p.survival_time::double precision from me, population p
  )
  select pairs.metric, me.game_mode, me.match_type,
    count(*), count(*) filter (where pairs.value >= pairs.mine), count(*) filter (where pairs.value <= pairs.mine)
  from pairs, me
  where pairs.mine >= 0 and pairs.value >= 0
  group by pairs.metric, me.game_mode, me.match_type;
$$;

revoke all on function public.get_pubg_benchmark_percentiles(text,text,text) from public, anon, authenticated;
grant execute on function public.get_pubg_benchmark_percentiles(text,text,text) to service_role;
