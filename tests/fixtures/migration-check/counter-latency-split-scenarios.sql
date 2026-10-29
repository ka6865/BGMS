-- 반격 지연 비교 기준 분리 격리 시나리오. 외부 상태나 provider를 쓰지 않는다.
BEGIN;
DO $$
DECLARE r record; definition text;
BEGIN
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,counter_latency_ms,first_reply_latency_ms,filter_version,population_evidence_version,calculation_version)
  VALUES ('counter-split-1','steam','player_a','duo','official','B',400,500,8,1,5),
    ('counter-split-2','steam','player_a','duo','official','B',800,900,8,1,5),
    ('counter-split-3','steam','player_a','duo','official','B',3000,NULL,8,1,5),
    ('counter-split-4','steam','player_a','duo','official','B',-1,NULL,8,1,5);
  SELECT * INTO r FROM public.benchmark_stats_by_tier_v2
  WHERE game_mode='duo' AND match_type='official' AND tier='B' AND calculation_version=5;
  -- 기존 열은 패널티를 포함한 평균 그대로다.
  IF r.match_count <> 4 OR r.avg_counter_latency_ms IS DISTINCT FROM 1400::double precision OR r.avg_counter_latency_ms_count <> 3
  THEN RAISE EXCEPTION 'FAIL: legacy counter latency changed'; END IF;
  IF r.avg_first_reply_latency_ms IS DISTINCT FROM 700::numeric OR r.avg_first_reply_latency_ms_count <> 2
  THEN RAISE EXCEPTION 'FAIL: first reply average or count (%, %)', r.avg_first_reply_latency_ms, r.avg_first_reply_latency_ms_count; END IF;
  IF abs(r.avg_counter_failure_rate - 100.0/3) > 1e-9 OR r.avg_counter_failure_rate_count <> 3
  THEN RAISE EXCEPTION 'FAIL: counter failure rate'; END IF;
  IF NOT has_table_privilege('anon','public.benchmark_stats_by_tier_v2','SELECT')
    OR (SELECT reloptions FROM pg_class WHERE oid='public.benchmark_stats_by_tier_v2'::regclass) IS DISTINCT FROM ARRAY['security_invoker=true']
  THEN RAISE EXCEPTION 'FAIL: view ACL or security_invoker changed'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='upgrade_analysis_calculation';
  IF (length(definition) - length(replace(definition, 'counter_latency_ms, first_reply_latency_ms, eligible_first_reply_latency_ms, eligible_counter_failure_rate, initiative_rate', ''))) / length('counter_latency_ms, first_reply_latency_ms, eligible_first_reply_latency_ms, eligible_counter_failure_rate, initiative_rate') <> 2
    OR has_function_privilege('anon','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: upgrade RPC does not carry first reply or ACL widened'; END IF;
  RAISE NOTICE 'PASS: counter latency split keeps legacy average and adds first reply/failure columns';
END $$;
ROLLBACK;
