BEGIN;

-- 오래 열린 제보 창의 INSERT는 기본 표 1개와 본인 기여자로만 허용한다.
DROP POLICY IF EXISTS "Allow authenticated update" ON public.pending_markers;
DROP POLICY IF EXISTS "Allow authenticated insert" ON public.pending_markers;
REVOKE UPDATE, INSERT ON public.pending_markers FROM PUBLIC, anon, authenticated;
DO $$
DECLARE column_names text;
BEGIN
  SELECT string_agg(quote_ident(attname), ',') INTO column_names
  FROM pg_attribute WHERE attrelid='public.pending_markers'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE UPDATE (%s), INSERT (%s) ON public.pending_markers FROM PUBLIC, anon, authenticated', column_names, column_names);
END;
$$;
GRANT INSERT(map_name,marker_type,x,y,weight,contributor_ids,is_notified) ON public.pending_markers TO authenticated;
CREATE POLICY "pending_markers_safe_legacy_insert" ON public.pending_markers
FOR INSERT TO authenticated WITH CHECK (
  auth.uid() IS NOT NULL AND contributor_ids = ARRAY[auth.uid()]::uuid[]
  AND weight = 1 AND down_weight = 0
  AND is_notified = false AND is_down_notified = false
  AND downvoter_ids = '{}'::uuid[]
  AND length(map_name) BETWEEN 1 AND 128 AND length(marker_type) BETWEEN 1 AND 128
  AND x BETWEEN 0 AND 8192 AND y BETWEEN 0 AND 8192
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_markers TO service_role;

-- API와 오래 열린 직접 등록 창이 같은 활성 종류 검사를 사용한다.
CREATE OR REPLACE FUNCTION public.pending_marker_category_allowed(p_map_name text,p_marker_type text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT p_map_name IN ('Erangel','Miramar','Taego','Deston','Vikendi','Rondo')
    AND p_marker_type = ANY(coalesce(
      (SELECT categories FROM public.map_settings WHERE map_id=p_map_name),
      CASE p_map_name
        WHEN 'Erangel' THEN ARRAY['Garage','Esports','EsportsBoat','Glider','SecretRoom']
        WHEN 'Miramar' THEN ARRAY['GoldenMirado','EsportsMirado','EsportsPickup','EsportsBoat','Glider','SecretRoom']
        WHEN 'Taego' THEN ARRAY['Garage','Porter','Boat','SecretRoom']
        WHEN 'Deston' THEN ARRAY['Garage','PoliceCar','Boat','Glider']
        WHEN 'Vikendi' THEN ARRAY['Garage','Snowmobile','Esports','Boat','SecretRoom','BearCave']
        WHEN 'Rondo' THEN ARRAY['Garage','Esports','Boat','Glider','SecretRoom','GasPump']
      END))
    AND coalesce((SELECT is_active FROM public.categories WHERE id=p_marker_type),
      p_marker_type IN ('Garage','Esports','Boat','EsportsBoat','Glider','GoldenMirado','EsportsMirado','EsportsPickup','Porter','SecretRoom','PoliceCar','SecurityCard','GasPump','Snowmobile','BearCave'));
$$;
REVOKE ALL ON FUNCTION public.pending_marker_category_allowed(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pending_marker_category_allowed(text,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.validate_legacy_pending_marker_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
  IF NOT coalesce(public.pending_marker_category_allowed(NEW.map_name,NEW.marker_type),false) THEN
    RAISE EXCEPTION 'Inactive report category' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pending-marker:' || NEW.map_name || ':' || NEW.marker_type,0));
  IF EXISTS(SELECT 1 FROM public.pending_markers WHERE map_name=NEW.map_name AND marker_type=NEW.marker_type
    AND (x-NEW.x)^2 + (y-NEW.y)^2 <= (20.0*8192/8000)^2) THEN
    RAISE EXCEPTION 'Nearby report already exists' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_legacy_pending_marker_insert() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS validate_legacy_pending_marker_insert ON public.pending_markers;
CREATE TRIGGER validate_legacy_pending_marker_insert BEFORE INSERT ON public.pending_markers
FOR EACH ROW EXECUTE FUNCTION public.validate_legacy_pending_marker_insert();

CREATE OR REPLACE FUNCTION public.vote_pending_marker(
  p_marker_id uuid, p_actor_user_id uuid, p_direction text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  marker public.pending_markers%ROWTYPE;
  admin_vote boolean;
  notify_direction text := NULL;
BEGIN
  IF p_marker_id IS NULL OR p_actor_user_id IS NULL OR p_direction IS NULL OR p_direction NOT IN ('up','down') THEN
    RAISE EXCEPTION 'Invalid vote' USING ERRCODE='22023';
  END IF;
  SELECT * INTO marker FROM public.pending_markers WHERE id=p_marker_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
  SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor_user_id AND role='admin') INTO admin_vote;
  marker.contributor_ids := coalesce(marker.contributor_ids,'{}'::uuid[]);
  marker.downvoter_ids := coalesce(marker.downvoter_ids,'{}'::uuid[]);
  IF NOT admin_vote AND (p_actor_user_id=ANY(marker.contributor_ids) OR p_actor_user_id=ANY(marker.downvoter_ids)) THEN
    RETURN jsonb_build_object('status','already_voted');
  END IF;
  marker.weight := coalesce(marker.weight,1);
  marker.down_weight := coalesce(marker.down_weight,0);
  IF p_direction='up' THEN
    marker.weight := marker.weight + 1;
    marker.contributor_ids := array_append(marker.contributor_ids,p_actor_user_id);
    IF marker.weight >= 5 AND NOT coalesce(marker.is_notified,false) THEN notify_direction := 'up'; END IF;
  ELSE
    marker.down_weight := marker.down_weight + 1;
    marker.downvoter_ids := array_append(marker.downvoter_ids,p_actor_user_id);
    IF marker.down_weight >= 5 AND NOT coalesce(marker.is_down_notified,false) THEN notify_direction := 'down'; END IF;
  END IF;
  UPDATE public.pending_markers SET weight=marker.weight,down_weight=marker.down_weight,
    contributor_ids=marker.contributor_ids,downvoter_ids=marker.downvoter_ids,updated_at=now()
  WHERE id=p_marker_id;
  RETURN jsonb_build_object('status','ok','weight',marker.weight,'down_weight',marker.down_weight,'triggerNotify',notify_direction);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_pending_marker(
  p_actor_user_id uuid, p_map_name text, p_marker_type text, p_x double precision, p_y double precision
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE marker_id uuid;
BEGIN
  IF p_actor_user_id IS NULL OR p_map_name IS NULL OR p_marker_type IS NULL
     OR length(p_map_name) NOT BETWEEN 1 AND 128 OR length(p_marker_type) NOT BETWEEN 1 AND 128
     OR p_x IS NULL OR p_y IS NULL OR NOT(p_x BETWEEN 0 AND 8192) OR NOT(p_y BETWEEN 0 AND 8192) THEN
    RAISE EXCEPTION 'Invalid report' USING ERRCODE='22023';
  END IF;
  IF NOT coalesce(public.pending_marker_category_allowed(p_map_name,p_marker_type),false) THEN
    RAISE EXCEPTION 'Inactive report category' USING ERRCODE='22023';
  END IF;
  -- 같은 지도/종류의 근접 확인과 등록을 직렬화한다.
  PERFORM pg_advisory_xact_lock(hashtextextended('pending-marker:' || p_map_name || ':' || p_marker_type,0));
  SELECT id INTO marker_id FROM public.pending_markers
  WHERE map_name=p_map_name AND marker_type=p_marker_type
    AND (x-p_x)^2 + (y-p_y)^2 <= (20.0*8192/8000)^2
  ORDER BY (x-p_x)^2 + (y-p_y)^2 LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('status','nearby','id',marker_id); END IF;
  INSERT INTO public.pending_markers(map_name,marker_type,x,y,weight,contributor_ids,is_notified,down_weight,downvoter_ids,is_down_notified)
  VALUES(p_map_name,p_marker_type,p_x,p_y,1,ARRAY[p_actor_user_id],false,0,'{}'::uuid[],false)
  RETURNING id INTO marker_id;
  RETURN jsonb_build_object('status','ok','id',marker_id);
END;
$$;
REVOKE ALL ON FUNCTION public.vote_pending_marker(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_pending_marker(uuid,text,text,double precision,double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_pending_marker(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_pending_marker(uuid,text,text,double precision,double precision) TO service_role;
COMMIT;
