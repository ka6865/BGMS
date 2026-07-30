CREATE OR REPLACE FUNCTION public.process_pending_marker_admin_action(
  p_marker_id uuid,
  p_action text
)
RETURNS TABLE (
  id uuid,
  map_name text,
  marker_type text,
  x double precision,
  y double precision,
  contributor_ids uuid[],
  new_marker_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pending_marker public.pending_markers%ROWTYPE;
  marker_id bigint;
BEGIN
  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid admin action';
  END IF;

  SELECT * INTO pending_marker
  FROM public.pending_markers
  WHERE pending_markers.id = p_marker_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_action = 'approve' THEN
    marker_id := public.get_next_marker_id(pending_marker.map_name, pending_marker.marker_type);
    INSERT INTO public.map_markers (id, map_id, name, type, x, y)
    VALUES (marker_id, pending_marker.map_name, pending_marker.marker_type, pending_marker.marker_type, pending_marker.x, pending_marker.y);
  END IF;

  DELETE FROM public.pending_markers WHERE pending_markers.id = p_marker_id;

  RETURN QUERY SELECT pending_marker.id, pending_marker.map_name, pending_marker.marker_type,
    pending_marker.x, pending_marker.y, pending_marker.contributor_ids,
    CASE WHEN p_action = 'approve' THEN marker_id ELSE NULL END;
END;
$$;

REVOKE ALL ON FUNCTION public.process_pending_marker_admin_action(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_pending_marker_admin_action(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.process_pending_marker_admin_action(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_pending_marker_admin_action(uuid, text) TO service_role;
