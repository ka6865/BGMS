-- Additive rollout: old binaries keep the original view. Never relabel old rows.
ALTER TABLE public.global_benchmarks ADD COLUMN IF NOT EXISTS calculation_version integer;
COMMENT ON COLUMN public.global_benchmarks.calculation_version IS 'Calculation provenance from canonical fullResult; NULL means unknown legacy arithmetic.';
CREATE OR REPLACE VIEW public.benchmark_stats_by_tier_v2
WITH (security_invoker = true)
AS
SELECT
  b.tier,
  b.game_mode,
  b.match_type,
  count(*) AS match_count,
  avg(NULLIF(b.damage, -1::double precision)) AS avg_damage,
  avg(NULLIF(b.kills, -1)) AS avg_kills,
  avg(NULLIF(b.survival_time, -1)) AS avg_survival_time,
  avg(NULLIF(b.duel_win_rate, -1::double precision)) AS avg_duel_win_rate,
  avg(NULLIF(b.initiative_rate, -1::double precision)) AS avg_initiative_rate,
  avg(NULLIF(b.trade_rate, -1::double precision)) AS avg_trade_rate,
  avg(NULLIF(b.revive_rate, -1::double precision)) AS avg_revive_rate,
  avg(NULLIF(b.smoke_rate, -1::double precision)) AS avg_smoke_rate,
  avg(NULLIF(b.pressure_index, -1::double precision)) AS avg_pressure_index,
  avg(NULLIF(b.team_wipes, -1)) AS avg_team_wipes,
  avg(NULLIF(b.reversal_rate, -1::double precision)) AS avg_reversal_rate,
  avg(NULLIF(b.isolation_index, -1::double precision)) AS avg_isolation_index,
  avg(NULLIF(b.min_dist, -1::double precision)) AS avg_min_dist,
  avg(NULLIF(b.counter_latency_ms, -1::double precision)) AS avg_counter_latency_ms,
  avg(NULLIF(b.trade_latency_ms, -1::double precision)) AS avg_trade_latency_ms,
  avg(NULLIF(b.solo_kill_rate, -1)) AS avg_solo_kill_rate,
  avg(NULLIF(b.death_phase, -1)) AS avg_death_phase,
  8::integer AS filter_version,
  1::integer AS population_evidence_version,
  count(*) FILTER (WHERE NULLIF(b.damage, -1::double precision) IS NOT NULL) AS avg_damage_count,
  count(*) FILTER (WHERE NULLIF(b.kills, -1) IS NOT NULL) AS avg_kills_count,
  count(*) FILTER (WHERE NULLIF(b.survival_time, -1) IS NOT NULL) AS avg_survival_time_count,
  count(*) FILTER (WHERE NULLIF(b.duel_win_rate, -1::double precision) IS NOT NULL) AS avg_duel_win_rate_count,
  count(*) FILTER (WHERE NULLIF(b.initiative_rate, -1::double precision) IS NOT NULL) AS avg_initiative_rate_count,
  count(*) FILTER (WHERE NULLIF(b.trade_rate, -1::double precision) IS NOT NULL) AS avg_trade_rate_count,
  count(*) FILTER (WHERE NULLIF(b.revive_rate, -1::double precision) IS NOT NULL) AS avg_revive_rate_count,
  count(*) FILTER (WHERE NULLIF(b.smoke_rate, -1::double precision) IS NOT NULL) AS avg_smoke_rate_count,
  count(*) FILTER (WHERE NULLIF(b.pressure_index, -1::double precision) IS NOT NULL) AS avg_pressure_index_count,
  count(*) FILTER (WHERE NULLIF(b.team_wipes, -1) IS NOT NULL) AS avg_team_wipes_count,
  count(*) FILTER (WHERE NULLIF(b.reversal_rate, -1::double precision) IS NOT NULL) AS avg_reversal_rate_count,
  count(*) FILTER (WHERE NULLIF(b.isolation_index, -1::double precision) IS NOT NULL) AS avg_isolation_index_count,
  count(*) FILTER (WHERE NULLIF(b.min_dist, -1::double precision) IS NOT NULL) AS avg_min_dist_count,
  count(*) FILTER (WHERE NULLIF(b.counter_latency_ms, -1::double precision) IS NOT NULL) AS avg_counter_latency_ms_count,
  count(*) FILTER (WHERE NULLIF(b.trade_latency_ms, -1::double precision) IS NOT NULL) AS avg_trade_latency_ms_count,
  count(*) FILTER (WHERE NULLIF(b.solo_kill_rate, -1) IS NOT NULL) AS avg_solo_kill_rate_count,
  count(*) FILTER (WHERE NULLIF(b.death_phase, -1) IS NOT NULL) AS avg_death_phase_count,
  b.calculation_version
FROM public.global_benchmarks AS b
WHERE b.filter_version = 8
  AND b.population_evidence_version = 1
  AND b.match_type IN ('official', 'competitive')
  AND b.game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')
