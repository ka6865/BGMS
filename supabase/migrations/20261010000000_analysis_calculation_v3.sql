-- 계산 버전 2와 3의 검증된 재계산을 허용한다. 기존 행을 재라벨하지 않는다.
-- 이전 snapshot·계정·모집단·권한 검증과 버전 하향 방지 트리거를 유지한다.
CREATE OR REPLACE FUNCTION public.upgrade_analysis_calculation(
  p_match_id text, p_platform text, p_player_id text,
  p_expected_data jsonb, p_expected_benchmark jsonb,
  p_full_result jsonb, p_benchmark jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous public.processed_match_telemetry%ROWTYPE;
  benchmark public.global_benchmarks%ROWTYPE;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('steam','kakao') OR p_player_id IS NULL OR p_match_id IS NULL
    OR p_full_result->>'matchId' IS DISTINCT FROM p_match_id
    OR p_full_result->>'platform' IS DISTINCT FROM p_platform
    OR p_full_result->>'player_id' IS DISTINCT FROM p_player_id
    OR lower(trim(p_full_result #>> '{stats,name}')) IS DISTINCT FROM p_player_id
    OR p_full_result->'v' IS DISTINCT FROM '73'::jsonb
    OR p_full_result->'calculationVersion' IS NULL OR p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb)
    OR p_full_result->'populationEvidenceVersion' IS DISTINCT FROM '1'::jsonb
    OR p_benchmark->>'match_id' IS DISTINCT FROM p_match_id
    OR p_benchmark->>'platform' IS DISTINCT FROM p_platform
    OR p_benchmark->>'player_id' IS DISTINCT FROM p_player_id
    OR p_benchmark->'calculation_version' IS DISTINCT FROM p_full_result->'calculationVersion'
    OR p_benchmark->'filter_version' IS DISTINCT FROM '8'::jsonb
    OR p_benchmark->'population_evidence_version' IS DISTINCT FROM '1'::jsonb
    OR p_full_result->>'gameMode' IS DISTINCT FROM p_benchmark->>'game_mode'
    OR p_full_result->>'matchType' IS DISTINCT FROM p_benchmark->>'match_type'
    OR p_benchmark->>'game_mode' IS NULL
    OR (p_benchmark->>'game_mode') NOT IN ('solo','solo-fpp','duo','duo-fpp','squad','squad-fpp')
    OR p_benchmark->>'match_type' IS NULL
    OR (p_benchmark->>'match_type') NOT IN ('official','competitive')
  THEN RAISE EXCEPTION 'calculation-upgrade-invalid-input' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.processed_match_telemetry
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR previous.data IS DISTINCT FROM p_expected_data
    OR previous.data #> '{fullResult,v}' IS DISTINCT FROM '73'::jsonb
    OR previous.data #>> '{fullResult,matchId}' IS DISTINCT FROM p_match_id
    OR previous.data #>> '{fullResult,platform}' IS DISTINCT FROM p_platform
    OR previous.data #>> '{fullResult,player_id}' IS DISTINCT FROM p_player_id
    OR (previous.data #> '{fullResult,calculationVersion}' IS NOT NULL AND previous.data #> '{fullResult,calculationVersion}' <> 'null'::jsonb
      AND (previous.data #> '{fullResult,calculationVersion}' NOT IN ('1'::jsonb,'2'::jsonb)
        OR previous.data #> '{fullResult,calculationVersion}' >= p_full_result->'calculationVersion'))
    OR coalesce(previous.data #>> '{fullResult,stats,playerId}', previous.data #>> '{fullResult,stats,accountId}') IS DISTINCT FROM coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}')
    OR coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}') IS NULL
  THEN RETURN false; END IF;
  SELECT * INTO benchmark FROM public.global_benchmarks
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR to_jsonb(benchmark) IS DISTINCT FROM p_expected_benchmark OR (benchmark.calculation_version IS NOT NULL AND (benchmark.calculation_version NOT IN (1,2)
      OR benchmark.calculation_version >= (p_full_result->>'calculationVersion')::integer)) THEN RETURN false; END IF;
  UPDATE public.processed_match_telemetry SET data=jsonb_set(previous.data,'{fullResult}',p_full_result), updated_at=now()
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id;
  UPDATE public.global_benchmarks SET (damage, kills, win_place, game_mode, map_name, counter_latency_ms, initiative_rate, revive_rate, is_crossfire, utility_count, smoke_count, frag_count, pressure_index, enemy_death_distance, survival_time, isolation_index, min_dist, height_diff, smoke_rate, trade_rate, solo_kill_rate, reversal_rate, duel_win_rate, trade_latency_ms, lethal_throw_count, score, combat_score, tactical_score, survival_score, supp_count, team_wipes, match_type, death_phase, calculation_version, filter_version, population_evidence_version, source, tier) =
    (SELECT damage, kills, win_place, game_mode, map_name, counter_latency_ms, initiative_rate, revive_rate, is_crossfire, utility_count, smoke_count, frag_count, pressure_index, enemy_death_distance, survival_time, isolation_index, min_dist, height_diff, smoke_rate, trade_rate, solo_kill_rate, reversal_rate, duel_win_rate, trade_latency_ms, lethal_throw_count, score, combat_score, tactical_score, survival_score, supp_count, team_wipes, match_type, death_phase, calculation_version, filter_version, population_evidence_version, source, tier FROM jsonb_populate_record(NULL::public.global_benchmarks, to_jsonb(benchmark)||p_benchmark))
    WHERE id=benchmark.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;

-- Short-lived matches have no comparison benchmark, but still need current personal calculations.
CREATE OR REPLACE FUNCTION public.upgrade_analysis_calculation_canonical(
  p_match_id text, p_platform text, p_player_id text,
  p_expected_data jsonb, p_full_result jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous public.processed_match_telemetry%ROWTYPE;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('steam','kakao') OR nullif(p_player_id,'') IS NULL OR nullif(p_match_id,'') IS NULL
    OR p_full_result->>'matchId' IS DISTINCT FROM p_match_id
    OR p_full_result->>'platform' IS DISTINCT FROM p_platform
    OR p_full_result->>'player_id' IS DISTINCT FROM p_player_id
    OR lower(trim(p_full_result #>> '{stats,name}')) IS DISTINCT FROM p_player_id
    OR p_full_result->'v' IS DISTINCT FROM '73'::jsonb
    OR p_full_result->'calculationVersion' IS NULL OR p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb)
    OR p_full_result->'populationEvidenceVersion' IS DISTINCT FROM '1'::jsonb
    OR p_full_result->>'gameMode' IS NULL OR p_full_result->>'gameMode' NOT IN ('solo','solo-fpp','duo','duo-fpp','squad','squad-fpp')
    OR p_full_result->>'matchType' IS NULL OR p_full_result->>'matchType' NOT IN ('official','competitive')
  THEN RAISE EXCEPTION 'canonical-calculation-invalid-input' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.processed_match_telemetry
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR previous.data IS DISTINCT FROM p_expected_data
    OR previous.data #> '{fullResult,v}' IS NULL OR previous.data #> '{fullResult,v}' NOT IN ('72'::jsonb,'73'::jsonb)
    OR coalesce(previous.data #>> '{fullResult,matchId}',previous.data #>> '{fullResult,match_id}',previous.data #>> '{fullResult,id}') IS DISTINCT FROM p_match_id
    OR previous.data #>> '{fullResult,platform}' IS DISTINCT FROM p_platform
    OR previous.data #>> '{fullResult,player_id}' IS DISTINCT FROM p_player_id
    OR lower(trim(previous.data #>> '{fullResult,stats,name}')) IS DISTINCT FROM p_player_id
    OR (previous.data #> '{fullResult,calculationVersion}' IS NOT NULL AND previous.data #> '{fullResult,calculationVersion}' <> 'null'::jsonb
      AND (previous.data #> '{fullResult,calculationVersion}' NOT IN ('1'::jsonb,'2'::jsonb)
        OR previous.data #> '{fullResult,calculationVersion}' >= p_full_result->'calculationVersion'))
    OR coalesce(previous.data #>> '{fullResult,stats,playerId}', previous.data #>> '{fullResult,stats,accountId}') IS DISTINCT FROM coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}')
    OR nullif(coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}'),'') IS NULL
  THEN RETURN false; END IF;
  -- A normal eligible comparison row must use the paired CAS RPC instead.
  -- This function never inserts or changes comparison samples.
  IF p_full_result->'isValidBenchmark' IS DISTINCT FROM 'false'::jsonb AND EXISTS (
    SELECT 1 FROM public.global_benchmarks WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id
      AND filter_version=8 AND population_evidence_version=1
      AND match_type IN ('official','competitive') AND game_mode IN ('solo','solo-fpp','duo','duo-fpp','squad','squad-fpp')
  ) THEN RETURN false; END IF;
  UPDATE public.processed_match_telemetry SET data=jsonb_set(previous.data,'{fullResult}',p_full_result),updated_at=now()
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) TO service_role;

-- 새 복구 결과의 두 계산 버전이 일치할 때만 provenance를 기록한다.
DO $migration$
DECLARE definition text; updated_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery';
  updated_definition := replace(definition,
    $old$calculation_version = CASE WHEN v_processed.data #>> '{fullResult,calculationVersion}' = '2' AND v_benchmark.calculation_version = 2 THEN 2 ELSE NULL END$old$,
    $new$calculation_version = CASE WHEN v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb) AND v_benchmark.calculation_version::text = v_processed.data #>> '{fullResult,calculationVersion}' THEN v_benchmark.calculation_version ELSE NULL END$new$);
  IF definition = updated_definition THEN RAISE EXCEPTION 'calculation-v3: unexpected recovery function'; END IF;
  EXECUTE updated_definition;
END $migration$;
