BEGIN;
DROP FUNCTION IF EXISTS public.upsert_hotdrop_counts(json);

CREATE OR REPLACE FUNCTION public.upsert_hotdrop_counts(rows text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  v_rows := rows::jsonb;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'hotdrop rows must be a JSON array';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_rows) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(item.value->'map_name') IS DISTINCT FROM 'string'
      OR length(item.value->>'map_name') NOT BETWEEN 1 AND 50
      OR coalesce(item.value->>'map_name', '') !~ '^[a-z0-9_]+$'
      OR jsonb_typeof(item.value->'season') IS DISTINCT FROM 'string'
      OR length(item.value->>'season') NOT BETWEEN 1 AND 100
      OR coalesce(item.value->>'grid_x', '') !~ '^(0|[1-9][0-9]*)$'
      OR coalesce(item.value->>'grid_y', '') !~ '^(0|[1-9][0-9]*)$'
      OR coalesce(item.value->>'count', '') !~ '^[1-9][0-9]*$'
      OR coalesce(item.value->>'px', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
      OR coalesce(item.value->>'py', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
  ) THEN
    RAISE EXCEPTION 'invalid hotdrop row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_rows) AS item(value)
    WHERE (item.value->>'grid_x')::numeric > 255
      OR (item.value->>'grid_y')::numeric > 255
      OR (item.value->>'count')::numeric > 2147483647
      OR (item.value->>'px')::numeric > 8192
      OR (item.value->>'py')::numeric > 8192
  ) THEN
    RAISE EXCEPTION 'hotdrop row out of range';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_rows) AS item(value)
    GROUP BY item.value->>'map_name', item.value->>'season',
      item.value->>'grid_x', item.value->>'grid_y'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate hotdrop cell';
  END IF;

  INSERT INTO public.hotdrop_heatmap
    (map_name, season, grid_x, grid_y, px, py, count, updated_at)
  SELECT item.value->>'map_name', item.value->>'season',
    (item.value->>'grid_x')::smallint, (item.value->>'grid_y')::smallint,
    (item.value->>'px')::double precision, (item.value->>'py')::double precision,
    (item.value->>'count')::integer, now()
  FROM jsonb_array_elements(v_rows) AS item(value)
  ON CONFLICT (map_name, season, grid_x, grid_y)
  DO UPDATE SET
    count = public.hotdrop_heatmap.count + EXCLUDED.count,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_hotdrop_counts(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_hotdrop_counts(text) TO service_role;

COMMIT;
