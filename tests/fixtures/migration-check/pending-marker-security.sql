BEGIN;
INSERT INTO public.profiles(id,nickname,role) VALUES
 ('99100000-0000-4000-8000-000000000001','report author','user'),
 ('99100000-0000-4000-8000-000000000002','report voter','user'),
 ('99100000-0000-4000-8000-000000000003','report downvoter','user'),
 ('99100000-0000-4000-8000-000000000004','report admin','admin');
DO $$
BEGIN
  IF has_table_privilege('authenticated','public.pending_markers','UPDATE')
     OR has_any_column_privilege('authenticated','public.pending_markers','UPDATE')
     OR has_function_privilege('anon','public.vote_pending_marker(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.create_pending_marker(uuid,text,text,double precision,double precision)','EXECUTE') THEN
    RAISE EXCEPTION 'Unsafe report write ACL';
  END IF;
END;
$$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','99100000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
INSERT INTO public.pending_markers(map_name,marker_type,x,y,weight,contributor_ids,is_notified)
VALUES('Erangel','Garage',7900,7900,1,ARRAY['99100000-0000-4000-8000-000000000001']::uuid[],false);
DO $$
BEGIN
  BEGIN
    UPDATE public.pending_markers SET weight=999;
    RAISE EXCEPTION 'Authenticated direct update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.pending_markers(map_name,marker_type,x,y,weight,contributor_ids,is_notified)
    VALUES('Erangel','Garage',7800,7800,999,ARRAY['99100000-0000-4000-8000-000000000001']::uuid[],false);
    RAISE EXCEPTION 'Forged vote weight unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.pending_markers(map_name,marker_type,x,y,weight,contributor_ids,is_notified)
    VALUES('Erangel','Garage',7800,7800,1,ARRAY['99100000-0000-4000-8000-000000000002']::uuid[],false);
    RAISE EXCEPTION 'Forged contributor unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE created jsonb; nearby jsonb; voted jsonb; marker_id uuid;
BEGIN
  created := public.create_pending_marker('99100000-0000-4000-8000-000000000001','Erangel','Garage',7600,7600);
  marker_id := (created->>'id')::uuid;
  nearby := public.create_pending_marker('99100000-0000-4000-8000-000000000002','Erangel','Garage',7610,7600);
  IF created->>'status' IS DISTINCT FROM 'ok' OR nearby->>'status' IS DISTINCT FROM 'nearby' OR nearby->>'id' IS DISTINCT FROM created->>'id' THEN
    RAISE EXCEPTION 'Nearby report detection changed';
  END IF;
  voted := public.vote_pending_marker(marker_id,'99100000-0000-4000-8000-000000000002','up');
  IF voted->>'weight' IS DISTINCT FROM '2' OR voted->>'status' IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'Vote increment failed'; END IF;
  voted := public.vote_pending_marker(marker_id,'99100000-0000-4000-8000-000000000002','down');
  IF voted->>'status' IS DISTINCT FROM 'already_voted' THEN RAISE EXCEPTION 'Cross-direction duplicate vote accepted'; END IF;
  voted := public.vote_pending_marker(marker_id,'99100000-0000-4000-8000-000000000003','down');
  IF voted->>'down_weight' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Downvote increment failed'; END IF;
  PERFORM public.vote_pending_marker(marker_id,'99100000-0000-4000-8000-000000000004','up');
  PERFORM public.vote_pending_marker(marker_id,'99100000-0000-4000-8000-000000000004','up');
  voted := public.vote_pending_marker(marker_id,'99100000-0000-4000-8000-000000000004','up');
  IF voted->>'weight' IS DISTINCT FROM '5' OR voted->>'triggerNotify' IS DISTINCT FROM 'up'
     OR (SELECT is_notified FROM public.pending_markers WHERE id=marker_id) THEN
    RAISE EXCEPTION 'Admin repeat vote or separate notification claim changed';
  END IF;
  BEGIN
    PERFORM public.create_pending_marker('99100000-0000-4000-8000-000000000001','Erangel','Garage','NaN'::float8,0);
    RAISE EXCEPTION 'NaN report accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;
RESET ROLE;
ROLLBACK;
SELECT 'pending marker ACL, legacy insert, duplicate vote and nearby report passed' AS result;
