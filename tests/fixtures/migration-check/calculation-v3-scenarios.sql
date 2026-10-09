BEGIN;
DO $$
DECLARE old_data jsonb; old_benchmark jsonb; next_result jsonb; next_benchmark jsonb; actual jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v3-paired','steam','player_a','{"fullResult":{"matchId":"calc-v3-paired","platform":"steam","player_id":"player_a","v":73,"calculationVersion":2,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,filter_version,population_evidence_version,calculation_version)
  VALUES ('calc-v3-paired','steam','player_a','solo-fpp','competitive','S',100,8,1,2),
    ('calc-v3-old-population','steam','player_a','solo-fpp','competitive','S',900,8,1,2);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v3-paired';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v3-paired';
  next_result := old_data->'fullResult'||'{"calculationVersion":3,"populationEvidenceVersion":1,"gameMode":"solo-fpp","matchType":"competitive"}';
  next_benchmark := old_benchmark||'{"calculation_version":3,"damage":450}';
  IF public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',old_data||'{"changed":true}',old_benchmark,next_result,next_benchmark)
    OR public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',old_data,old_benchmark||'{"damage":999}',next_result,next_benchmark)
    OR public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',old_data,old_benchmark,jsonb_set(next_result,'{stats,playerId}','"account.other"'),next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: v3 stale snapshot/account guard'; END IF;
  BEGIN
    PERFORM public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',old_data,old_benchmark,next_result,jsonb_set(next_benchmark,'{calculation_version}','2'));
    RAISE EXCEPTION 'FAIL: mismatched target versions accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF NOT public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',old_data,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: paired 2 to 3 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v3-paired';
  IF actual->'fullResult' IS DISTINCT FROM next_result OR
    (SELECT calculation_version FROM public.global_benchmarks WHERE match_id='calc-v3-paired') <> 3
  THEN RAISE EXCEPTION 'FAIL: paired v3 readback'; END IF;
  IF public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',old_data,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: repeated v3 CAS accepted'; END IF;
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v3-paired';
  IF public.upgrade_analysis_calculation('calc-v3-paired','steam','player_a',actual,old_benchmark,jsonb_set(next_result,'{calculationVersion}','2'),jsonb_set(next_benchmark,'{calculation_version}','2'))
  THEN RAISE EXCEPTION 'FAIL: v3 to v2 RPC downgrade accepted'; END IF;
  UPDATE public.processed_match_telemetry SET data=old_data WHERE match_id='calc-v3-paired';
  UPDATE public.global_benchmarks SET calculation_version=2,damage=999 WHERE match_id='calc-v3-paired';
  IF (SELECT data FROM public.processed_match_telemetry WHERE match_id='calc-v3-paired') IS DISTINCT FROM actual
    OR (SELECT damage FROM public.global_benchmarks WHERE match_id='calc-v3-paired') <> 450
  THEN RAISE EXCEPTION 'FAIL: v2 worker overwrote v3'; END IF;
  IF (SELECT avg_damage FROM public.benchmark_stats_by_tier_v2 WHERE game_mode='solo-fpp' AND match_type='competitive' AND tier='S' AND calculation_version=3) IS DISTINCT FROM 450::double precision
  THEN RAISE EXCEPTION 'FAIL: v2 mixed in v3 population'; END IF;
  IF public.upgrade_analysis_calculation_canonical('calc-v3-paired','steam','player_a',actual,next_result)
  THEN RAISE EXCEPTION 'FAIL: paired canonical bypass'; END IF;
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v3-legacy-paired','steam','player_a',jsonb_set(old_data,'{fullResult,matchId}','"calc-v3-legacy-paired"') #- '{fullResult,calculationVersion}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,filter_version,population_evidence_version)
  VALUES ('calc-v3-legacy-paired','steam','player_a','solo-fpp','competitive','S',100,8,1);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v3-legacy-paired';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v3-legacy-paired';
  IF NOT public.upgrade_analysis_calculation('calc-v3-legacy-paired','steam','player_a',old_data,old_benchmark,
    jsonb_set(next_result,'{matchId}','"calc-v3-legacy-paired"'),old_benchmark||'{"calculation_version":3,"damage":450}')
  THEN RAISE EXCEPTION 'FAIL: paired validated legacy to v3 rejected'; END IF;
  RAISE NOTICE 'PASS: paired 2 to 3, atomic CAS/account binding, repeat/downgrade prevention, isolated population';
END $$;

