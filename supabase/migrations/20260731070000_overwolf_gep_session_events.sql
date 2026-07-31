-- Overwolf GEP 세션 요약 적재 테이블
--
-- 배경: BGMS Companion(Overwolf 앱)은 매치 종료 시 GEP 기반 세션 요약을 1회 전송한다.
-- 이 데이터는 PUBG 공식 API 기반 사후 분석 데이터를 대체하지 않는 보조 신호이므로
-- processed_match_telemetry, match_stats_raw, global_benchmarks 와 완전히 분리된
-- 신규 테이블에만 적재한다.
--
-- matchEnd 는 사망 시점과 로비 복귀 시점에 각각 발생할 수 있어 같은 세션에서
-- 중복 수신될 수 있다. session_id 를 PK 로 두고 INSERT ... ON CONFLICT DO NOTHING
-- 으로 idempotent 처리한다.
--
-- 클라이언트(Overwolf 앱)는 service role key 를 갖지 않는다.
-- 서버 라우트(app/api/overwolf/session)만 service role 로 이 테이블에 접근한다.

CREATE TABLE IF NOT EXISTS public.overwolf_session_events (
  session_id text PRIMARY KEY,
  match_id text,
  pseudo_match_id text,
  player_id text,
  platform text,
  gep_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_environment jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_host text,
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS overwolf_session_events_created_at_idx
  ON public.overwolf_session_events (created_at DESC);

CREATE INDEX IF NOT EXISTS overwolf_session_events_match_id_idx
  ON public.overwolf_session_events (match_id)
  WHERE match_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS overwolf_session_events_player_idx
  ON public.overwolf_session_events (platform, player_id)
  WHERE player_id IS NOT NULL;

ALTER TABLE public.overwolf_session_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.overwolf_session_events FROM anon, authenticated;
GRANT ALL ON TABLE public.overwolf_session_events TO service_role;

-- 세션 단위 전송 빈도 제한 클레임 테이블.
-- 익명 공개 엔드포인트이므로 세션 키 기준으로 반복 전송을 제한한다.
CREATE TABLE IF NOT EXISTS public.overwolf_session_quota (
  quota_key text PRIMARY KEY,
  event_count integer NOT NULL DEFAULT 0,
  window_started_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.overwolf_session_quota ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.overwolf_session_quota FROM anon, authenticated;
GRANT ALL ON TABLE public.overwolf_session_quota TO service_role;

/**
 * 세션 요약을 idempotent 하게 적재합니다.
 * 이미 같은 session_id 가 있으면 false 를 반환하고 아무것도 쓰지 않습니다.
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
  p_is_internal boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inserted_rows integer;
BEGIN
  IF p_session_id IS NULL OR length(p_session_id) = 0 OR length(p_session_id) > 200 THEN
    RETURN false;
  END IF;

  INSERT INTO public.overwolf_session_events (
    session_id,
    match_id,
    pseudo_match_id,
    player_id,
    platform,
    gep_summary,
    client_environment,
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
    nullif(p_source_host, ''),
    coalesce(p_is_internal, false)
  )
  ON CONFLICT (session_id) DO NOTHING;

  GET DIAGNOSTICS inserted_rows = ROW_COUNT;
  RETURN inserted_rows > 0;
END;
$$;

/**
 * 세션 전송 빈도를 소비합니다. 윈도 안에서 허용량을 넘으면 false 를 반환합니다.
 * 기본값은 10분 윈도에 12회입니다(중복 matchEnd 와 재시도를 감안한 여유값).
 */
CREATE OR REPLACE FUNCTION public.consume_overwolf_session_quota(
  p_quota_key text,
  p_max_events integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  max_events integer;
  window_seconds integer;
  current_count integer;
BEGIN
  IF p_quota_key IS NULL OR length(p_quota_key) = 0 OR length(p_quota_key) > 200 THEN
    RETURN false;
  END IF;

  max_events := least(greatest(coalesce(p_max_events, 12), 1), 200);
  window_seconds := least(greatest(coalesce(p_window_seconds, 600), 10), 86400);

  INSERT INTO public.overwolf_session_quota (quota_key, event_count, window_started_at)
  VALUES (p_quota_key, 1, now())
  ON CONFLICT (quota_key) DO UPDATE
  SET
    event_count = CASE
      WHEN public.overwolf_session_quota.window_started_at < now() - make_interval(secs => window_seconds)
        THEN 1
      ELSE public.overwolf_session_quota.event_count + 1
    END,
    window_started_at = CASE
      WHEN public.overwolf_session_quota.window_started_at < now() - make_interval(secs => window_seconds)
        THEN now()
      ELSE public.overwolf_session_quota.window_started_at
    END
  RETURNING event_count INTO current_count;

  RETURN current_count <= max_events;
END;
$$;

/** 오래된 세션 요약과 만료된 쿼터 레코드를 정리합니다. 일일 유지보수 작업에서 호출합니다. */
CREATE OR REPLACE FUNCTION public.cleanup_overwolf_session_events(p_retention_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  retention_days integer;
  deleted_count integer;
BEGIN
  retention_days := least(greatest(coalesce(p_retention_days, 90), 1), 3650);

  DELETE FROM public.overwolf_session_events
  WHERE created_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  DELETE FROM public.overwolf_session_quota
  WHERE window_started_at < now() - interval '1 day';

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_overwolf_session_event(text, text, text, text, text, jsonb, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_overwolf_session_quota(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_overwolf_session_events(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_overwolf_session_event(text, text, text, text, text, jsonb, jsonb, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_overwolf_session_quota(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_overwolf_session_events(integer) TO service_role;
