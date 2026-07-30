-- Discord 음성 채널 생성 쿼터
--
-- 배경: /api/discord/room/create 는 인증·레이트리밋이 전혀 없어 누구나 POST 로
-- Discord 길드에 음성 채널을 무제한 생성할 수 있었다. 반복 호출 시 길드가 채널로
-- 도배되고 Discord API rate limit 이 소진된다.
--
-- 사용자당 1시간 3개, 전체 1시간 20개로 제한한다.
-- 구현 방식은 20260730102016_analytics_event_quota.sql 의 consume_analytics_event_quota 와 같다.

CREATE TABLE IF NOT EXISTS public.discord_room_rate_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started_at timestamp with time zone NOT NULL DEFAULT now(),
  room_count integer NOT NULL DEFAULT 0
);

ALTER TABLE public.discord_room_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.discord_room_rate_limits FROM anon, authenticated;
GRANT ALL ON TABLE public.discord_room_rate_limits TO service_role;

CREATE INDEX IF NOT EXISTS discord_room_rate_limits_window_idx
  ON public.discord_room_rate_limits (window_started_at DESC);

/**
 * 사용자 쿼터를 1 소비하고 허용 여부를 반환합니다.
 * 사용자당 시간당 3개, 서비스 전체 시간당 20개를 상한으로 둡니다.
 */
CREATE OR REPLACE FUNCTION public.consume_discord_room_quota(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_count integer;
  global_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- 전체 상한 확인. 현재 윈도우에 남아 있는 카운트만 합산한다.
  SELECT coalesce(sum(room_count), 0) INTO global_count
  FROM public.discord_room_rate_limits
  WHERE window_started_at >= now() - interval '1 hour';

  IF global_count >= 20 THEN
    RETURN false;
  END IF;

  INSERT INTO public.discord_room_rate_limits (user_id, window_started_at, room_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
  SET window_started_at = CASE
        WHEN public.discord_room_rate_limits.window_started_at < now() - interval '1 hour' THEN now()
        ELSE public.discord_room_rate_limits.window_started_at
      END,
      room_count = CASE
        WHEN public.discord_room_rate_limits.window_started_at < now() - interval '1 hour' THEN 1
        ELSE public.discord_room_rate_limits.room_count + 1
      END
  RETURNING room_count INTO current_count;

  RETURN current_count <= 3;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_discord_room_quota(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_discord_room_quota(uuid) TO service_role;

/** 오래된 쿼터 행 정리용. 일일 유지보수 작업에서 호출한다. */
CREATE OR REPLACE FUNCTION public.cleanup_discord_room_rate_limits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.discord_room_rate_limits
  WHERE window_started_at < now() - interval '1 day';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_discord_room_rate_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_discord_room_rate_limits() TO service_role;
