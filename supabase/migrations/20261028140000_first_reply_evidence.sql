-- 사격 근거가 확인된 반격 지표를 raw 명중 간격과 분리한다. 과거 행은 NULL로 유지한다.
ALTER TABLE public.global_benchmarks ADD COLUMN IF NOT EXISTS eligible_first_reply_latency_ms integer;
ALTER TABLE public.global_benchmarks ADD COLUMN IF NOT EXISTS eligible_counter_failure_rate double precision;
COMMENT ON COLUMN public.global_benchmarks.eligible_first_reply_latency_ms IS 'firstReplyEvidence v1: 피격 전 연사·최근 사격 불명확·발사 연결 누락을 제외한 첫 반격 명중 간격 평균(ms).';
COMMENT ON COLUMN public.global_benchmarks.eligible_counter_failure_rate IS 'firstReplyEvidence v1: 적격 교전이 없으면 NULL, 적격 첫 반격이 전혀 없으면 100, 하나라도 있으면 0. 제외 교전은 분모에도 넣지 않는다.';

DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='upgrade_analysis_calculation';
  IF (length(definition) - length(replace(definition, 'first_reply_latency_ms, initiative_rate', ''))) / length('first_reply_latency_ms, initiative_rate') <> 2
  THEN RAISE EXCEPTION 'first-reply-evidence: unexpected upgrade_analysis_calculation definition'; END IF;
  EXECUTE replace(definition, 'first_reply_latency_ms, initiative_rate', 'first_reply_latency_ms, eligible_first_reply_latency_ms, eligible_counter_failure_rate, initiative_rate');
END $migration$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;

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
  avg(b.first_reply_latency_ms) FILTER (WHERE b.first_reply_latency_ms >= 0) AS avg_first_reply_latency_ms,
  count(*) FILTER (WHERE b.first_reply_latency_ms >= 0) AS avg_first_reply_latency_ms_count,
  avg(CASE WHEN b.counter_latency_ms >= 3000 THEN 100::double precision WHEN b.counter_latency_ms >= 0 THEN 0::double precision END) AS avg_counter_failure_rate,
  count(*) FILTER (WHERE b.counter_latency_ms >= 0) AS avg_counter_failure_rate_count,
  avg(b.eligible_first_reply_latency_ms) FILTER (WHERE b.eligible_first_reply_latency_ms >= 0) AS avg_eligible_first_reply_latency_ms,
  count(*) FILTER (WHERE b.eligible_first_reply_latency_ms >= 0) AS avg_eligible_first_reply_latency_ms_count,
  avg(b.eligible_counter_failure_rate) FILTER (WHERE b.eligible_counter_failure_rate BETWEEN 0 AND 100) AS avg_eligible_counter_failure_rate,
  count(*) FILTER (WHERE b.eligible_counter_failure_rate BETWEEN 0 AND 100) AS avg_eligible_counter_failure_rate_count
FROM public.global_benchmarks AS b
WHERE b.filter_version = 8
  AND b.population_evidence_version = 1
  AND b.match_type IN ('official', 'competitive')
  AND b.game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')
GROUP BY b.tier, b.game_mode, b.match_type, b.calculation_version;

ALTER VIEW public.benchmark_stats_by_tier_v2 OWNER TO postgres;
GRANT SELECT ON TABLE public.benchmark_stats_by_tier_v2 TO anon, authenticated;
GRANT ALL ON TABLE public.benchmark_stats_by_tier_v2 TO service_role;
