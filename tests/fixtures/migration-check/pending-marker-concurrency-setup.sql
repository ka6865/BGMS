INSERT INTO public.profiles(id,nickname,role) VALUES
 ('99200000-0000-4000-8000-000000000001','concurrent voter A','user'),
 ('99200000-0000-4000-8000-000000000002','concurrent voter B','user');
INSERT INTO public.pending_markers(id,map_name,marker_type,x,y,weight,contributor_ids)
VALUES('99200000-0000-4000-8000-000000000001','Erangel','Garage',7000,7000,1,'{}'::uuid[]);
CREATE FUNCTION public.fixture_pause_pending_vote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20261010112343);
  PERFORM pg_sleep(0.5);
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixture_pause_pending_vote AFTER UPDATE ON public.pending_markers
FOR EACH ROW WHEN (NEW.id='99200000-0000-4000-8000-000000000001'::uuid)
EXECUTE FUNCTION public.fixture_pause_pending_vote();
