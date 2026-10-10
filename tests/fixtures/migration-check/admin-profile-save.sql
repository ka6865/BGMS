BEGIN;

INSERT INTO auth.users (id) VALUES
  ('a1000000-0000-4000-8000-000000000001'),
  ('a1000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, nickname, role, pubg_nickname, pubg_platform)
VALUES ('a1000000-0000-4000-8000-000000000001', 'admin-save-existing', 'user', 'KeepMe', 'console')
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.set_profile_role(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_profile_role(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_admin_profile(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.save_admin_profile(uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.set_profile_role(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.save_admin_profile(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'admin profile RPC grants are incorrect';
  END IF;
END;
$$;

GRANT UPDATE (role) ON public.profiles TO service_role;
SET LOCAL ROLE service_role;

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'admin' WHERE id = 'a1000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'direct service role change unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

SELECT public.save_admin_profile(
  'a1000000-0000-4000-8000-000000000001',
  '{"role":"admin","pubg_nickname":"Updated","pubg_platform":"steam"}'::jsonb
);

DO $$
DECLARE
  profile public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO profile FROM public.profiles WHERE id = 'a1000000-0000-4000-8000-000000000001';
  IF profile.role <> 'admin' OR profile.pubg_nickname <> 'Updated' OR profile.pubg_platform <> 'steam' THEN
    RAISE EXCEPTION 'role and selected fields were not saved together';
  END IF;
  IF current_setting('app.allow_role_change', true) <> 'off' THEN
    RAISE EXCEPTION 'role change guard flag was not reset';
  END IF;
END;
$$;

SELECT public.save_admin_profile(
  'a1000000-0000-4000-8000-000000000001',
  '{"role":"user"}'::jsonb
);

DO $$
BEGIN
  IF (SELECT role FROM public.profiles WHERE id = 'a1000000-0000-4000-8000-000000000001') <> 'user'
     OR (SELECT pubg_nickname FROM public.profiles WHERE id = 'a1000000-0000-4000-8000-000000000001') <> 'Updated'
     OR (SELECT pubg_platform FROM public.profiles WHERE id = 'a1000000-0000-4000-8000-000000000001') <> 'steam' THEN
    RAISE EXCEPTION 'omitted profile fields were not preserved';
  END IF;
END;
$$;

SELECT public.save_admin_profile(
  'a1000000-0000-4000-8000-000000000002',
  '{"role":"admin","pubg_nickname":"NewPlayer","pubg_platform":"steam"}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = 'a1000000-0000-4000-8000-000000000002'
      AND nickname = 'User' AND role = 'admin' AND pubg_nickname = 'NewPlayer'
  ) THEN
    RAISE EXCEPTION 'missing profile was not inserted and saved';
  END IF;

  BEGIN
    PERFORM public.save_admin_profile(
      'a1000000-0000-4000-8000-000000000002', '{"role":"owner"}'::jsonb
    );
    RAISE EXCEPTION 'invalid role unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF (SELECT role FROM public.profiles WHERE id = 'a1000000-0000-4000-8000-000000000002') <> 'admin' THEN
    RAISE EXCEPTION 'invalid role changed the existing profile';
  END IF;
END;
$$;

RESET ROLE;
ROLLBACK;
