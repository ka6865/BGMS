-- 반격 지연 비교 기준을 3초 패널티와 실측으로 나눈다.
-- counter_latency_ms는 3초 안에 대응 피해가 없고 기습만 당한 경기에 3000을 저장하고(AnalysisEngine),
-- 실측 반응은 항상 3000 미만이다. 기존 avg_counter_latency_ms는 점수·역할 분류 호환을 위해 그대로 두고,
-- 실측 평균과 3초 내 대응 실패 비율(0~100)을 표본 수와 함께 열 끝에 추가한다. 저장 데이터는 바꾸지 않는다.
CREATE OR REPLACE VIEW public.benchmark_stats_by_tier_v2
WITH (security_invoker = true)
AS
SELECT
  b.tier,
  b.game_mode,
  b.match_type,
  count(*) AS match_count,
  avg(NULLIF(b.damage, -1::double precision)) AS avg_damage,
  avg(NULLIF(b.kills, -1)) AS avg_kills,
  avg(NULLIF(b.survival_time, -1)) AS avg_survival_time,
  avg(NULLIF(b.duel_win_rate, -1::double precision)) AS avg_duel_win_rate,
  avg(NULLIF(b.initiative_rate, -1::double precision)) AS avg_initiative_rate,
  avg(NULLIF(b.trade_rate, -1::double precision)) AS avg_trade_rate,
  avg(NULLIF(b.revive_rate, -1::double precision)) AS avg_revive_rate,
  avg(NULLIF(b.smoke_rate, -1::double precision)) AS avg_smoke_rate,
  avg(NULLIF(b.pressure_index, -1::double precision)) AS avg_pressure_index,
  avg(NULLIF(b.team_wipes, -1)) AS avg_team_wipes,
  avg(NULLIF(b.reversal_rate, -1::double precision)) AS avg_reversal_rate,
  avg(NULLIF(b.isolation_index, -1::double precision)) AS avg_isolation_index,
  avg(NULLIF(b.min_dist, -1::double precision)) AS avg_min_dist,
  avg(NULLIF(b.counter_latency_ms, -1::double precision)) AS avg_counter_latency_ms,
  avg(NULLIF(b.trade_latency_ms, -1::double precision)) AS avg_trade_latency_ms,
  avg(NULLIF(b.solo_kill_rate, -1)) AS avg_solo_kill_rate,
  avg(NULLIF(b.death_phase, -1)) AS avg_death_phase,
  8::integer AS filter_version,
  1::integer AS population_evidence_version,
  count(*) FILTER (WHERE NULLIF(b.damage, -1::double precision) IS NOT NULL) AS avg_damage_count,
  count(*) FILTER (WHERE NULLIF(b.kills, -1) IS NOT NULL) AS avg_kills_count,
  count(*) FILTER (WHERE NULLIF(b.survival_time, -1) IS NOT NULL) AS avg_survival_time_count,
  count(*) FILTER (WHERE NULLIF(b.duel_win_rate, -1::double precision) IS NOT NULL) AS avg_duel_win_rate_count,
  count(*) FILTER (WHERE NULLIF(b.initiative_rate, -1::double precision) IS NOT NULL) AS avg_initiative_rate_count,
  count(*) FILTER (WHERE NULLIF(b.trade_rate, -1::double precision) IS NOT NULL) AS avg_trade_rate_count,
  count(*) FILTER (WHERE NULLIF(b.revive_rate, -1::double precision) IS NOT NULL) AS avg_revive_rate_count,
  count(*) FILTER (WHERE NULLIF(b.smoke_rate, -1::double precision) IS NOT NULL) AS avg_smoke_rate_count,
  count(*) FILTER (WHERE NULLIF(b.pressure_index, -1::double precision) IS NOT NULL) AS avg_pressure_index_count,
  count(*) FILTER (WHERE NULLIF(b.team_wipes, -1) IS NOT NULL) AS avg_team_wipes_count,
  count(*) FILTER (WHERE NULLIF(b.reversal_rate, -1::double precision) IS NOT NULL) AS avg_reversal_rate_count,
  count(*) FILTER (WHERE NULLIF(b.isolation_index, -1::double precision) IS NOT NULL) AS avg_isolation_index_count,
  count(*) FILTER (WHERE NULLIF(b.min_dist, -1::double precision) IS NOT NULL) AS avg_min_dist_count,
  count(*) FILTER (WHERE NULLIF(b.counter_latency_ms, -1::double precision) IS NOT NULL) AS avg_counter_latency_ms_count,
  count(*) FILTER (WHERE NULLIF(b.trade_latency_ms, -1::double precision) IS NOT NULL) AS avg_trade_latency_ms_count,
  count(*) FILTER (WHERE NULLIF(b.solo_kill_rate, -1) IS NOT NULL) AS avg_solo_kill_rate_count,
  count(*) FILTER (WHERE NULLIF(b.death_phase, -1) IS NOT NULL) AS avg_death_phase_count,
  b.calculation_version,
  avg(b.counter_latency_ms) FILTER (WHERE b.counter_latency_ms >= 0 AND b.counter_latency_ms < 3000) AS avg_measured_counter_latency_ms,
  count(*) FILTER (WHERE b.counter_latency_ms >= 0 AND b.counter_latency_ms < 3000) AS avg_measured_counter_latency_ms_count,
  avg(CASE WHEN b.counter_latency_ms >= 3000 THEN 100::double precision WHEN b.counter_latency_ms >= 0 THEN 0::double precision END) AS avg_counter_failure_rate,
  count(*) FILTER (WHERE b.counter_latency_ms >= 0) AS avg_counter_failure_rate_count
FROM public.global_benchmarks AS b
WHERE b.filter_version = 8
  AND b.population_evidence_version = 1
  AND b.match_type IN ('official', 'competitive')
  AND b.game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')
GROUP BY b.tier, b.game_mode, b.match_type, b.calculation_version;

ALTER VIEW public.benchmark_stats_by_tier_v2 OWNER TO postgres;
GRANT SELECT ON TABLE public.benchmark_stats_by_tier_v2 TO anon, authenticated;
GRANT ALL ON TABLE public.benchmark_stats_by_tier_v2 TO service_role;
