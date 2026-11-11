-- 계산 6: 딜량 동점 순위를 입력 순서와 무관하게 정하고, 오래된 위치·미관측 적으로 고립 지수를 만들지 않는다
-- (docs/specs/2026-11-11-tactical-score-v6.md).
-- 텔레메트리가 필요한 변경이라 저장 데이터 기반 보정은 없다. 새 분석과 텔레메트리 재분석만 계산 6으로 저장한다.
-- 랭킹(p_calculation>=3)·성과 작업(p_calculation<3) guard는 계산 5에서 일반화했으므로 바꾸지 않는다.
-- 함수 본문에서 버전 목록만 바꾼다. 바꿀 문자열이 없으면 실패해 예상하지 못한 정의를 덮어쓰지 않는다.

DO $migration$
DECLARE definition text; updated_definition text;
  fn record;
BEGIN
  -- 1. 텔레메트리 재분석 결과의 계산 6 저장을 허용한다. 이전 버전 1~5 행만 올릴 수 있다(같은 CAS·계정·모집단 검증).
  FOR fn IN SELECT unnest(ARRAY['upgrade_analysis_calculation','upgrade_analysis_calculation_canonical']) AS name LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=fn.name;
    updated_definition := replace(replace(definition,
      $old$p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb)$old$,
      $new$p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb)$new$),
      $old$NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)$old$,
      $new$NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb)$new$);
    IF fn.name = 'upgrade_analysis_calculation' THEN
      updated_definition := replace(updated_definition,
        $old$benchmark.calculation_version NOT IN (1,2,3,4)$old$,
        $new$benchmark.calculation_version NOT IN (1,2,3,4,5)$new$);
    END IF;
    IF position($p$'5'::jsonb,'6'::jsonb)$p$ IN updated_definition) = 0
      OR position($p$('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb)$p$ IN updated_definition) = 0
      OR (fn.name = 'upgrade_analysis_calculation' AND position('NOT IN (1,2,3,4,5)' IN updated_definition) = 0)
    THEN RAISE EXCEPTION 'calculation-v6: unexpected % definition', fn.name; END IF;
    EXECUTE updated_definition;
  END LOOP;

  -- 2. 텔레메트리 복구 결과의 계산 버전 provenance에 6을 추가한다.
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery';
  updated_definition := replace(definition,
    $old$v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb) AND v_benchmark.calculation_version::text$old$,
    $new$v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb) AND v_benchmark.calculation_version::text$new$);
  IF definition = updated_definition THEN RAISE EXCEPTION 'calculation-v6: unexpected recovery function'; END IF;
  EXECUTE updated_definition;
END $migration$;

-- CREATE OR REPLACE는 기존 ACL을 유지한다. 그래도 권한 경계를 다시 고정한다.
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) TO service_role;
