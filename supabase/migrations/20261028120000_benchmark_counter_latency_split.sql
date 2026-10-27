-- 반격 지연 비교 기준을 실제 첫 반격 시간과 3초 내 대응 실패율로 나눈다.
-- counter_latency_ms는 3초 안에 대응하지 못하고 기습만 당한 경기에 3000을 저장하고(AnalysisEngine),
-- 그 외에는 직전 적 피격부터 내 모든 피격까지의 간격 평균이라 교전 중 연사 간격이 섞인다.
-- 반응 시간은 계산 5의 첫 피격→첫 반격 기록(duelStats.firstReply*)으로 새 열 first_reply_latency_ms에 저장한다.
-- 기존 avg_counter_latency_ms는 점수·역할 분류 호환을 위해 그대로 두고, view 끝에 열을 추가한다.

ALTER TABLE public.global_benchmarks ADD COLUMN IF NOT EXISTS first_reply_latency_ms integer;
COMMENT ON COLUMN public.global_benchmarks.first_reply_latency_ms IS '[계산 5] 기습당한 교전의 첫 피격→첫 반격 평균(ms). 3초 안에 반격한 교전이 없거나 기록이 없으면 NULL.';

-- 이미 저장된 계산 5 행은 같은 경기·플레이어의 canonical 결과에서 채운다. 다른 열은 바꾸지 않는다.
UPDATE public.global_benchmarks AS b
SET first_reply_latency_ms = round((p.data #>> '{fullResult,duelStats,firstReplyLatencySumMs}')::numeric
  / (p.data #>> '{fullResult,duelStats,firstReplyWithin3sCount}')::numeric)::integer
FROM public.processed_match_telemetry AS p
WHERE b.calculation_version = 5
  AND b.first_reply_latency_ms IS NULL
  AND p.match_id = b.match_id AND p.platform = b.platform AND p.player_id = b.player_id
  AND p.data #> '{fullResult,calculationVersion}' = '5'::jsonb
  AND jsonb_typeof(p.data #> '{fullResult,duelStats,firstReplyWithin3sCount}') = 'number'
  AND jsonb_typeof(p.data #> '{fullResult,duelStats,firstReplyLatencySumMs}') = 'number'
  AND (p.data #>> '{fullResult,duelStats,firstReplyWithin3sCount}')::numeric > 0;

-- 텔레메트리 재분석 RPC도 새 열을 함께 쓴다. 바꿀 열 목록이 정확히 두 번 없으면 실패한다.
DO $migration$
DECLARE definition text; updated_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='upgrade_analysis_calculation';
  IF (length(definition) - length(replace(definition, 'counter_latency_ms, initiative_rate', ''))) / length('counter_latency_ms, initiative_rate') <> 2
  THEN RAISE EXCEPTION 'counter-latency-split: unexpected upgrade_analysis_calculation definition'; END IF;
  updated_definition := replace(definition, 'counter_latency_ms, initiative_rate', 'counter_latency_ms, first_reply_latency_ms, initiative_rate');
  EXECUTE updated_definition;
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
