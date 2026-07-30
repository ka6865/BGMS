-- 제보 알림은 외부 Discord 호출 전에 DB에서 한 번만 claim한다.
-- 이 함수는 service_role API 경로에서만 실행된다.
CREATE OR REPLACE FUNCTION public.claim_pending_marker_notification(
  p_marker_id uuid,
  p_direction text
)
RETURNS TABLE (
  id uuid,
  map_name text,
  marker_type text,
  x double precision,
  y double precision,
  weight integer,
  down_weight integer,
  contributor_ids uuid[],
  downvoter_ids uuid[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed_marker public.pending_markers%ROWTYPE;
BEGIN
  IF p_direction NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'invalid notification direction';
  END IF;

  SELECT *
  INTO claimed_marker
  FROM public.pending_markers
  WHERE pending_markers.id = p_marker_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_direction = 'up' THEN
    IF claimed_marker.weight < 5 OR COALESCE(claimed_marker.is_notified, false) THEN
      RETURN;
    END IF;

    UPDATE public.pending_markers
    SET is_notified = true,
        updated_at = timezone('utc'::text, now())
    WHERE pending_markers.id = p_marker_id
      AND pending_markers.weight >= 5
      AND pending_markers.is_notified = false
    RETURNING * INTO claimed_marker;
  ELSE
    IF claimed_marker.down_weight < 5 OR COALESCE(claimed_marker.is_down_notified, false) THEN
      RETURN;
    END IF;

    UPDATE public.pending_markers
    SET is_down_notified = true,
        updated_at = timezone('utc'::text, now())
    WHERE pending_markers.id = p_marker_id
      AND pending_markers.down_weight >= 5
      AND pending_markers.is_down_notified = false
    RETURNING * INTO claimed_marker;
  END IF;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    claimed_marker.id,
    claimed_marker.map_name,
    claimed_marker.marker_type,
    claimed_marker.x,
    claimed_marker.y,
    claimed_marker.weight,
    claimed_marker.down_weight,
    claimed_marker.contributor_ids,
    claimed_marker.downvoter_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_marker_notification(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pending_marker_notification(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pending_marker_notification(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_marker_notification(uuid, text) TO service_role;
