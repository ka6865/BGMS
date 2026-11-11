-- 계산 6 migration 격리 시나리오. 외부 상태나 provider를 쓰지 않는다.
BEGIN;
-- 1. 텔레메트리 재분석 결과의 5→6 CAS, 6→5 하향 거부, 미지원 버전 거부, canonical 5→6.
DO $$
DECLARE old_data jsonb; old_benchmark jsonb; next_result jsonb; next_benchmark jsonb; actual jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v6-paired','steam','player_a','{"fullResult":{"matchId":"calc-v6-paired","platform":"steam","player_id":"player_a","v":73,"calculationVersion":5,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,isolation_index,filter_version,population_evidence_version,calculation_version)
  VALUES ('calc-v6-paired','steam','player_a','squad','official','A',100,0,8,1,5);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v6-paired';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v6-paired';
  next_result := old_data->'fullResult'||'{"calculationVersion":6,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official"}';
  next_benchmark := old_benchmark||'{"calculation_version":6,"isolation_index":-1}';
  BEGIN
    PERFORM public.upgrade_analysis_calculation('calc-v6-paired','steam','player_a',old_data,old_benchmark,
      jsonb_set(next_result,'{calculationVersion}','7'),jsonb_set(next_benchmark,'{calculation_version}','7'));
    RAISE EXCEPTION 'FAIL: unsupported calculation 7 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF NOT public.upgrade_analysis_calculation('calc-v6-paired','steam','player_a',old_data,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: paired 5 to 6 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v6-paired';
  IF actual->'fullResult' IS DISTINCT FROM next_result
    OR (SELECT row(calculation_version,isolation_index)::text FROM public.global_benchmarks WHERE match_id='calc-v6-paired')
      IS DISTINCT FROM row(6,-1::double precision)::text
  THEN RAISE EXCEPTION 'FAIL: paired v6 readback'; END IF;
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v6-paired';
  IF public.upgrade_analysis_calculation('calc-v6-paired','steam','player_a',actual,old_benchmark,
    jsonb_set(next_result,'{calculationVersion}','5'),jsonb_set(next_benchmark,'{calculation_version}','5'))
  THEN RAISE EXCEPTION 'FAIL: v6 to v5 RPC downgrade accepted'; END IF;
  IF public.upgrade_analysis_calculation('calc-v6-paired','steam','player_a',actual,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: repeated v6 upgrade accepted'; END IF;

  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v6-canonical','steam','player_a','{"fullResult":{"matchId":"calc-v6-canonical","platform":"steam","player_id":"player_a","v":73,"calculationVersion":5,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v6-canonical';
  next_result := old_data->'fullResult'||'{"calculationVersion":6,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official"}';
  IF NOT public.upgrade_analysis_calculation_canonical('calc-v6-canonical','steam','player_a',old_data,next_result)
  THEN RAISE EXCEPTION 'FAIL: canonical 5 to 6 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v6-canonical';
  IF actual #> '{fullResult,calculationVersion}' IS DISTINCT FROM '6'::jsonb
  THEN RAISE EXCEPTION 'FAIL: canonical v6 readback'; END IF;
  IF public.upgrade_analysis_calculation_canonical('calc-v6-canonical','steam','player_a',actual,
    jsonb_set(next_result,'{calculationVersion}','5'))
  THEN RAISE EXCEPTION 'FAIL: canonical v6 to v5 downgrade accepted'; END IF;
  RAISE NOTICE 'PASS: paired and canonical 5 to 6, unsupported version and downgrade rejected';
END $$;

-- 2. 랭킹은 계산 6 요청에서 이전 버전 결과를 함께 쓰고 같은 경기는 높은 버전을 고른다.
INSERT INTO public.profiles(id,pubg_nickname,pubg_platform,last_active_at)
VALUES ('00000000-0000-0000-0000-000000000906','coexist6','steam',now());
INSERT INTO public.pubg_player_cache(id,platform,nickname,lower_nickname,search_count)
VALUES ('account.coexist6','steam','coexist6','coexist6',1);
INSERT INTO public.pubg_player_matches(player_id,platform,account_id,match_id,played_at,game_mode,map_name,match_type,kills,damage,win_place,ranking_eligible)
VALUES ('coexist6','steam','account.coexist6','c6-mixed',now()-interval '1 day','duo','Baltic_Main','official',5,500,1,true);
INSERT INTO public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,score,tier,benchmark,ranking_eligible)
VALUES ('steam','account.coexist6','c6-mixed','coexist6',5,73,92,'S+','{"score":92}',true),
  ('steam','account.coexist6','c6-mixed','coexist6',6,73,74,'A','{"score":74}',true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',6,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 74::double precision OR r.match_count IS DISTINCT FROM 1::bigint
    THEN RAISE EXCEPTION 'FAIL: mixed v5/v6 match duplicated or older result selected (% %)', r.value, r.match_count; END IF;
  RAISE NOTICE 'PASS: v6 ranking prefers the newest calculation of the same match';
END $$;

-- 3. 텔레메트리 복구 provenance에 계산 6이 포함됐고 함수 권한 경계가 그대로다.
DO $$
BEGIN
  IF position($p$IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb) AND v_benchmark.calculation_version::text$p$ IN (
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery')) = 0
  THEN RAISE EXCEPTION 'FAIL: recovery provenance missing calculation 6'; END IF;
  IF has_function_privilege('anon','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: calculation 6 function ACL'; END IF;
  RAISE NOTICE 'PASS: recovery provenance accepts calculation 6, ACL unchanged';
END $$;
ROLLBACK;
