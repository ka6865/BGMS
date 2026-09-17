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
    OR p_full_result->'calculationVersion' IS DISTINCT FROM '2'::jsonb
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
    OR (previous.data #> '{fullResult,calculationVersion}' IS NOT NULL AND previous.data #> '{fullResult,calculationVersion}' NOT IN ('null'::jsonb,'1'::jsonb))
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
