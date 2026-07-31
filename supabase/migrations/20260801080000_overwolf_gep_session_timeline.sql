-- Overwolf GEP 세션 요약에 사후 리뷰 타임라인과 조회 경로 추가
--
-- 배경: BGMS Companion 이 매치 종료 시 보내는 요약에 death/killer/knockedout/revived/kill
-- 발생 시점(매치 시작 기준 경과 초)을 담는다. 좌표나 데미지는 담지 않는다.
-- 저장된 시점을 근거로 BGMS 웹이 공식 API 텔레메트리에서 해당 구간을 찾아 보여준다.
--
-- 또한 웹에서 세션 요약을 읽는 경로를 추가한다. 기존에는 적재만 하고 읽는 경로가 없었다.
-- 읽기도 service_role 전용 RPC 로만 노출하고 anon/authenticated 권한은 회수한다.

ALTER TABLE public.overwolf_session_events
  ADD COLUMN IF NOT EXISTS event_timeline jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 공식 PUBG API 조회가 가능한 match_id 를 가진 세션만 분석 진입 대상이다.
-- pseudo_match_id 는 Overwolf 생성값이라 공식 API 조회 키로 쓸 수 없다.
CREATE INDEX IF NOT EXISTS overwolf_session_events_official_match_idx
  ON public.overwolf_session_events (player_id, created_at DESC)
  WHERE match_id IS NOT NULL AND player_id IS NOT NULL;

/**
 * 세션 요약을 idempotent 하게 적재합니다. (타임라인 포함 버전)
 * 이미 같은 session_id 가 있으면 false 를 반환하고 아무것도 쓰지 않습니다.
 * 기존 9인자 시그니처는 호출자가 없어지므로 이 버전으로 대체합니다.
 */
CREATE OR REPLACE FUNCTION public.record_overwolf_session_event(
  p_session_id text,
  p_match_id text,
  p_pseudo_match_id text,
  p_player_id text,
  p_platform text,
  p_gep_summary jsonb,
  p_client_environment jsonb,
  p_source_host text,
  p_is_internal boolean,
  p_event_timeline jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inserted_rows integer;
  timeline jsonb;
BEGIN
  IF p_session_id IS NULL OR length(p_session_id) = 0 OR length(p_session_id) > 200 THEN
    RETURN false;
  END IF;

  -- 배열이 아니면 빈 배열로 떨어뜨린다. 서버 라우트가 이미 정규화하지만 DB 에서도 방어한다.
  timeline := CASE
    WHEN p_event_timeline IS NULL THEN '[]'::jsonb
    WHEN jsonb_typeof(p_event_timeline) = 'array' THEN p_event_timeline
    ELSE '[]'::jsonb
  END;

  INSERT INTO public.overwolf_session_events (
    session_id,
    match_id,
    pseudo_match_id,
    player_id,
    platform,
    gep_summary,
    client_environment,
    event_timeline,
    source_host,
    is_internal
  )
  VALUES (
    p_session_id,
    nullif(p_match_id, ''),
    nullif(p_pseudo_match_id, ''),
    nullif(p_player_id, ''),
    nullif(p_platform, ''),
    coalesce(p_gep_summary, '{}'::jsonb),
    coalesce(p_client_environment, '{}'::jsonb),
    timeline,
    nullif(p_source_host, ''),
    coalesce(p_is_internal, false)
  )
  ON CONFLICT (session_id) DO NOTHING;

  GET DIAGNOSTICS inserted_rows = ROW_COUNT;
  RETURN inserted_rows > 0;
END;
$$;

/**
 * 특정 플레이어의 최근 세션 요약을 조회합니다.
 * player_id 는 사용자가 앱에서 직접 입력한 값이며 인증된 identity 가 아닙니다.
 * 따라서 이 함수는 공개 식별자 기준 조회이고, 민감 정보(source_host)는 반환하지 않습니다.
 */
CREATE OR REPLACE FUNCTION public.list_overwolf_sessions(
  p_player_id text,
  p_platform text,
  p_limit integer
)
RETURNS TABLE (
  session_id text,
  match_id text,
  pseudo_match_id text,
  player_id text,
  platform text,
  gep_summary jsonb,
  event_timeline jsonb,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    e.session_id,
    e.match_id,
    e.pseudo_match_id,
    e.player_id,
    e.platform,
    e.gep_summary,
    e.event_timeline,
    e.created_at
  FROM public.overwolf_session_events AS e
  WHERE e.player_id = nullif(lower(p_player_id), '')
    AND (nullif(p_platform, '') IS NULL OR e.platform = p_platform)
    AND e.is_internal = false
  ORDER BY e.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

/** 단일 세션 요약을 조회합니다. 상세 화면에서 사용합니다. */
CREATE OR REPLACE FUNCTION public.get_overwolf_session(p_session_id text)
RETURNS TABLE (
  session_id text,
  match_id text,
  pseudo_match_id text,
  player_id text,
  platform text,
  gep_summary jsonb,
  event_timeline jsonb,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    e.session_id,
    e.match_id,
    e.pseudo_match_id,
    e.player_id,
    e.platform,
    e.gep_summary,
    e.event_timeline,
    e.created_at
  FROM public.overwolf_session_events AS e
  WHERE e.session_id = nullif(p_session_id, '')
  LIMIT 1;
$$;

-- 함수 실행 권한은 service_role 만 갖는다.
-- SECURITY DEFINER 함수는 기본적으로 PUBLIC 에 EXECUTE 가 부여되므로 명시적으로 회수한다.
REVOKE ALL ON FUNCTION public.record_overwolf_session_event(
  text, text, text, text, text, jsonb, jsonb, text, boolean, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_overwolf_session_event(
  text, text, text, text, text, jsonb, jsonb, text, boolean, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.list_overwolf_sessions(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_overwolf_sessions(text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_overwolf_session(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_overwolf_session(text) TO service_role;

-- 타임라인 컬럼 추가 후에도 anon/authenticated 는 테이블에 직접 접근할 수 없어야 한다.
REVOKE ALL ON TABLE public.overwolf_session_events FROM anon, authenticated;
GRANT ALL ON TABLE public.overwolf_session_events TO service_role;

-- 기존 9인자 시그니처를 제거한다. 남겨두면 PostgREST 가 오버로드를 구분하지 못해
-- 같은 함수명 호출이 모호해질 수 있다. 호출자는 서버 라우트 한 곳뿐이며 10인자로 전환했다.
DROP FUNCTION IF EXISTS public.record_overwolf_session_event(
  text, text, text, text, text, jsonb, jsonb, text, boolean
);
