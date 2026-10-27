-- 계산 4 migration 격리 시나리오. 외부 상태나 provider를 쓰지 않는다.
BEGIN;
-- 1. 텔레메트리 재분석 결과의 3→4 CAS, 4→3 하향 거부, 미지원 버전 거부.
DO $$
DECLARE old_data jsonb; old_benchmark jsonb; next_result jsonb; next_benchmark jsonb; actual jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-v4-paired','steam','player_a','{"fullResult":{"matchId":"calc-v4-paired","platform":"steam","player_id":"player_a","v":73,"calculationVersion":3,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,filter_version,population_evidence_version,calculation_version)
  VALUES ('calc-v4-paired','steam','player_a','squad','official','A',100,8,1,3);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-v4-paired';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v4-paired';
  next_result := old_data->'fullResult'||'{"calculationVersion":4,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"official"}';
  next_benchmark := old_benchmark||'{"calculation_version":4,"damage":300}';
  BEGIN
    PERFORM public.upgrade_analysis_calculation('calc-v4-paired','steam','player_a',old_data,old_benchmark,
      jsonb_set(next_result,'{calculationVersion}','5'),jsonb_set(next_benchmark,'{calculation_version}','5'));
    RAISE EXCEPTION 'FAIL: unsupported calculation 5 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF NOT public.upgrade_analysis_calculation('calc-v4-paired','steam','player_a',old_data,old_benchmark,next_result,next_benchmark)
  THEN RAISE EXCEPTION 'FAIL: paired 3 to 4 rejected'; END IF;
  SELECT data INTO actual FROM public.processed_match_telemetry WHERE match_id='calc-v4-paired';
  IF actual->'fullResult' IS DISTINCT FROM next_result
    OR (SELECT calculation_version FROM public.global_benchmarks WHERE match_id='calc-v4-paired') <> 4
  THEN RAISE EXCEPTION 'FAIL: paired v4 readback'; END IF;
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-v4-paired';
  IF public.upgrade_analysis_calculation('calc-v4-paired','steam','player_a',actual,old_benchmark,
    jsonb_set(next_result,'{calculationVersion}','3'),jsonb_set(next_benchmark,'{calculation_version}','3'))
  THEN RAISE EXCEPTION 'FAIL: v4 to v3 RPC downgrade accepted'; END IF;
  -- 배포 전 계산 3 writer가 계산 4 행을 덮어쓰지 못한다(버전 하향 방지 트리거).
  UPDATE public.processed_match_telemetry SET data=old_data WHERE match_id='calc-v4-paired';
  UPDATE public.global_benchmarks SET calculation_version=3,damage=999 WHERE match_id='calc-v4-paired';
  IF (SELECT data FROM public.processed_match_telemetry WHERE match_id='calc-v4-paired') IS DISTINCT FROM actual
    OR (SELECT damage FROM public.global_benchmarks WHERE match_id='calc-v4-paired') <> 300
  THEN RAISE EXCEPTION 'FAIL: v3 worker overwrote v4'; END IF;
  RAISE NOTICE 'PASS: paired 3 to 4, unsupported version and downgrade rejected';
END $$;

-- 2. 저장 데이터 기반 계산 4 보정 RPC.
DO $$
DECLARE upgraded jsonb; got jsonb; untouched jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data) VALUES
    ('calc-v4-stored','steam','player_a','{"other":1,"fullResult":{"matchId":"calc-v4-stored","platform":"steam","player_id":"player_a","v":73,"calculationVersion":3,"stats":{"name":"Player_A"},"tradeStats":{"teammateKnocks":0},"benchmark":{"score":66.6,"tier":"A-","breakdown":{"combat":35,"tactical":18.7,"survival":12.9},"impactScore":70.6,"impactGrade":"NORMAL","impactBonus":4,"impactReasons":["딜량 상위 10%"]}}}'),
    ('calc-v4-stored-short','steam','player_a','{"fullResult":{"matchId":"calc-v4-stored-short","platform":"steam","player_id":"player_a","v":73,"calculationVersion":2,"benchmark":{"score":0,"tier":null,"breakdown":{"combat":0,"tactical":0,"survival":0},"impactScore":0,"impactGrade":"NORMAL","impactBonus":0}}}'),
    ('calc-v4-stored-v72','steam','player_a','{"fullResult":{"matchId":"calc-v4-stored-v72","platform":"steam","player_id":"player_a","v":72,"calculationVersion":3,"benchmark":{"score":50}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,score,combat_score,tactical_score,survival_score,damage,filter_version,population_evidence_version,calculation_version)
  VALUES ('calc-v4-stored','steam','player_a','squad','official','A-',66.6,35,18.7,12.9,500,8,1,3);
  upgraded := '{"score":57.5,"tier":"B+","breakdown":{"combat":35,"tactical":9.6,"survival":12.9},"impactScore":61.5,"impactGrade":"NORMAL"}';

  BEGIN
    PERFORM public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',4,66.6,upgraded);
    RAISE EXCEPTION 'FAIL: expected version 4 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    PERFORM public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',3,66.6,upgraded||'{"tier":"Z"}');
    RAISE EXCEPTION 'FAIL: invalid tier accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    PERFORM public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',3,66.6,upgraded||'{"score":101}');
    RAISE EXCEPTION 'FAIL: out of range score accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',3,60,upgraded)
    OR public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',2,66.6,upgraded)
    OR public.upgrade_analysis_calculation_stored_v4('calc-v4-stored-v72','steam','player_a',3,50,upgraded)
  THEN RAISE EXCEPTION 'FAIL: stale score, wrong version or v72 row accepted'; END IF;

  -- 비교 표본 행이 다른 점수면 두 행 모두 그대로 둔다.
  UPDATE public.global_benchmarks SET score=60 WHERE match_id='calc-v4-stored';
  SELECT data INTO untouched FROM public.processed_match_telemetry WHERE match_id='calc-v4-stored';
  IF public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',3,66.6,upgraded)
  THEN RAISE EXCEPTION 'FAIL: mismatched benchmark score accepted'; END IF;
  IF (SELECT data FROM public.processed_match_telemetry WHERE match_id='calc-v4-stored') IS DISTINCT FROM untouched
  THEN RAISE EXCEPTION 'FAIL: partial write on mismatched benchmark'; END IF;
  UPDATE public.global_benchmarks SET score=66.6 WHERE match_id='calc-v4-stored';

  IF NOT public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',3,66.6,upgraded)
  THEN RAISE EXCEPTION 'FAIL: stored v4 upgrade rejected'; END IF;
  SELECT data INTO got FROM public.processed_match_telemetry WHERE match_id='calc-v4-stored';
  IF got #> '{fullResult,calculationVersion}' IS DISTINCT FROM '4'::jsonb
    OR got #> '{fullResult,benchmark,score}' IS DISTINCT FROM '57.5'::jsonb
    OR got #> '{fullResult,benchmark,breakdown,tactical}' IS DISTINCT FROM '9.6'::jsonb
    OR got #> '{fullResult,benchmark,impactBonus}' IS DISTINCT FROM '4'::jsonb
    OR got #> '{fullResult,benchmark,impactReasons}' IS DISTINCT FROM '["딜량 상위 10%"]'::jsonb
    OR got #> '{fullResult,tradeStats}' IS DISTINCT FROM '{"teammateKnocks":0}'::jsonb
    OR got->'other' IS DISTINCT FROM '1'::jsonb
  THEN RAISE EXCEPTION 'FAIL: stored v4 fullResult readback %', got; END IF;
  IF (SELECT row(score,tier,combat_score,tactical_score,survival_score,calculation_version,damage)::text FROM public.global_benchmarks WHERE match_id='calc-v4-stored')
    IS DISTINCT FROM row(57.5::double precision,'B+'::text,35::double precision,9.6::double precision,12.9::double precision,4,500::double precision)::text
  THEN RAISE EXCEPTION 'FAIL: stored v4 benchmark readback'; END IF;
  IF public.upgrade_analysis_calculation_stored_v4('calc-v4-stored','steam','player_a',3,66.6,upgraded)
  THEN RAISE EXCEPTION 'FAIL: repeated stored v4 upgrade accepted'; END IF;

  -- 300초 미만 경기(비교 표본 없음)는 점수 0 그대로 버전만 올린다.
  -- 같은 식에 서브쿼리를 두면 함수 호출보다 먼저 평가될 수 있어 호출과 확인을 나눈다.
  IF NOT public.upgrade_analysis_calculation_stored_v4('calc-v4-stored-short','steam','player_a',2,0,
    '{"score":0,"tier":null,"breakdown":{"combat":0,"tactical":0,"survival":0},"impactScore":0,"impactGrade":"NORMAL"}')
  THEN RAISE EXCEPTION 'FAIL: short match stored v4 upgrade rejected'; END IF;
  IF (SELECT data #> '{fullResult,calculationVersion}' FROM public.processed_match_telemetry WHERE match_id='calc-v4-stored-short') IS DISTINCT FROM '4'::jsonb
  THEN RAISE EXCEPTION 'FAIL: short match stored v4 readback'; END IF;

  IF NOT has_function_privilege('service_role','public.upgrade_analysis_calculation_stored_v4(text,text,text,integer,numeric,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.upgrade_analysis_calculation_stored_v4(text,text,text,integer,numeric,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.upgrade_analysis_calculation_stored_v4(text,text,text,integer,numeric,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: stored v4 RPC ACL'; END IF;
  RAISE NOTICE 'PASS: stored v4 upgrade CAS, validation, paired write, short match, ACL';
END $$;

-- 3. 랭킹은 계산 4 요청에서 2·3·4를 함께 쓰고 같은 경기는 높은 버전을 고른다. 성과 작업은 이전 버전 자료가 있으면 다시 만들지 않는다.
INSERT INTO public.profiles(id,pubg_nickname,pubg_platform,last_active_at)
VALUES ('00000000-0000-0000-0000-000000000904','coexist4','steam',now());
INSERT INTO public.pubg_player_matches(player_id,platform,account_id,match_id,played_at,game_mode,map_name,match_type,kills,damage,win_place,ranking_eligible)
SELECT 'coexist4','steam','account.coexist4',id,now()-interval '1 day',
  CASE WHEN id='c4-mixed' THEN 'duo' ELSE 'squad' END,'Baltic_Main','official',5,500,1,true
FROM unnest(ARRAY['c4-v2','c4-v3','c4-processed','c4-new','c4-mixed']) id;
INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,score,filter_version,population_evidence_version,calculation_version)
VALUES ('c4-v2','steam','coexist4','squad','official','A',70,8,1,2),('c4-v3','steam','coexist4','squad','official','A+',77,8,1,3);
INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
VALUES ('c4-processed','steam','coexist4','{"fullResult":{"calculationVersion":3,"v":73}}');
INSERT INTO public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,score,tier,benchmark,ranking_eligible)
VALUES ('steam','account.coexist4','c4-mixed','coexist4',3,73,92,'S+','{"score":92}',true),
  ('steam','account.coexist4','c4-mixed','coexist4',4,73,74,'A','{"score":74}',true);
DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['squad'],'official',4,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 77::double precision OR r.match_count IS DISTINCT FROM 2::bigint
    THEN RAISE EXCEPTION 'FAIL: v2/v3 ranking missing from v4 reader (% %)', r.value, r.match_count; END IF;
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',4,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 74::double precision OR r.match_count IS DISTINCT FROM 1::bigint
    THEN RAISE EXCEPTION 'FAIL: mixed v3/v4 match duplicated or older result selected'; END IF;
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',3,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 92::double precision THEN RAISE EXCEPTION 'FAIL: v3 reader changed'; END IF;
  SELECT public.seed_pubg_performance_jobs(4,73) INTO n;
  IF NOT EXISTS(SELECT 1 FROM public.pubg_performance_jobs WHERE match_id='c4-new' AND calculation_version=4)
    THEN RAISE EXCEPTION 'FAIL: new-only v4 seeding'; END IF;
  IF EXISTS(SELECT 1 FROM public.pubg_performance_jobs WHERE match_id IN ('c4-v2','c4-v3','c4-processed','c4-mixed') AND calculation_version=4)
    THEN RAISE EXCEPTION 'FAIL: earlier calculation was scheduled again for v4'; END IF;
  RAISE NOTICE 'PASS: v4 ranking merges 2/3/4, prefers newest, seeds new matches only';
END $$;

-- 4. 텔레메트리 복구 provenance에 계산 4가 포함됐다.
DO $$
BEGIN
  IF position($p$IN ('2'::jsonb,'3'::jsonb,'4'::jsonb) AND v_benchmark.calculation_version::text$p$ IN (
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery')) = 0
  THEN RAISE EXCEPTION 'FAIL: recovery provenance missing calculation 4'; END IF;
  RAISE NOTICE 'PASS: recovery provenance accepts calculation 4';
END $$;
ROLLBACK;
