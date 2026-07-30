CREATE TABLE IF NOT EXISTS public.analytics_event_rate_limits (
  session_id text PRIMARY KEY,
  window_started_at timestamp with time zone NOT NULL DEFAULT now(),
  event_count integer NOT NULL DEFAULT 0
);

ALTER TABLE public.analytics_event_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_analytics_event_quota(
  p_session_id text,
  p_event_count integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_count integer;
BEGIN
  IF length(p_session_id) = 0 OR length(p_session_id) > 100 OR p_event_count < 1 OR p_event_count > 25 THEN
    RETURN false;
  END IF;

  INSERT INTO public.analytics_event_rate_limits (session_id, window_started_at, event_count)
  VALUES (p_session_id, now(), p_event_count)
  ON CONFLICT (session_id) DO UPDATE
  SET window_started_at = CASE
        WHEN public.analytics_event_rate_limits.window_started_at < now() - interval '1 minute' THEN now()
        ELSE public.analytics_event_rate_limits.window_started_at
      END,
      event_count = CASE
        WHEN public.analytics_event_rate_limits.window_started_at < now() - interval '1 minute' THEN EXCLUDED.event_count
        ELSE public.analytics_event_rate_limits.event_count + EXCLUDED.event_count
      END
  RETURNING event_count INTO current_count;

  RETURN current_count <= 60;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analytics_event_quota(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_analytics_event_quota(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.consume_analytics_event_quota(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_analytics_event_quota(text, integer) TO service_role;
