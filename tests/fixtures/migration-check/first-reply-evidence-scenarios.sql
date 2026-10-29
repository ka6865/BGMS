BEGIN;
DO $$
DECLARE r record; old_data jsonb; old_benchmark jsonb; next_result jsonb; next_benchmark jsonb;
BEGIN
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,counter_latency_ms,first_reply_latency_ms,eligible_first_reply_latency_ms,eligible_counter_failure_rate,filter_version,population_evidence_version,calculation_version)
  VALUES ('reply-evidence-old','steam','player_a','duo-fpp','official','B',3,3,NULL,NULL,8,1,5),
    ('reply-evidence-1','steam','player_a','duo-fpp','official','B',400,500,500,0,8,1,5),
    ('reply-evidence-2','steam','player_a','duo-fpp','official','B',800,900,900,0,8,1,5),
    ('reply-evidence-3','steam','player_a','duo-fpp','official','B',3000,NULL,NULL,100,8,1,5);
  SELECT * INTO r FROM public.benchmark_stats_by_tier_v2 WHERE tier='B' AND game_mode='duo-fpp' AND match_type='official' AND calculation_version=5;
  IF r.avg_eligible_first_reply_latency_ms IS DISTINCT FROM 700::numeric OR r.avg_eligible_first_reply_latency_ms_count <> 2
    OR abs(r.avg_eligible_counter_failure_rate - 100.0/3) > 1e-9 OR r.avg_eligible_counter_failure_rate_count <> 3
    OR r.avg_first_reply_latency_ms_count <> 3
  THEN RAISE EXCEPTION 'FAIL: eligible samples mixed with legacy raw interval'; END IF;

  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('reply-evidence-rpc','steam','player_a','{"fullResult":{"matchId":"reply-evidence-rpc","platform":"steam","player_id":"player_a","v":73,"calculationVersion":4,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,filter_version,population_evidence_version,calculation_version)
  VALUES ('reply-evidence-rpc','steam','player_a','squad','official','A',8,1,4);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='reply-evidence-rpc';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='reply-evidence-rpc';
  next_result := old_data->'fullResult'||'{"calculationVersion":5,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official"}';
  next_benchmark := old_benchmark||'{"calculation_version":5,"first_reply_latency_ms":3,"eligible_first_reply_latency_ms":null,"eligible_counter_failure_rate":null}';
  IF NOT public.upgrade_analysis_calculation('reply-evidence-rpc','steam','player_a',old_data,old_benchmark,next_result,next_benchmark)
    OR (SELECT first_reply_latency_ms FROM public.global_benchmarks WHERE match_id='reply-evidence-rpc') <> 3
    OR (SELECT eligible_first_reply_latency_ms FROM public.global_benchmarks WHERE match_id='reply-evidence-rpc') IS NOT NULL
  THEN RAISE EXCEPTION 'FAIL: raw and eligible columns did not roundtrip through RPC'; END IF;
  RAISE NOTICE 'PASS: eligible reply view excludes old rows; upgrade RPC preserves independent columns';
END $$;
ROLLBACK;