DO $$
DECLARE old_data jsonb; next_result jsonb; actual jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v3-short','steam','player_a','{"fullResult":{"matchId":"calc-v3-short","platform":"steam","player_id":"player_a","v":73,"calculationVersion":2,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v3-short';
  next_result := old_data->'fullResult'||'{"calculationVersion":3,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official","isValidBenchmark":false}';
  IF public.upgrade_analysis_calculation_canonical('calc-v3-short','steam','player_a',old_data||'{"changed":true}',next_result)
    OR public.upgrade_analysis_calculation_canonical('calc-v3-short','steam','player_a',old_data,jsonb_set(next_result,'{stats,playerId}','"account.other"'))
  THEN RAISE EXCEPTION 'FAIL: canonical v3 stale snapshot/account guard'; END IF;
  IF NOT public.upgrade_analysis_calculation_canonical('calc-v3-short','steam','player_a',old_data,next_result)
  THEN RAISE EXCEPTION 'FAIL: canonical 2 to 3 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v3-short';
  IF actual->'fullResult' IS DISTINCT FROM next_result OR EXISTS(SELECT 1 FROM public.global_benchmarks WHERE match_id='calc-v3-short')
  THEN RAISE EXCEPTION 'FAIL: canonical v3 readback/population'; END IF;
  IF public.upgrade_analysis_calculation_canonical('calc-v3-short','steam','player_a',old_data,next_result)
    OR public.upgrade_analysis_calculation_canonical('calc-v3-short','steam','player_a',actual,jsonb_set(next_result,'{calculationVersion}','2'))
  THEN RAISE EXCEPTION 'FAIL: canonical v3 repeated/downgrade CAS'; END IF;
  UPDATE public.processed_match_telemetry SET data=old_data WHERE match_id='calc-v3-short';
  IF (SELECT data FROM public.processed_match_telemetry WHERE match_id='calc-v3-short') IS DISTINCT FROM actual
  THEN RAISE EXCEPTION 'FAIL: canonical v3 overwrite'; END IF;
  -- 원본에서 재계산한 legacy 결과는 현재 버전으로 바로 업그레이드할 수 있다.
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v3-legacy','steam','player_a',jsonb_set(old_data,'{fullResult,matchId}','"calc-v3-legacy"') #- '{fullResult,calculationVersion}');
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v3-legacy';
  IF NOT public.upgrade_analysis_calculation_canonical('calc-v3-legacy','steam','player_a',old_data,jsonb_set(next_result,'{matchId}','"calc-v3-legacy"'))
  THEN RAISE EXCEPTION 'FAIL: validated legacy to v3 rejected'; END IF;
  IF has_function_privilege('anon','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: v3 RPC ACL'; END IF;
  RAISE NOTICE 'PASS: canonical v3 snapshot/account CAS, legacy recomputation, no fabricated samples and ACL';
END $$;
DO $$
DECLARE case_index integer := 0; versions record; match_key text; row_id bigint;
  lease_token uuid; storage_key text; old_data jsonb; snapshot jsonb; result jsonb;
BEGIN
  FOR versions IN SELECT * FROM (VALUES (2,2,2),(3,3,3),(3,2,NULL::integer)) AS cases(processed,benchmark,expected)
  LOOP
    case_index := case_index + 1;
    match_key := 'calc-v3-recovery-' || case_index;
    lease_token := ('00000000-0000-4000-8000-' || lpad(case_index::text,12,'0'))::uuid;
    storage_key := 'telemetry-map/v62/steam/' || match_key || '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/lite.json';
    old_data := jsonb_build_object('fullResult',jsonb_build_object('v',72,'matchId',match_key,'platform','steam','player_id','player_a','stats',jsonb_build_object('name','Player_A','playerId','account.a')));
    INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data) VALUES (match_key,'steam','player_a',old_data);
    INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,kills,filter_version,population_evidence_version)
    VALUES (match_key,'steam','player_a','squad','official','B',100,1,NULL,NULL) RETURNING id INTO row_id;
    SELECT jsonb_object_agg(item.key,item.value) INTO snapshot
    FROM public.global_benchmarks b, LATERAL jsonb_each(to_jsonb(b)) item
    WHERE b.id=row_id AND item.key IN (
      'damage','kills','win_place','game_mode','map_name','counter_latency_ms','initiative_rate','revive_rate','is_crossfire',
      'utility_count','smoke_count','frag_count','pressure_index','enemy_death_distance','survival_time','isolation_index','min_dist',
      'height_diff','smoke_rate','trade_rate','solo_kill_rate','reversal_rate','duel_win_rate','trade_latency_ms','lethal_throw_count',
      'tier','score','combat_score','tactical_score','survival_score','supp_count','team_wipes','match_type','death_phase',
      'filter_version','population_evidence_version','source');
    IF NOT public.claim_telemetry_cache_recovery_write(match_key,'steam','account.a','lite',62,storage_key,now()+interval '2 minutes',lease_token,now())
    THEN RAISE EXCEPTION 'FAIL: v3 recovery claim'; END IF;
    result := public.finalize_telemetry_cache_recovery(
      match_key,'steam','account.a','lite',62,storage_key,lease_token,
      jsonb_build_object('matchId',match_key,'platform','steam','playerId','player_a','resultVersion',72,'accountId','account.a'),
      jsonb_build_object('id',row_id,'matchId',match_key,'platform','steam','playerId','player_a','gameMode','squad','matchType','official','tier','B','filterVersion',NULL,'populationEvidenceVersion',NULL,'snapshot',snapshot),
      jsonb_build_object(
        'master',jsonb_build_object('match_id',match_key,'map_name','Baltic_Main','game_mode','squad','telemetry_version',62,'storage_path',storage_key),
        'processed',jsonb_build_object('match_id',match_key,'platform','steam','player_id','player_a','updated_at',now(),'data',jsonb_build_object('fullResult',old_data->'fullResult'||jsonb_build_object('v',73,'calculationVersion',versions.processed,'populationEvidenceVersion',1))),
        'benchmark',jsonb_build_object('match_id',match_key,'platform','steam','player_id','player_a','game_mode','squad','map_name','Baltic_Main','match_type','official','tier','B','damage',100,'kills',1,'filter_version',8,'population_evidence_version',1,'source','user','calculation_version',versions.benchmark)));
    IF result->>'code' IS DISTINCT FROM 'finalized' OR
      (SELECT calculation_version FROM public.global_benchmarks WHERE id=row_id) IS DISTINCT FROM versions.expected
    THEN RAISE EXCEPTION 'FAIL: recovery calculation provenance % (%)',case_index,result; END IF;
  END LOOP;
  RAISE NOTICE 'PASS: recovery v2/v3 matching provenance; mixed provenance stays unknown';
END $$;
ROLLBACK;
