-- Isolated calculation rollout scenarios; no external state or provider.
DO $$
DECLARE old_data jsonb; old_benchmark jsonb; next_result jsonb; next_benchmark jsonb; result boolean; got jsonb;
BEGIN
  INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
  VALUES ('calc-canary','steam','player_a', '{"fullResult":{"matchId":"calc-canary","platform":"steam","player_id":"player_a","v":73,"stats":{"name":"Player_A","playerId":"account.a"}}}');
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,filter_version,population_evidence_version)
  VALUES ('calc-canary','steam','player_a','squad','competitive','B',100,8,1);
  SELECT data INTO old_data FROM public.processed_match_telemetry WHERE match_id='calc-canary';
  SELECT to_jsonb(b) INTO old_benchmark FROM public.global_benchmarks b WHERE match_id='calc-canary';
  IF old_benchmark->'calculation_version' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'FAIL: legacy provenance relabeled'; END IF;
  next_result := old_data->'fullResult' || '{"calculationVersion":2,"populationEvidenceVersion":1,"gameMode":"squad","matchType":"competitive"}';
  next_benchmark := old_benchmark || '{"calculation_version":2,"damage":320}';
  result := public.upgrade_analysis_calculation('calc-canary','steam','player_a',old_data||'{"changed":true}',old_benchmark,next_result,next_benchmark);
  IF result THEN RAISE EXCEPTION 'FAIL: stale processed snapshot accepted'; END IF;
  result := public.upgrade_analysis_calculation('calc-canary','steam','player_a',old_data,old_benchmark||'{"damage":999}',next_result,next_benchmark);
  IF result THEN RAISE EXCEPTION 'FAIL: stale benchmark snapshot accepted'; END IF;
  result := public.upgrade_analysis_calculation('calc-canary','steam','player_a',old_data,old_benchmark,next_result,next_benchmark);
  IF NOT result THEN RAISE EXCEPTION 'FAIL: canonical calculation upgrade rejected'; END IF;
  SELECT data INTO got FROM public.processed_match_telemetry WHERE match_id='calc-canary';
  IF got->'fullResult' IS DISTINCT FROM next_result THEN RAISE EXCEPTION 'FAIL: wrong upgraded result'; END IF;
  IF (SELECT damage FROM public.global_benchmarks WHERE match_id='calc-canary') <> 320 THEN RAISE EXCEPTION 'FAIL: benchmark did not upgrade'; END IF;
  result := public.upgrade_analysis_calculation('calc-canary','steam','player_a',old_data,old_benchmark,next_result,next_benchmark);
  IF result THEN RAISE EXCEPTION 'FAIL: duplicate canary applied'; END IF;
  UPDATE public.processed_match_telemetry SET data=old_data WHERE match_id='calc-canary';
  UPDATE public.global_benchmarks SET calculation_version=NULL,damage=999 WHERE match_id='calc-canary';
  IF (SELECT data FROM public.processed_match_telemetry WHERE match_id='calc-canary') IS DISTINCT FROM got
    OR (SELECT damage FROM public.global_benchmarks WHERE match_id='calc-canary') <> 320 THEN RAISE EXCEPTION 'FAIL: older worker overwrote upgraded records'; END IF;
  INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,damage,filter_version,population_evidence_version,calculation_version)
  VALUES ('calc-legacy','steam','player_a','squad','competitive','B',900,8,1,NULL),('calc-v1','steam','player_a','squad','competitive','B',600,8,1,1);
  IF (SELECT avg_damage FROM public.benchmark_stats_by_tier_v2 WHERE game_mode='squad' AND match_type='competitive' AND tier='B' AND calculation_version=2) <> 320 THEN RAISE EXCEPTION 'FAIL: versions mixed in new view'; END IF;
  IF NOT has_function_privilege('service_role','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'FAIL: calculation RPC ACL'; END IF;
  RAISE NOTICE 'PASS: calculation provenance, atomic snapshots, repeat/downgrade prevention and isolated aggregates';
END $$;
DO $$
DECLARE
  claimed boolean;
  token uuid := '00000000-0000-4000-8000-000000000062';
  dotted_v62_token uuid := '00000000-0000-4000-8000-000000000063';
  dotted_v61_token uuid := '00000000-0000-4000-8000-000000000064';
BEGIN
  claimed := public.claim_telemetry_cache_recovery_write('calc-cache','steam','account.calc','lite',62,'telemetry-map/v62/steam/calc-cache/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/lite.json',now()+interval '2 minutes',token,now());
  IF NOT claimed THEN RAISE EXCEPTION 'FAIL: v62 recovery claim rejected'; END IF;
  IF NOT public.release_telemetry_cache_recovery_write('calc-cache','steam','account.calc','lite',62,token) THEN RAISE EXCEPTION 'FAIL: v62 recovery release rejected'; END IF;
  BEGIN
    PERFORM public.claim_telemetry_cache_recovery_write('calc-cache','steam','account.calc','lite',62,'telemetry-map/v61/steam/calc-cache/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/lite.json',now()+interval '2 minutes',token,now());
    RAISE EXCEPTION 'FAIL: mismatched map key version accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  -- A canonical match id may contain a dot.  The storage key must compare
  -- path segments exactly; a regex interpolation would treat the dot as a
  -- wildcard and accept the calcXcache variant below.
  claimed := public.claim_telemetry_cache_recovery_write(
    'calc.cache','steam','account.calc.v62','lite',62,
    'telemetry-map/v62/steam/calc.cache/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/lite.json',
    now()+interval '2 minutes',dotted_v62_token,now());
  IF NOT claimed THEN RAISE EXCEPTION 'FAIL: dotted v62 recovery claim rejected'; END IF;
  IF NOT public.release_telemetry_cache_recovery_write(
    'calc.cache','steam','account.calc.v62','lite',62,dotted_v62_token
  ) THEN RAISE EXCEPTION 'FAIL: dotted v62 recovery release rejected'; END IF;
  BEGIN
    PERFORM public.claim_telemetry_cache_recovery_write(
      'calc.cache','steam','account.calc.v62','lite',62,
      'telemetry-map/v62/steam/calcXcache/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/lite.json',
      now()+interval '2 minutes','00000000-0000-4000-8000-000000000065',now());
    RAISE EXCEPTION 'FAIL: dotted v62 wildcard map key accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  claimed := public.claim_telemetry_cache_recovery_write(
    'calc.cache','steam','account.calc.v61','lite',61,
    'telemetry-map/v61/steam/calc.cache/cccccccccccccccccccccccccccccccc/lite.json',
    now()+interval '2 minutes',dotted_v61_token,now());
  IF NOT claimed THEN RAISE EXCEPTION 'FAIL: dotted v61 recovery claim rejected'; END IF;
  IF NOT public.release_telemetry_cache_recovery_write(
    'calc.cache','steam','account.calc.v61','lite',61,dotted_v61_token
  ) THEN RAISE EXCEPTION 'FAIL: dotted v61 recovery release rejected'; END IF;
  BEGIN
    PERFORM public.claim_telemetry_cache_recovery_write(
      'calc.cache','steam','account.calc.v61','lite',61,
      'telemetry-map/v61/steam/calcXcache/cccccccccccccccccccccccccccccccc/lite.json',
      now()+interval '2 minutes','00000000-0000-4000-8000-000000000066',now());
    RAISE EXCEPTION 'FAIL: dotted v61 wildcard map key accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  RAISE NOTICE 'PASS: v61/v62 recovery identity; mismatched version and dotted map keys rejected';
