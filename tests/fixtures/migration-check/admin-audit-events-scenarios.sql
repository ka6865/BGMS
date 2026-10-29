BEGIN;
DO $$
DECLARE v_id uuid;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_audit_events'::regclass) THEN
    RAISE EXCEPTION 'FAIL: admin_audit_events RLS is not enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_audit_events') THEN
    RAISE EXCEPTION 'FAIL: admin_audit_events must not have policies';
  END IF;
  IF has_table_privilege('anon', 'public.admin_audit_events', 'select')
    OR has_table_privilege('authenticated', 'public.admin_audit_events', 'select')
    OR has_table_privilege('anon', 'public.admin_audit_events', 'insert')
    OR has_table_privilege('authenticated', 'public.admin_audit_events', 'insert') THEN
    RAISE EXCEPTION 'FAIL: client roles still have privileges on admin_audit_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.admin_audit_events', 'insert') THEN
    RAISE EXCEPTION 'FAIL: service_role cannot insert admin_audit_events';
  END IF;

  INSERT INTO public.admin_audit_events (action) VALUES ('users.delete') RETURNING id INTO v_id;
  IF (SELECT detail FROM public.admin_audit_events WHERE id = v_id) <> '{}'::jsonb
    OR (SELECT created_at FROM public.admin_audit_events WHERE id = v_id) IS NULL THEN
    RAISE EXCEPTION 'FAIL: admin_audit_events defaults were not applied';
  END IF;

  BEGIN
    INSERT INTO public.admin_audit_events (action) VALUES ('   ');
    RAISE EXCEPTION 'FAIL: blank action was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.admin_audit_events (action, detail) VALUES ('users.delete', '[]'::jsonb);
    RAISE EXCEPTION 'FAIL: non-object detail was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS: admin_audit_events is service-role only with defaults and checks';
END $$;
ROLLBACK;
