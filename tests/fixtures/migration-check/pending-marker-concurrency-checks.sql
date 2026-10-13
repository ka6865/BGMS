DO $$
BEGIN
  IF (SELECT weight FROM public.pending_markers WHERE id='99200000-0000-4000-8000-000000000001') IS DISTINCT FROM 3
     OR (SELECT cardinality(contributor_ids) FROM public.pending_markers WHERE id='99200000-0000-4000-8000-000000000001') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Concurrent votes were lost';
  END IF;
  IF (SELECT count(*) FROM public.pending_markers WHERE map_name='Erangel' AND marker_type='Garage'
       AND x BETWEEN 6490 AND 6510 AND y BETWEEN 6490 AND 6510) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'Legacy and server registration created duplicate nearby reports';
  END IF;
END;
$$;
DROP TRIGGER fixture_pause_pending_vote ON public.pending_markers;
DROP FUNCTION public.fixture_pause_pending_vote();
DROP TRIGGER fixture_pause_pending_registration ON public.pending_markers;
DROP FUNCTION public.fixture_pause_pending_registration();
DELETE FROM public.pending_markers WHERE map_name='Erangel' AND marker_type='Garage' AND x=6500 AND y=6500;
DELETE FROM public.pending_markers WHERE id='99200000-0000-4000-8000-000000000001';
DELETE FROM public.profiles WHERE id IN ('99200000-0000-4000-8000-000000000001','99200000-0000-4000-8000-000000000002');
SELECT 'Concurrent votes preserved and legacy/server nearby registration serialized' AS result;
