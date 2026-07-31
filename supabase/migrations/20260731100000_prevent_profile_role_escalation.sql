-- 일반 사용자의 role 자가 승격 차단
--
-- 배경: profiles 의 "Users can update own profile" 정책이 열을 제한하지 않아
-- 로그인 사용자가 자신의 profiles.role 을 'admin' 으로 변경할 수 있었다.
-- middleware(lib/supabase-middleware.ts)와 requireAdmin(lib/server/adminGuard.ts)이
-- 이 열을 관리자 판정 근거로 사용하므로 관리자 권한 전체가 탈취될 수 있다.
--
-- 대응: 트리거로 role 변경을 차단한다. RLS 정책만으로는 열 단위 제한이 어렵고,
-- 열 GRANT 회수는 service_role 경로까지 함께 영향을 줄 수 있어 트리거를 택했다.
-- service_role 은 트리거를 건너뛰지 않으므로, 관리자 지정은 아래 전용 함수를 사용한다.

/**
 * profiles.role 변경 시도를 차단합니다.
 * 정상적인 프로필 수정(닉네임, 아바타 등)은 그대로 허용됩니다.
 * 세션 변수 app.allow_role_change 가 'on' 인 경우에만 변경을 허용합니다.
 */
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- role 이 바뀌지 않으면 통과한다.
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  -- 관리자 지정 전용 함수가 설정한 세션 플래그가 있을 때만 허용한다.
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

/**
 * 관리자 권한을 부여하거나 회수합니다.
 * service_role 만 실행할 수 있으며, 트리거 차단을 세션 플래그로 우회합니다.
 * 운영에서 관리자를 지정할 때는 이 함수를 사용해야 합니다.
 */
CREATE OR REPLACE FUNCTION public.set_profile_role(
  p_user_id uuid,
  p_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_role NOT IN ('user', 'admin') THEN
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
