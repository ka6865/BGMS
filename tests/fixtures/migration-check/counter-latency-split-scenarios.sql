-- 반격 지연 비교 기준 분리 격리 시나리오. 외부 상태나 provider를 쓰지 않는다.
BEGIN;
DO $$
DECLARE r record;
BEGIN
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,counter_latency_ms,filter_version,population_evidence_version,calculation_version)
  VALUES ('counter-split-1','steam','player_a','duo','official','B',400,8,1,5),
    ('counter-split-2','steam','player_a','duo','official','B',800,8,1,5),
    ('counter-split-3','steam','player_a','duo','official','B',3000,8,1,5),
    ('counter-split-4','steam','player_a','duo','official','B',-1,8,1,5);
  SELECT * INTO r FROM public.benchmark_stats_by_tier_v2
  WHERE game_mode='duo' AND match_type='official' AND tier='B' AND calculation_version=5;
  -- 기존 열은 패널티를 포함한 평균 그대로다.
  IF r.match_count <> 4 OR r.avg_counter_latency_ms IS DISTINCT FROM 1400::double precision OR r.avg_counter_latency_ms_count <> 3
  THEN RAISE EXCEPTION 'FAIL: legacy counter latency changed'; END IF;
  IF r.avg_measured_counter_latency_ms IS DISTINCT FROM 600::double precision OR r.avg_measured_counter_latency_ms_count <> 2
  THEN RAISE EXCEPTION 'FAIL: measured counter latency includes penalty or missing rows'; END IF;
  IF abs(r.avg_counter_failure_rate - 100.0/3) > 1e-9 OR r.avg_counter_failure_rate_count <> 3
  THEN RAISE EXCEPTION 'FAIL: counter failure rate'; END IF;
  IF NOT has_table_privilege('anon','public.benchmark_stats_by_tier_v2','SELECT')
    OR (SELECT reloptions FROM pg_class WHERE oid='public.benchmark_stats_by_tier_v2'::regclass) IS DISTINCT FROM ARRAY['security_invoker=true']
  THEN RAISE EXCEPTION 'FAIL: view ACL or security_invoker changed'; END IF;
  RAISE NOTICE 'PASS: counter latency split keeps legacy average and adds measured/failure columns';
END $$;
ROLLBACK;
