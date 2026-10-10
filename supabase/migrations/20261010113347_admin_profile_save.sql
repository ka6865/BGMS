-- Service role도 profiles.role을 직접 바꿀 수 없으며, 아래 저장 RPC가
-- set_profile_role을 통해 권한 검증과 프로필 필드 갱신을 한 트랜잭션으로 처리한다.
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('app.allow_role_change', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'profiles.role 은 직접 변경할 수 없습니다.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS prevent_profile_role_escalation ON public.profiles;
CREATE TRIGGER prevent_profile_role_escalation
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_profile_role_escalation();

CREATE OR REPLACE FUNCTION public.set_profile_role(p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'role 은 user 또는 admin 만 허용됩니다.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.allow_role_change', 'on', true);
  UPDATE public.profiles
  SET role = p_role,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_user_id;
  PERFORM set_config('app.allow_role_change', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_profile_role_escalation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_profile_role(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_profile_role(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.save_admin_profile(p_user_id uuid, p_profile jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL OR jsonb_typeof(p_profile) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION '유저 ID와 프로필 객체가 필요합니다.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_profile ? 'role' AND (p_profile->>'role') NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'role 은 user 또는 admin 만 허용됩니다.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.profiles (id, nickname, role)
  VALUES (p_user_id, 'User', 'user')
  ON CONFLICT (id) DO NOTHING;

  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '프로필 저장 대상을 찾을 수 없습니다.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF p_profile ? 'role' THEN
    PERFORM public.set_profile_role(p_user_id, p_profile->>'role');
  END IF;

  UPDATE public.profiles
  SET pubg_nickname = CASE WHEN p_profile ? 'pubg_nickname' THEN p_profile->>'pubg_nickname' ELSE pubg_nickname END,
      pubg_platform = CASE WHEN p_profile ? 'pubg_platform' THEN p_profile->>'pubg_platform' ELSE pubg_platform END,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_admin_profile(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_admin_profile(uuid, jsonb) TO service_role;
