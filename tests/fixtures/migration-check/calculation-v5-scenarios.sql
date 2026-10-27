-- 계산 5 migration 격리 시나리오. 외부 상태나 provider를 쓰지 않는다.
BEGIN;
-- 1. 텔레메트리 재분석 결과의 4→5 CAS, 5→4 하향 거부, 미지원 버전 거부, canonical 4→5.
DO $$
DECLARE old_data jsonb; old_benchmark jsonb; next_result jsonb; next_benchmark jsonb; actual jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v5-paired','steam','player_a','{"fullResult":{"matchId":"calc-v5-paired","platform":"steam","player_id":"player_a","v":73,"calculationVersion":4,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,filter_version,population_evidence_version,calculation_version)
  VALUES ('calc-v5-paired','steam','player_a','squad','official','A',100,8,1,4);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v5-paired';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v5-paired';
  next_result := old_data->'fullResult'||'{"calculationVersion":5,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official"}';
  next_benchmark := old_benchmark||'{"calculation_version":5,"team_wipes":1}';
  BEGIN
    PERFORM public.upgrade_analysis_calculation('calc-v5-paired','steam','player_a',old_data,old_benchmark,
      jsonb_set(next_result,'{calculationVersion}','6'),jsonb_set(next_benchmark,'{calculation_version}','6'));
    RAISE EXCEPTION 'FAIL: unsupported calculation 6 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF NOT public.upgrade_analysis_calculation('calc-v5-paired','steam','player_a',old_data,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: paired 4 to 5 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v5-paired';
  IF actual->'fullResult' IS DISTINCT FROM next_result
    OR (SELECT row(calculation_version,team_wipes)::text FROM public.global_benchmarks WHERE match_id='calc-v5-paired')
      IS DISTINCT FROM row(5,1::double precision)::text
  THEN RAISE EXCEPTION 'FAIL: paired v5 readback'; END IF;
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v5-paired';
  IF public.upgrade_analysis_calculation('calc-v5-paired','steam','player_a',actual,old_benchmark,
    jsonb_set(next_result,'{calculationVersion}','4'),jsonb_set(next_benchmark,'{calculation_version}','4'))
  THEN RAISE EXCEPTION 'FAIL: v5 to v4 RPC downgrade accepted'; END IF;
  IF public.upgrade_analysis_calculation('calc-v5-paired','steam','player_a',actual,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: repeated v5 upgrade accepted'; END IF;

  -- 비교 표본이 없는 canonical 행도 4→5로 올린다.
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v5-canonical','steam','player_a','{"fullResult":{"matchId":"calc-v5-canonical","platform":"steam","player_id":"player_a","v":73,"calculationVersion":4,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v5-canonical';
  next_result := old_data->'fullResult'||'{"calculationVersion":5,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official"}';
  IF NOT public.upgrade_analysis_calculation_canonical('calc-v5-canonical','steam','player_a',old_data,next_result)
  THEN RAISE EXCEPTION 'FAIL: canonical 4 to 5 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v5-canonical';
  IF actual #> '{fullResult,calculationVersion}' IS DISTINCT FROM '5'::jsonb
  THEN RAISE EXCEPTION 'FAIL: canonical v5 readback'; END IF;
  IF public.upgrade_analysis_calculation_canonical('calc-v5-canonical','steam','player_a',actual,
    jsonb_set(next_result,'{calculationVersion}','4'))
  THEN RAISE EXCEPTION 'FAIL: canonical v5 to v4 downgrade accepted'; END IF;
  BEGIN
    PERFORM public.upgrade_analysis_calculation_canonical('calc-v5-canonical','steam','player_a',actual,
      jsonb_set(next_result,'{calculationVersion}','6'));
    RAISE EXCEPTION 'FAIL: canonical calculation 6 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  RAISE NOTICE 'PASS: paired and canonical 4 to 5, unsupported version and downgrade rejected';
END $$;

-- 2. 저장 데이터 기반 계산 4 보정은 계산 5 행을 건드리지 않는다.
DO $$
DECLARE before jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data) VALUES
    ('calc-v5-stored','steam','player_a','{"fullResult":{"matchId":"calc-v5-stored","platform":"steam","player_id":"player_a","v":73,"calculationVersion":5,"benchmark":{"score":50,"tier":"B","breakdown":{"combat":20,"tactical":15,"survival":15},"impactScore":50,"impactGrade":"NORMAL","impactBonus":0}}}');
  SELECT data INTO before FROM public.processed_match_telemetry WHERE match_id='calc-v5-stored';
  BEGIN
    PERFORM public.upgrade_analysis_calculation_stored_v4('calc-v5-stored','steam','player_a',5,50,
      '{"score":45,"tier":"B-","breakdown":{"combat":20,"tactical":10,"survival":15},"impactScore":45,"impactGrade":"NORMAL"}');
    RAISE EXCEPTION 'FAIL: stored v4 accepted expected version 5';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF public.upgrade_analysis_calculation_stored_v4('calc-v5-stored','steam','player_a',3,50,
      '{"score":45,"tier":"B-","breakdown":{"combat":20,"tactical":10,"survival":15},"impactScore":45,"impactGrade":"NORMAL"}')
  THEN RAISE EXCEPTION 'FAIL: stored v4 overwrote a calculation 5 row'; END IF;
  IF (SELECT data FROM public.processed_match_telemetry WHERE match_id='calc-v5-stored') IS DISTINCT FROM before
  THEN RAISE EXCEPTION 'FAIL: calculation 5 row changed by stored v4'; END IF;
  RAISE NOTICE 'PASS: stored v4 upgrade refuses calculation 5 rows';
END $$;

-- 3. 랭킹은 계산 5 요청에서 2~5를 함께 쓰고 같은 경기는 높은 버전을 고른다. 성과 작업은 이전 버전 자료가 있으면 다시 만들지 않는다.
INSERT INTO public.profiles(id,pubg_nickname,pubg_platform,last_active_at)
VALUES ('00000000-0000-0000-0000-000000000905','coexist5','steam',now());
INSERT INTO public.pubg_player_matches(player_id,platform,account_id,match_id,played_at,game_mode,map_name,match_type,kills,damage,win_place,ranking_eligible)
SELECT 'coexist5','steam','account.coexist5',id,now()-interval '1 day',
  CASE WHEN id='c5-mixed' THEN 'duo' ELSE 'squad' END,'Baltic_Main','official',5,500,1,true
FROM unnest(ARRAY['c5-v2','c5-v4','c5-processed','c5-new','c5-mixed']) id;
INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,score,filter_version,population_evidence_version,calculation_version)
VALUES ('c5-v2','steam','coexist5','squad','official','A',70,8,1,2),('c5-v4','steam','coexist5','squad','official','A+',77,8,1,4);
INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
VALUES ('c5-processed','steam','coexist5','{"fullResult":{"calculationVersion":4,"v":73}}');
INSERT INTO public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,score,tier,benchmark,ranking_eligible)
VALUES ('steam','account.coexist5','c5-mixed','coexist5',4,73,92,'S+','{"score":92}',true),
  ('steam','account.coexist5','c5-mixed','coexist5',5,73,74,'A','{"score":74}',true);
DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['squad'],'official',5,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 77::double precision OR r.match_count IS DISTINCT FROM 2::bigint
    THEN RAISE EXCEPTION 'FAIL: v2/v4 ranking missing from v5 reader (% %)', r.value, r.match_count; END IF;
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',5,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 74::double precision OR r.match_count IS DISTINCT FROM 1::bigint
    THEN RAISE EXCEPTION 'FAIL: mixed v4/v5 match duplicated or older result selected'; END IF;
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',4,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 92::double precision THEN RAISE EXCEPTION 'FAIL: v4 reader changed'; END IF;
  SELECT public.seed_pubg_performance_jobs(5,73) INTO n;
  IF NOT EXISTS(SELECT 1 FROM public.pubg_performance_jobs WHERE match_id='c5-new' AND calculation_version=5)
    THEN RAISE EXCEPTION 'FAIL: new-only v5 seeding'; END IF;
  IF EXISTS(SELECT 1 FROM public.pubg_performance_jobs WHERE match_id IN ('c5-v2','c5-v4','c5-processed','c5-mixed') AND calculation_version=5)
    THEN RAISE EXCEPTION 'FAIL: earlier calculation was scheduled again for v5'; END IF;
  RAISE NOTICE 'PASS: v5 ranking merges 2..5, prefers newest, seeds new matches only';
END $$;

-- 4. 텔레메트리 복구 provenance에 계산 5가 포함됐고 함수 권한 경계가 그대로다.
DO $$
BEGIN
  IF position($p$IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb) AND v_benchmark.calculation_version::text$p$ IN (
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery')) = 0
  THEN RAISE EXCEPTION 'FAIL: recovery provenance missing calculation 5'; END IF;
  IF has_function_privilege('anon','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz)','EXECUTE')
    OR has_function_privilege('authenticated','public.seed_pubg_performance_jobs(integer,integer)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: calculation 5 function ACL'; END IF;
  RAISE NOTICE 'PASS: recovery provenance accepts calculation 5, ACL unchanged';
END $$;
ROLLBACK;