GROUP BY b.tier, b.game_mode, b.match_type, b.calculation_version;

ALTER VIEW public.benchmark_stats_by_tier_v2 OWNER TO postgres;
GRANT SELECT ON TABLE public.benchmark_stats_by_tier_v2 TO anon, authenticated;
GRANT ALL ON TABLE public.benchmark_stats_by_tier_v2 TO service_role;


CREATE INDEX IF NOT EXISTS idx_global_benchmarks_calculation_population
ON public.global_benchmarks (calculation_version, game_mode, match_type, tier)
WHERE filter_version = 8 AND population_evidence_version = 1 AND calculation_version IS NOT NULL;

-- Preserve recovery's existing lease/identity guards while allowing the new
-- canonical map key. Old v61 workers remain compatible during rollout.
DO $migration$
DECLARE fn record; definition text; updated_definition text; recovery_function_count integer;
BEGIN
  SELECT count(*) INTO recovery_function_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'claim_telemetry_cache_recovery_write',
      'release_telemetry_cache_recovery_write',
      'finalize_telemetry_cache_recovery'
    );
  IF recovery_function_count <> 3 THEN
    RAISE EXCEPTION 'calculation migration: expected exactly 3 recovery functions, found %', recovery_function_count;
  END IF;
  FOR fn IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('claim_telemetry_cache_recovery_write','release_telemetry_cache_recovery_write','finalize_telemetry_cache_recovery')
  LOOP
    definition := pg_get_functiondef(fn.oid);
    updated_definition := replace(definition, 'p_telemetry_version is distinct from 61', 'p_telemetry_version not in (61, 62)');
    updated_definition := replace(updated_definition,
      $old$    or p_storage_path !~ (
      '^telemetry-map/v61/' || p_platform || '/' || p_match_id
      || '/[a-f0-9]{32}/lite[.]json$'
    )$old$,
      $new$    or array_length(string_to_array(p_storage_path, '/'), 1) <> 6
    or split_part(p_storage_path, '/', 1) <> 'telemetry-map'
    or split_part(p_storage_path, '/', 2) <> ('v' || trunc(p_telemetry_version)::text)
    or split_part(p_storage_path, '/', 3) <> p_platform
    or split_part(p_storage_path, '/', 4) <> p_match_id
    or split_part(p_storage_path, '/', 5) !~ '^[a-f0-9]{32}$'
    or split_part(p_storage_path, '/', 6) <> 'lite.json'$new$);
    IF fn.proname='finalize_telemetry_cache_recovery' THEN
      updated_definition := replace(updated_definition,
        $old$      'filter_version', 'population_evidence_version', 'source'$old$,
        $new$      'filter_version', 'population_evidence_version', 'source', 'calculation_version'$new$);
      updated_definition := replace(updated_definition,
        $old$population_evidence_version integer,
    source text$old$,
        $new$population_evidence_version integer,
    calculation_version integer,
    source text$new$);
      updated_definition := replace(updated_definition,
        'filter_version = v_benchmark.filter_version,',
        'calculation_version = CASE WHEN v_processed.data #>> ''{fullResult,calculationVersion}'' = ''2'' AND v_benchmark.calculation_version = 2 THEN 2 ELSE NULL END, filter_version = v_benchmark.filter_version,');
      updated_definition := replace(updated_definition,
        $old$  where benchmark.id = v_benchmark_id
  for update;
  if not found
    or v_previous_benchmark.match_id is null$old$,
        $new$  where benchmark.id = v_benchmark_id
  for update;
  if not found
    or v_previous_benchmark.calculation_version is not null
    or v_previous_benchmark.match_id is null$new$);
    END IF;
    IF definition = updated_definition THEN
      RAISE EXCEPTION 'calculation migration: unexpected recovery function %', fn.proname;
    END IF;
    IF position('p_telemetry_version not in (61, 62)' in updated_definition) = 0 THEN
      RAISE EXCEPTION 'calculation migration: version guard replacement missing for %', fn.proname;
    END IF;
    IF fn.proname = 'claim_telemetry_cache_recovery_write'
      AND (
        position('array_length(string_to_array(p_storage_path, ''/''), 1) <> 6' in updated_definition) = 0
        OR position('split_part(p_storage_path, ''/'', 4) <> p_match_id' in updated_definition) = 0
        OR position('split_part(p_storage_path, ''/'', 5) !~ ''^[a-f0-9]{32}$''' in updated_definition) = 0
      )
    THEN
      RAISE EXCEPTION 'calculation migration: exact recovery path replacement missing';
    END IF;
    IF fn.proname = 'finalize_telemetry_cache_recovery'
      AND (
        position('''source'', ''calculation_version''' in updated_definition) = 0
        OR position('calculation_version integer' in updated_definition) = 0
        OR position('calculation_version = CASE WHEN v_processed.data' in updated_definition) = 0
        OR position('v_previous_benchmark.calculation_version is not null' in updated_definition) = 0
      )
    THEN
      RAISE EXCEPTION 'calculation migration: finalize calculation contract replacement missing';
    END IF;
    EXECUTE updated_definition;
  END LOOP;
