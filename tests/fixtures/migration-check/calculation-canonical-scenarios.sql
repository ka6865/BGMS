BEGIN;
DO $$
DECLARE old_data jsonb; next_result jsonb; actual jsonb; accepted boolean;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('canonical-short','steam','player_a','{"fullResult":{"matchId":"canonical-short","platform":"steam","player_id":"player_a","v":72,"stats":{"name":"Player_A","playerId":"account.a","timeSurvived":120}}}');
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='canonical-short';
  next_result := old_data->'fullResult'||'{"v":73,"calculationVersion":2,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official","isValidBenchmark":false}';
  IF public.upgrade_analysis_calculation_canonical('canonical-short','steam','player_a',old_data||'{"changed":true}',next_result) THEN RAISE EXCEPTION 'FAIL: stale canonical snapshot accepted'; END IF;
  IF public.upgrade_analysis_calculation_canonical('canonical-short','steam','player_a',old_data,jsonb_set(next_result,'{stats,playerId}','"account.other"')) THEN RAISE EXCEPTION 'FAIL: changed account accepted'; END IF;
  accepted := public.upgrade_analysis_calculation_canonical('canonical-short','steam','player_a',old_data,next_result);
  IF NOT accepted THEN RAISE EXCEPTION 'FAIL: canonical short match rejected'; END IF;
  SELECT data->'fullResult' INTO actual FROM public.processed_match_telemetry WHERE match_id='canonical-short';
  IF actual IS DISTINCT FROM next_result THEN RAISE EXCEPTION 'FAIL: canonical readback differs'; END IF;
  IF EXISTS(SELECT 1 FROM public.global_benchmarks WHERE match_id='canonical-short') THEN RAISE EXCEPTION 'FAIL: short match entered comparison population'; END IF;
  IF public.upgrade_analysis_calculation_canonical('canonical-short','steam','player_a',old_data,next_result) THEN RAISE EXCEPTION 'FAIL: repeated canonical write accepted'; END IF;
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('canonical-paired','steam','player_a',jsonb_set(old_data,'{fullResult,matchId}','"canonical-paired"'));
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,filter_version,population_evidence_version)
  VALUES ('canonical-paired','steam','player_a','squad','official','B',8,1);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='canonical-paired';
  next_result := jsonb_set(next_result,'{matchId}','"canonical-paired"')||'{"isValidBenchmark":true}';
  IF public.upgrade_analysis_calculation_canonical('canonical-paired','steam','player_a',old_data,next_result) THEN RAISE EXCEPTION 'FAIL: paired update requirement bypassed'; END IF;
  IF has_function_privilege('anon','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'FAIL: canonical ACL'; END IF;
  RAISE NOTICE 'PASS: canonical-only short-match CAS, v72 upgrade, account binding, no fabricated benchmark and paired guard';
END $$;
ROLLBACK;
