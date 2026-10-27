-- 계산 5: 팀 전멸·소생·교전을 내 기여 기준으로 귀속하고 재투입·중복 이벤트를 바로잡는다(docs/specs/2026-10-28-tactical-score-v5.md).
-- 텔레메트리가 필요한 변경이라 저장 데이터 기반 보정은 없다. 새 분석과 텔레메트리 재분석만 계산 5로 저장한다.
-- 계산 4 migration의 함수 본문에서 버전 목록만 바꾼다. 바꿀 문자열이 없으면 실패해 예상하지 못한 정의를 덮어쓰지 않는다.

DO $migration$
DECLARE definition text; updated_definition text;
  fn record;
BEGIN
  -- 1. 텔레메트리 재분석 결과의 계산 5 저장을 허용한다. 이전 버전 1~4 행만 올릴 수 있다(같은 CAS·계정·모집단 검증).
  FOR fn IN SELECT unnest(ARRAY['upgrade_analysis_calculation','upgrade_analysis_calculation_canonical']) AS name LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=fn.name;
    updated_definition := replace(replace(definition,
      $old$p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb)$old$,
      $new$p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb)$new$),
      $old$NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)$old$,
      $new$NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)$new$);
    IF fn.name = 'upgrade_analysis_calculation' THEN
      updated_definition := replace(updated_definition,
        $old$benchmark.calculation_version NOT IN (1,2,3)$old$,
        $new$benchmark.calculation_version NOT IN (1,2,3,4)$new$);
    END IF;
    IF position($p$'4'::jsonb,'5'::jsonb)$p$ IN updated_definition) = 0
      OR position($p$('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)$p$ IN updated_definition) = 0
      OR (fn.name = 'upgrade_analysis_calculation' AND position('NOT IN (1,2,3,4)' IN updated_definition) = 0)
    THEN RAISE EXCEPTION 'calculation-v5: unexpected % definition', fn.name; END IF;
    EXECUTE updated_definition;
  END LOOP;

  -- 2. 텔레메트리 복구 결과의 계산 버전 provenance에 5를 추가한다.
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery';
  updated_definition := replace(definition,
    $old$v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb) AND v_benchmark.calculation_version::text$old$,
    $new$v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb) AND v_benchmark.calculation_version::text$new$);
  IF definition = updated_definition THEN RAISE EXCEPTION 'calculation-v5: unexpected recovery function'; END IF;
  EXECUTE updated_definition;

  -- 3. 랭킹은 계산 3 이상 요청에서 2 이상 요청 미만 버전을 함께 쓴다(같은 경기는 높은 버전 우선, 계산 4 결정 유지).
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_pubg_rankings';
  updated_definition := replace(definition, 'p_calculation in (3,4) and', 'p_calculation>=3 and');
  IF definition = updated_definition OR position('p_calculation in (3,4)' IN updated_definition) > 0
  THEN RAISE EXCEPTION 'calculation-v5: unexpected ranking function'; END IF;
  EXECUTE updated_definition;

  -- 4. 성과 작업 등록: 이전 계산 버전(2 이상 현재 미만) 자료가 있는 경기는 다시 계산하지 않는다.
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='seed_pubg_performance_jobs';
  updated_definition := replace(definition, 'p_calculation not in (3,4) or', 'p_calculation<3 or');
  IF definition = updated_definition THEN RAISE EXCEPTION 'calculation-v5: unexpected seed function'; END IF;
  EXECUTE updated_definition;
END $migration$;

-- CREATE OR REPLACE는 기존 ACL을 유지한다. 그래도 권한 경계를 다시 고정한다.
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.seed_pubg_performance_jobs(integer,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_pubg_performance_jobs(integer,integer) TO service_role;