END $$;

-- A v72 recovery target is legacy arithmetic.  If another writer has already
-- marked its benchmark with the new calculation provenance, the old recovery
-- binary must stop at the benchmark compare-and-swap guard instead of
-- overwriting the marker with a legacy result.
DO $$
DECLARE
  recovery_match constant text := 'calc-marker-recovery';
  recovery_player constant text := 'calc-marker-player';
  recovery_account constant text := 'account.calc.marker';
  recovery_path constant text := 'telemetry-map/v61/steam/calc-marker-recovery/dddddddddddddddddddddddddddddddd/lite.json';
  lease_token constant uuid := '00000000-0000-4000-8000-000000000067';
  processed_data jsonb;
  benchmark_snapshot jsonb;
  rows_payload jsonb;
  result jsonb;
BEGIN
  set local role service_role;
  DELETE FROM public.telemetry_map_cache_entries WHERE match_id = recovery_match;
  DELETE FROM public.processed_match_telemetry WHERE match_id = recovery_match;
  DELETE FROM public.global_benchmarks WHERE match_id = recovery_match;
  DELETE FROM public.match_master_telemetry WHERE match_id = recovery_match;

  processed_data := jsonb_build_object(
    'fullResult', jsonb_build_object(
      'v', 72, 'matchId', recovery_match, 'player_id', recovery_player,
      'platform', 'steam',
      'stats', jsonb_build_object('name', 'CalcMarker', 'playerId', recovery_account)
    )
  );
  INSERT INTO public.processed_match_telemetry(match_id, platform, player_id, data)
  VALUES (recovery_match, 'steam', recovery_player, processed_data);
  INSERT INTO public.global_benchmarks(
    id, match_id, platform, player_id, game_mode, match_type, tier,
    damage, kills, filter_version, population_evidence_version
  ) VALUES (
    9205, recovery_match, 'steam', recovery_player, 'squad-fpp', 'official', 'B',
    123, 1, null, null
  );

  SELECT jsonb_build_object(
    'damage', b.damage,
    'kills', b.kills,
    'win_place', b.win_place,
    'game_mode', b.game_mode,
    'map_name', b.map_name,
    'counter_latency_ms', b.counter_latency_ms,
    'initiative_rate', b.initiative_rate,
    'revive_rate', b.revive_rate,
    'is_crossfire', b.is_crossfire,
    'utility_count', b.utility_count,
    'smoke_count', b.smoke_count,
    'frag_count', b.frag_count,
    'pressure_index', b.pressure_index,
    'enemy_death_distance', b.enemy_death_distance,
    'survival_time', b.survival_time,
    'isolation_index', b.isolation_index,
    'min_dist', b.min_dist,
    'height_diff', b.height_diff,
    'smoke_rate', b.smoke_rate,
    'trade_rate', b.trade_rate,
    'solo_kill_rate', b.solo_kill_rate,
    'reversal_rate', b.reversal_rate,
    'duel_win_rate', b.duel_win_rate,
    'trade_latency_ms', b.trade_latency_ms,
    'lethal_throw_count', b.lethal_throw_count,
    'tier', b.tier,
    'score', b.score,
    'combat_score', b.combat_score,
    'tactical_score', b.tactical_score,
    'survival_score', b.survival_score,
    'supp_count', b.supp_count,
    'team_wipes', b.team_wipes,
    'match_type', b.match_type,
    'death_phase', b.death_phase,
    'filter_version', b.filter_version,
    'population_evidence_version', b.population_evidence_version,
    'source', b.source
  ) INTO benchmark_snapshot
  FROM public.global_benchmarks AS b
  WHERE b.id = 9205;

  IF NOT public.claim_telemetry_cache_recovery_write(
    recovery_match, 'steam', recovery_account, 'lite', 61, recovery_path,
    now() + interval '2 minutes', lease_token, now()
  ) THEN
    RAISE EXCEPTION 'FAIL: calc-marker recovery claim rejected';
  END IF;

  -- Simulate a concurrent v73 canary writing only the new provenance marker.
  UPDATE public.global_benchmarks SET calculation_version = 2 WHERE id = 9205;

  rows_payload := jsonb_build_object(
    'master', jsonb_build_object(
      'match_id', recovery_match, 'map_name', 'Baltic_Main',
      'game_mode', 'squad-fpp', 'telemetry_version', 61,
      'storage_path', recovery_path
    ),
    'processed', jsonb_build_object(
      'match_id', recovery_match, 'platform', 'steam', 'player_id', recovery_player,
      'data', jsonb_build_object(
        'fullResult', jsonb_build_object(
          'v', 73, 'matchId', recovery_match, 'player_id', recovery_player,
          'platform', 'steam', 'populationEvidenceVersion', 1,
          'stats', jsonb_build_object('name', 'CalcMarker', 'playerId', recovery_account)
        )
      ),
      'updated_at', now()
    ),
    'benchmark', jsonb_build_object(
      'match_id', recovery_match, 'platform', 'steam', 'player_id', recovery_player,
      'game_mode', 'squad-fpp', 'map_name', 'Baltic_Main', 'match_type', 'official',
      'tier', 'B', 'damage', 123, 'kills', 1,
      'filter_version', 8, 'population_evidence_version', 1, 'source', 'user',
      'calculation_version', 2
    )
  );

  result := public.finalize_telemetry_cache_recovery(
    recovery_match, 'steam', recovery_account, 'lite', 61, recovery_path, lease_token,
    jsonb_build_object(
      'matchId', recovery_match, 'playerId', recovery_player,
      'platform', 'steam', 'resultVersion', 72, 'accountId', recovery_account
    ),
    jsonb_build_object(
      'id', 9205, 'matchId', recovery_match, 'playerId', recovery_player,
      'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official',
      'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null,
      'snapshot', benchmark_snapshot
    ),
    rows_payload
  );

  IF result->>'code' <> 'benchmark_guard_mismatch'
     OR (SELECT data #>> '{fullResult,v}' FROM public.processed_match_telemetry
         WHERE match_id = recovery_match AND platform = 'steam' AND player_id = recovery_player) <> '72'
     OR (SELECT calculation_version FROM public.global_benchmarks WHERE id = 9205) <> 2
     OR (SELECT status FROM public.telemetry_map_cache_entries
         WHERE match_id = recovery_match AND platform = 'steam' AND player_id = recovery_account) <> 'pending'
     OR EXISTS (SELECT 1 FROM public.match_master_telemetry WHERE match_id = recovery_match) THEN
    RAISE EXCEPTION 'FAIL: pre-marked benchmark was overwritten by legacy recovery (%)', result;
  END IF;
  RAISE NOTICE 'PASS: legacy v72 recovery rejects a pre-marked calculation benchmark';
END $$;
