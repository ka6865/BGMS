-- BGMS 기록 백분위 RPC 격리 시나리오. 외부 상태나 provider를 쓰지 않는다.
BEGIN;
DO $$
DECLARE actual text;
BEGIN
  -- 앞 시나리오가 남긴 행을 이 트랜잭션 안에서만 비운다. 끝에서 ROLLBACK한다.
  DELETE FROM public.global_benchmarks WHERE true;
  -- 비교 대상 경기(생존 5분 이상 행이 있음)와 같은 모드·유형 모집단 3행, 다른 유형 1행, 90일 밖 1행, 집계 제외 행 1행.
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,kills,survival_time,filter_version,population_evidence_version,calculation_version,created_at) VALUES
    ('pct-me','steam','player_a','squad','competitive','B',300,2,900,8,1,6,now()),
    ('pct-1','steam','player_b','squad','competitive','A',500,2,1200,8,1,5,now()),
    ('pct-2','kakao','player_c','squad','competitive','C',100,0,400,8,1,4,now()),
    ('pct-3','steam','player_d','squad','official','A',900,9,1500,8,1,6,now()),
    ('pct-old','steam','player_e','squad','competitive','S',2000,10,1700,8,1,6,now()-interval '91 days'),
    ('pct-legacy','steam','player_f','squad','competitive','S',2000,10,1700,8,1,null,now());
  SELECT string_agg(format('%s:%s:%s:%s:%s:%s', metric, game_mode, match_type, sample_count, at_or_above, at_or_below), ',' ORDER BY metric)
    INTO actual FROM public.get_pubg_benchmark_percentiles('pct-me','steam','player_a');
  IF actual IS DISTINCT FROM 'damage:squad:competitive:3:2:2,kills:squad:competitive:3:2:3,survival_time:squad:competitive:3:2:2'
  THEN RAISE EXCEPTION 'FAIL: percentile counts %', actual; END IF;

  -- 모집단 행이 없는 경기(조기 탈락·사용자 정의 등)는 빈 결과다.
  IF EXISTS (SELECT 1 FROM public.get_pubg_benchmark_percentiles('pct-missing','steam','player_a'))
  THEN RAISE EXCEPTION 'FAIL: missing benchmark row returned percentiles'; END IF;
  IF EXISTS (SELECT 1 FROM public.get_pubg_benchmark_percentiles('pct-legacy','steam','player_f'))
  THEN RAISE EXCEPTION 'FAIL: legacy calculation row returned percentiles'; END IF;

  IF has_function_privilege('anon','public.get_pubg_benchmark_percentiles(text,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.get_pubg_benchmark_percentiles(text,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.get_pubg_benchmark_percentiles(text,text,text)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: percentile RPC grants'; END IF;
END $$;
ROLLBACK;