END $migration$;

-- Old workers must not overwrite a result/benchmark upgraded by the canary.
CREATE OR REPLACE FUNCTION public.preserve_analysis_calculation_version()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous_version integer; incoming_version integer;
BEGIN
  IF TG_TABLE_NAME='global_benchmarks' THEN
    previous_version := OLD.calculation_version;
    incoming_version := NEW.calculation_version;
  ELSE
    previous_version := CASE WHEN OLD.data #>> '{fullResult,calculationVersion}' ~ '^[0-9]{1,6}$' THEN (OLD.data #>> '{fullResult,calculationVersion}')::integer END;
    incoming_version := CASE WHEN NEW.data #>> '{fullResult,calculationVersion}' ~ '^[0-9]{1,6}$' THEN (NEW.data #>> '{fullResult,calculationVersion}')::integer END;
  END IF;
  IF previous_version IS NOT NULL AND (incoming_version IS NULL OR incoming_version < previous_version) THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.preserve_analysis_calculation_version() FROM public, anon, authenticated;
DROP TRIGGER IF EXISTS preserve_calculation_version ON public.global_benchmarks;
CREATE TRIGGER preserve_calculation_version BEFORE UPDATE ON public.global_benchmarks FOR EACH ROW EXECUTE FUNCTION public.preserve_analysis_calculation_version();
DROP TRIGGER IF EXISTS preserve_calculation_version ON public.processed_match_telemetry;
CREATE TRIGGER preserve_calculation_version BEFORE UPDATE ON public.processed_match_telemetry FOR EACH ROW EXECUTE FUNCTION public.preserve_analysis_calculation_version();

-- Bounded repair of one existing canonical v73 row. Exact snapshots are the
-- compare-and-swap guard. This never fetches telemetry or generates AI.
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
    OR p_full_result->'calculationVersion' IS DISTINCT FROM '2'::jsonb
    OR p_full_result->'populationEvidenceVersion' IS DISTINCT FROM '1'::jsonb
    OR p_benchmark->>'match_id' IS DISTINCT FROM p_match_id
    OR p_benchmark->>'platform' IS DISTINCT FROM p_platform
    OR p_benchmark->>'player_id' IS DISTINCT FROM p_player_id
    OR p_benchmark->'calculation_version' IS DISTINCT FROM '2'::jsonb
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
    OR (previous.data #> '{fullResult,calculationVersion}' IS NOT NULL AND previous.data #> '{fullResult,calculationVersion}' IS DISTINCT FROM 'null'::jsonb AND previous.data #> '{fullResult,calculationVersion}' IS DISTINCT FROM '1'::jsonb)
    OR coalesce(previous.data #>> '{fullResult,stats,playerId}', previous.data #>> '{fullResult,stats,accountId}') IS DISTINCT FROM coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}')
    OR coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}') IS NULL
  THEN RETURN false; END IF;
  SELECT * INTO benchmark FROM public.global_benchmarks
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR to_jsonb(benchmark) IS DISTINCT FROM p_expected_benchmark OR benchmark.calculation_version >= 2 THEN RETURN false; END IF;
  UPDATE public.processed_match_telemetry SET data=jsonb_set(previous.data,'{fullResult}',p_full_result), updated_at=now()
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id;
  UPDATE public.global_benchmarks SET (damage, kills, win_place, game_mode, map_name, counter_latency_ms, initiative_rate, revive_rate, is_crossfire, utility_count, smoke_count, frag_count, pressure_index, enemy_death_distance, survival_time, isolation_index, min_dist, height_diff, smoke_rate, trade_rate, solo_kill_rate, reversal_rate, duel_win_rate, trade_latency_ms, lethal_throw_count, score, combat_score, tactical_score, survival_score, supp_count, team_wipes, match_type, death_phase, calculation_version, filter_version, population_evidence_version, source, tier) =
    (SELECT damage, kills, win_place, game_mode, map_name, counter_latency_ms, initiative_rate, revive_rate, is_crossfire, utility_count, smoke_count, frag_count, pressure_index, enemy_death_distance, survival_time, isolation_index, min_dist, height_diff, smoke_rate, trade_rate, solo_kill_rate, reversal_rate, duel_win_rate, trade_latency_ms, lethal_throw_count, score, combat_score, tactical_score, survival_score, supp_count, team_wipes, match_type, death_phase, calculation_version, filter_version, population_evidence_version, source, tier FROM jsonb_populate_record(NULL::public.global_benchmarks, to_jsonb(benchmark)||p_benchmark))
    WHERE id=benchmark.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;
