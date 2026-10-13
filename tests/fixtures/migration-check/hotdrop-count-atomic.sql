BEGIN;

DO $$
DECLARE
  v_count integer;
  v_case text;
BEGIN
  IF to_regprocedure('public.upsert_hotdrop_counts(json)') IS NOT NULL
    OR to_regprocedure('public.upsert_hotdrop_counts(text)') IS NULL THEN
    RAISE EXCEPTION 'hotdrop RPC overload contract failed';
  END IF;
  IF has_function_privilege('anon', 'public.upsert_hotdrop_counts(text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.upsert_hotdrop_counts(text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.upsert_hotdrop_counts(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'hotdrop RPC ACL failed';
  END IF;

  PERFORM public.upsert_hotdrop_counts('[{"map_name":"erangel","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":48,"py":80,"count":100}]');
  PERFORM public.upsert_hotdrop_counts('[{"map_name":"erangel","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":48,"py":80,"count":2}]');
  SELECT count INTO v_count FROM public.hotdrop_heatmap
    WHERE map_name = 'erangel' AND season = 'hotdrop-atomic-fixture'
      AND grid_x = 1 AND grid_y = 2;
  IF v_count IS DISTINCT FROM 102 THEN
    RAISE EXCEPTION 'hotdrop count expected 102, got %', v_count;
  END IF;

  FOREACH v_case IN ARRAY ARRAY['duplicate', 'negative', 'nan', 'sql-injection'] LOOP
    BEGIN
      IF v_case = 'duplicate' THEN
        PERFORM public.upsert_hotdrop_counts('[{"map_name":"erangel","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":48,"py":80,"count":1},{"map_name":"erangel","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":48,"py":80,"count":1}]');
      ELSIF v_case = 'negative' THEN
        PERFORM public.upsert_hotdrop_counts('[{"map_name":"erangel","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":48,"py":80,"count":-1}]');
      ELSIF v_case = 'sql-injection' THEN
        PERFORM public.upsert_hotdrop_counts('[{"map_name":"x''); DROP TABLE hotdrop_heatmap; --","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":48,"py":80,"count":1}]');
      ELSE
        PERFORM public.upsert_hotdrop_counts('[{"map_name":"erangel","season":"hotdrop-atomic-fixture","grid_x":1,"grid_y":2,"px":"NaN","py":80,"count":1}]');
      END IF;
      RAISE EXCEPTION 'invalid hotdrop payload was accepted: %', v_case;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'invalid hotdrop payload was accepted:%' THEN RAISE; END IF;
    END;
    SELECT count INTO v_count FROM public.hotdrop_heatmap
      WHERE map_name = 'erangel' AND season = 'hotdrop-atomic-fixture'
        AND grid_x = 1 AND grid_y = 2;
    IF v_count IS DISTINCT FROM 102 THEN
      RAISE EXCEPTION 'invalid % payload changed existing count to %', v_case, v_count;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;

SELECT 'hotdrop atomic count scenarios passed' AS result;
