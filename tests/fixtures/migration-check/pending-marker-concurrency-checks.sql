DO $$
BEGIN
  IF (SELECT weight FROM public.pending_markers WHERE id='99200000-0000-4000-8000-000000000001') IS DISTINCT FROM 3
     OR (SELECT cardinality(contributor_ids) FROM public.pending_markers WHERE id='99200000-0000-4000-8000-000000000001') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Concurrent votes were lost';
  END IF;
END;
$$;
DROP TRIGGER fixture_pause_pending_vote ON public.pending_markers;
DROP FUNCTION public.fixture_pause_pending_vote();
DELETE FROM public.pending_markers WHERE id='99200000-0000-4000-8000-000000000001';
DELETE FROM public.profiles WHERE id IN ('99200000-0000-4000-8000-000000000001','99200000-0000-4000-8000-000000000002');
SELECT 'Concurrent pending votes both preserved' AS result;
