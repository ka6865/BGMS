-- 운영 스키마 baseline. `supabase db dump --linked` 결과를 검증용으로 조정한 사본입니다.
--
-- 이 파일은 scripts/refresh_baseline_schema.ts 가 생성합니다. 직접 편집하지 마세요.
--
-- 배경: 저장소의 migration 만으로는 빈 DB 를 재현할 수 없습니다. 2026-08-01 실측에서
-- 58개 중 26개가 실패하고 테이블이 32개만 생겼습니다(운영은 60개). posts, comments,
-- profiles, map_markers, pubg_player_cache 등 핵심 테이블이 Supabase 콘솔에서 직접
-- 생성되어 CREATE TABLE 이력이 없기 때문입니다.
--
-- 따라서 재해 복구 경로는 migration 재생이 아니라 이 baseline 입니다.
--
-- 원본 대비 조정한 것:
--   - extensions / vault 스키마를 먼저 생성 (덤프가 이 경로를 참조)
--   - supabase_vault 확장 제거 (플랫폼 전용)
--   - supabase_realtime publication 관련 구문 제거 (플랫폼이 관리)
--
-- 갱신 방법:
--   supabase db dump --linked -f tmp/prod_schema.sql
--   npm run db:baseline:refresh
--   npm run verify:baseline
--
-- 주의: 스키마 전용입니다. 데이터 백업은 scripts/backup_core_tables.ts 가 담당합니다.

-- Supabase 가 확장을 두는 스키마.
CREATE SCHEMA IF NOT EXISTS "extensions";
CREATE SCHEMA IF NOT EXISTS "vault";




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";












CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."post_status" AS ENUM (
    'draft',
    'published',
    'hidden'
);


ALTER TYPE "public"."post_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_weapon_patch_proposal"("p_proposal_id" "uuid", "p_actor" "uuid") RETURNS TABLE("change_id" "uuid", "target_table" "text", "target_id" "text", "column_name" "text", "result" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_proposal public.weapon_patch_proposals%rowtype;
  v_change public.weapon_patch_proposal_changes%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_column_type text;
  v_previous_patch_version text;
  v_applied integer := 0;
  v_skipped integer := 0;
begin
  select * into v_proposal
  from public.weapon_patch_proposals
  where weapon_patch_proposals.id = p_proposal_id
  for update;

  if not found then
    raise exception 'weapon patch proposal not found: %', p_proposal_id;
  end if;

  if v_proposal.status not in ('pending', 'partially_applied') then
    raise exception 'weapon patch proposal is not applicable (status=%)', v_proposal.status;
  end if;

  for v_change in
    select *
    from public.weapon_patch_proposal_changes c
    where c.proposal_id = p_proposal_id
      and c.decision = 'accepted'
      and c.validation_state = 'ok'
    order by c.target_table, c.target_id, c.column_name
  loop
    -- 수치 변경만 컬럼 화이트리스트를 확인한다.
    -- 삭제는 특정 컬럼 편집이 아니라 removed_at 기록이므로 별도 경로로 처리한다.
    if v_change.operation = 'update' and not exists (
      select 1 from public.weapon_patch_editable_columns() w
      where w.target_table = v_change.target_table
        and w.column_name = v_change.column_name
    ) then
      raise exception 'column not editable: %.%', v_change.target_table, v_change.column_name;
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', v_change.target_table)
      into v_before
      using v_change.target_id;

    if v_before is null then
      update public.weapon_patch_proposal_changes
        set validation_state = 'invalid',
            validation_reason = '적용 시점에 대상 행이 존재하지 않음'
        where weapon_patch_proposal_changes.id = v_change.id;
      v_skipped := v_skipped + 1;
      return query select v_change.id, v_change.target_table, v_change.target_id,
        v_change.column_name, 'skipped_missing'::text;
      continue;
    end if;

    -- 제안 생성 이후 값이 바뀐 경우 적용하지 않는다.
    -- 삭제 제안도 removed_at 현재값을 같은 방식으로 대조한다.
    if coalesce(v_before -> v_change.column_name, 'null'::jsonb)
       <> coalesce(v_change.old_value, 'null'::jsonb) then
      update public.weapon_patch_proposal_changes
        set validation_state = 'stale',
            validation_reason = case
              when v_change.operation = 'remove'
                then '적용 시점에 이미 삭제 상태가 변경됨'
              else '적용 시점 현재값이 제안 시점 값과 다름'
            end,
            decision = 'pending'
        where weapon_patch_proposal_changes.id = v_change.id;
      v_skipped := v_skipped + 1;
      return query select v_change.id, v_change.target_table, v_change.target_id,
        v_change.column_name, 'skipped_stale'::text;
      continue;
    end if;

    v_previous_patch_version := v_before ->> 'patch_version';

    if v_change.operation = 'remove' then
      -- 소프트 삭제. 행은 남기고 삭제 시각과 삭제 패치 버전만 기록한다.
      execute format(
        'update public.%I set removed_at = timezone(''utc'', now()), removed_patch_version = $1 where id = $2',
        v_change.target_table
      ) using v_proposal.patch_label, v_change.target_id;
    else
      select a.atttypid::regtype::text into v_column_type
      from pg_catalog.pg_attribute a
      where a.attrelid = format('public.%I', v_change.target_table)::regclass
        and a.attname = v_change.column_name
        and a.attnum > 0
        and not a.attisdropped;

      if v_column_type is null then
        raise exception 'column not found: %.%', v_change.target_table, v_change.column_name;
      end if;

      execute format(
        'update public.%I set %I = ($1::text)::%s where id = $2',
        v_change.target_table, v_change.column_name, v_column_type
      ) using (v_change.new_value #>> '{}'), v_change.target_id;
    end if;

    -- 어느 패치에서 바뀌었는지 기록한다. patch_label 이 없으면 건드리지 않는다.
    if v_proposal.patch_label is not null then
      execute format(
        'update public.%I set patch_version = $1, patch_applied_at = timezone(''utc'', now()) where id = $2',
        v_change.target_table
      ) using v_proposal.patch_label, v_change.target_id;
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_change.target_table)
      into v_after
      using v_change.target_id;

    insert into public.weapon_patch_apply_log (
      proposal_id, change_id, target_table, target_id, column_name,
      before_row, after_row, applied_by, patch_version, previous_patch_version
    ) values (
      p_proposal_id, v_change.id, v_change.target_table, v_change.target_id, v_change.column_name,
      v_before, v_after, p_actor, v_proposal.patch_label, v_previous_patch_version
    );

    v_applied := v_applied + 1;
    return query select v_change.id, v_change.target_table, v_change.target_id,
      v_change.column_name, 'applied'::text;
  end loop;

  update public.weapon_patch_proposals
    set status = case
          when v_applied = 0 then 'pending'
          when v_skipped > 0 then 'partially_applied'
          when exists (
            select 1 from public.weapon_patch_proposal_changes c
            where c.proposal_id = p_proposal_id and c.decision = 'pending'
          ) then 'partially_applied'
          else 'applied'
        end,
        reviewed_at = timezone('utc', now()),
        reviewed_by = p_actor
    where weapon_patch_proposals.id = p_proposal_id;
end;
$_$;


ALTER FUNCTION "public"."apply_weapon_patch_proposal"("p_proposal_id" "uuid", "p_actor" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_role_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF OLD.role != 'admin' THEN
    NEW.role = OLD.role;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_role_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_board_image_deletions"("p_limit" integer, "p_now" timestamp with time zone, "p_lease_seconds" integer) RETURNS TABLE("image_id" "uuid", "bucket_id" "text", "storage_key" "text", "lease_token" "uuid")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_lease_seconds <> 300 THEN
    RAISE EXCEPTION 'invalid_board_image_deletion_claim';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(42117, 1);
  RETURN QUERY
  WITH candidates AS (
    SELECT object_row.id
    FROM public.board_image_objects AS object_row
    WHERE ((object_row.status = 'delete_pending' AND object_row.delete_after <= p_now)
      OR (object_row.status = 'deleting' AND object_row.delete_lease_until <= p_now)
      OR (object_row.status IN ('pending', 'ready') AND object_row.expires_at <= p_now))
      AND NOT EXISTS (
        SELECT 1 FROM public.board_post_image_refs AS ref_row
        WHERE ref_row.image_id = object_row.id
      )
    ORDER BY object_row.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(p_limit, 20)
  ), claimed AS (
    UPDATE public.board_image_objects AS object_row
    SET status = 'deleting', delete_lease_token = gen_random_uuid(),
        delete_lease_until = p_now + interval '5 minutes', delete_attempts = object_row.delete_attempts + 1,
        updated_at = p_now
    FROM candidates AS candidate_row
    WHERE object_row.id = candidate_row.id
      AND NOT EXISTS (
        SELECT 1 FROM public.board_post_image_refs AS ref_row
        WHERE ref_row.image_id = object_row.id
      )
    RETURNING object_row.id, object_row.bucket_id, object_row.storage_key, object_row.delete_lease_token
  ) SELECT claimed.id, claimed.bucket_id, claimed.storage_key, claimed.delete_lease_token FROM claimed;
END;
$$;


ALTER FUNCTION "public"."claim_board_image_deletions"("p_limit" integer, "p_now" timestamp with time zone, "p_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_board_image_deletions_for_owner"("p_owner_user_id" "uuid", "p_image_ids" "uuid"[], "p_now" timestamp with time zone, "p_lease_seconds" integer) RETURNS TABLE("image_id" "uuid", "bucket_id" "text", "storage_key" "text", "lease_token" "uuid")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF p_owner_user_id IS NULL OR p_image_ids IS NULL OR p_now IS NULL
    OR cardinality(p_image_ids) < 1 OR cardinality(p_image_ids) > 20
    OR array_position(p_image_ids, NULL) IS NOT NULL
    OR p_lease_seconds IS NULL OR p_lease_seconds <> 300 THEN
    RAISE EXCEPTION 'invalid_owner_board_image_deletion_claim';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(42117, 1);

  RETURN QUERY
  WITH requested_ids AS (
    SELECT DISTINCT requested_item.requested_id
    FROM unnest(p_image_ids) AS requested_item(requested_id)
  ), candidates AS (
    SELECT object_row.id
    FROM public.board_image_objects AS object_row
    JOIN requested_ids AS requested_row ON requested_row.requested_id = object_row.id
    WHERE object_row.owner_user_id = p_owner_user_id
      AND (object_row.status IN ('pending', 'ready', 'delete_pending')
        OR (object_row.status = 'deleting' AND object_row.delete_lease_until <= p_now))
      AND NOT EXISTS (
        SELECT 1 FROM public.board_post_image_refs AS ref_row
        WHERE ref_row.image_id = object_row.id
      )
    ORDER BY object_row.id
    FOR UPDATE SKIP LOCKED
    LIMIT 20
  ), claimed AS (
    UPDATE public.board_image_objects AS object_row
    SET status = 'deleting', delete_lease_token = gen_random_uuid(),
        delete_lease_until = p_now + interval '5 minutes',
        delete_attempts = object_row.delete_attempts + 1, updated_at = p_now
    FROM candidates AS candidate_row
    WHERE object_row.id = candidate_row.id
      AND object_row.owner_user_id = p_owner_user_id
      AND (object_row.status IN ('pending', 'ready', 'delete_pending')
        OR (object_row.status = 'deleting' AND object_row.delete_lease_until <= p_now))
      AND NOT EXISTS (
        SELECT 1 FROM public.board_post_image_refs AS ref_row
        WHERE ref_row.image_id = object_row.id
      )
    RETURNING object_row.id, object_row.bucket_id, object_row.storage_key, object_row.delete_lease_token
  )
  SELECT claimed.id, claimed.bucket_id, claimed.storage_key, claimed.delete_lease_token
  FROM claimed;
END;
$$;


ALTER FUNCTION "public"."claim_board_image_deletions_for_owner"("p_owner_user_id" "uuid", "p_image_ids" "uuid"[], "p_now" timestamp with time zone, "p_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_pending_marker_notification"("p_marker_id" "uuid", "p_direction" "text") RETURNS TABLE("id" "uuid", "map_name" "text", "marker_type" "text", "x" double precision, "y" double precision, "weight" integer, "down_weight" integer, "contributor_ids" "uuid"[], "downvoter_ids" "uuid"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE claimed_marker public.pending_markers%ROWTYPE;
BEGIN
  IF p_direction NOT IN ('up', 'down') THEN RAISE EXCEPTION 'invalid notification direction'; END IF;
  SELECT * INTO claimed_marker FROM public.pending_markers WHERE pending_markers.id = p_marker_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_direction = 'up' THEN
    IF claimed_marker.weight < 5 OR COALESCE(claimed_marker.is_notified, false) THEN RETURN; END IF;
    UPDATE public.pending_markers SET is_notified = true, updated_at = timezone('utc'::text, now())
    WHERE pending_markers.id = p_marker_id AND pending_markers.weight >= 5 AND pending_markers.is_notified = false RETURNING * INTO claimed_marker;
  ELSE
    IF claimed_marker.down_weight < 5 OR COALESCE(claimed_marker.is_down_notified, false) THEN RETURN; END IF;
    UPDATE public.pending_markers SET is_down_notified = true, updated_at = timezone('utc'::text, now())
    WHERE pending_markers.id = p_marker_id AND pending_markers.down_weight >= 5 AND pending_markers.is_down_notified = false RETURNING * INTO claimed_marker;
  END IF;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT claimed_marker.id, claimed_marker.map_name, claimed_marker.marker_type, claimed_marker.x, claimed_marker.y, claimed_marker.weight, claimed_marker.down_weight, claimed_marker.contributor_ids, claimed_marker.downvoter_ids;
END;
$$;


ALTER FUNCTION "public"."claim_pending_marker_notification"("p_marker_id" "uuid", "p_direction" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_pubg_force_refresh"("p_lock_key" "text", "p_cooldown_seconds" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  cooldown integer;
  updated_rows integer;
BEGIN
  IF p_lock_key IS NULL OR length(p_lock_key) = 0 OR length(p_lock_key) > 300 THEN
    RETURN false;
  END IF;

  cooldown := least(greatest(coalesce(p_cooldown_seconds, 60), 1), 3600);

  INSERT INTO public.pubg_refresh_locks (lock_key, claimed_at)
  VALUES (p_lock_key, now())
  ON CONFLICT (lock_key) DO UPDATE
  SET claimed_at = now()
  WHERE public.pubg_refresh_locks.claimed_at < now() - make_interval(secs => cooldown);

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RETURN updated_rows > 0;
END;
$$;


ALTER FUNCTION "public"."claim_pubg_force_refresh"("p_lock_key" "text", "p_cooldown_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_storage_path" "text", "p_lease_expires_at" timestamp with time zone, "p_lease_token" "uuid", "p_updated_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  claimed boolean;
begin
  if p_match_id is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_mode not in ('lite', 'full')
    or p_telemetry_version is null
    or p_storage_path is null
    or p_lease_expires_at is null
    or p_lease_token is null
    or p_updated_at is null
  then
    raise exception 'telemetry-claim-invalid-input' using errcode = '22023';
  end if;

  insert into public.telemetry_map_cache_entries as cache (
    match_id,
    platform,
    player_id,
    mode,
    telemetry_version,
    storage_path,
    status,
    lease_expires_at,
    lease_token,
    updated_at
  ) values (
    p_match_id,
    p_platform,
    p_player_id,
    p_mode,
    p_telemetry_version,
    p_storage_path,
    'pending',
    p_lease_expires_at,
    p_lease_token,
    p_updated_at
  )
  on conflict (match_id, platform, player_id, mode, telemetry_version) do update set
    storage_path = excluded.storage_path,
    status = 'pending',
    lease_expires_at = excluded.lease_expires_at,
    lease_token = excluded.lease_token,
    updated_at = excluded.updated_at
  where cache.status = 'ready'
    or (
      cache.status = 'pending'
      and (cache.lease_expires_at is null or cache.lease_expires_at <= now())
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;


ALTER FUNCTION "public"."claim_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_storage_path" "text", "p_lease_expires_at" timestamp with time zone, "p_lease_token" "uuid", "p_updated_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_analytics_event_rate_limits"("p_retention_days" integer DEFAULT 7) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  retention_days integer;
  deleted_count integer;
BEGIN
  retention_days := least(greatest(coalesce(p_retention_days, 7), 1), 90);

  DELETE FROM public.analytics_event_rate_limits
  WHERE window_started_at < now() - make_interval(days => retention_days);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_analytics_event_rate_limits"("p_retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_analytics_events"("p_retention_days" integer DEFAULT 30, "p_batch_limit" integer DEFAULT 5000) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  retention_days integer;
  batch_limit integer;
  deleted_count integer;
BEGIN
  -- 실수로 0 이나 음수가 전달되어 전체 데이터가 삭제되는 것을 막는다.
  retention_days := least(greatest(coalesce(p_retention_days, 30), 7), 365);
  batch_limit := least(greatest(coalesce(p_batch_limit, 5000), 100), 50000);

  WITH target AS (
    SELECT id
    FROM public.analytics_events
    WHERE created_at < now() - make_interval(days => retention_days)
    ORDER BY created_at
    LIMIT batch_limit
  )
  DELETE FROM public.analytics_events
  WHERE id IN (SELECT id FROM target);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_analytics_events"("p_retention_days" integer, "p_batch_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_board_write_rate_limits"("p_cutoff" timestamp with time zone, "p_max_rows" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  v_deleted_rows integer;
BEGIN
  IF p_cutoff IS NULL
     OR p_max_rows IS NULL
     OR p_max_rows NOT BETWEEN 1 AND 5000
     OR p_cutoff > statement_timestamp() - interval '1 hour' THEN
    RETURN 0;
  END IF;

  WITH expired AS MATERIALIZED (
    SELECT scope, actor_hash
    FROM public.board_write_rate_limits
    WHERE window_started_at < p_cutoff
    ORDER BY window_started_at, scope, actor_hash
    LIMIT p_max_rows
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.board_write_rate_limits AS target
  USING expired
  WHERE target.scope = expired.scope
    AND target.actor_hash = expired.actor_hash
    AND target.window_started_at < p_cutoff;

  GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
  RETURN v_deleted_rows;
END;
$$;


ALTER FUNCTION "public"."cleanup_board_write_rate_limits"("p_cutoff" timestamp with time zone, "p_max_rows" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_discord_room_rate_limits"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."cleanup_discord_room_rate_limits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_expired_telemetry_matches"("p_match_ids" "text"[], "p_cutoff" timestamp with time zone, "p_target_version" numeric, "p_now" timestamp with time zone) RETURNS TABLE("match_id" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  requested_match_ids text[];
  advisory_locked_match_ids text[] := array[]::text[];
  locked_cache_ids bigint[];
  locked_master_match_ids text[];
  eligible_match_ids text[];
  candidate_match_id text;
begin
  if p_match_ids is null
    or p_cutoff is null
    or p_target_version is null
    or p_now is null
    or cardinality(p_match_ids) > 50
  then
    raise exception 'telemetry-cleanup-invalid-rpc-input' using errcode = '22023';
  end if;

  select coalesce(
    array_agg(distinct input.match_id order by input.match_id),
    array[]::text[]
  )
  into requested_match_ids
  from unnest(p_match_ids) as input(match_id)
  where input.match_id is not null;

  foreach candidate_match_id in array requested_match_ids
  loop
    if pg_try_advisory_xact_lock(
      hashtextextended(candidate_match_id, 1952805741)
    ) then
      advisory_locked_match_ids := array_append(
        advisory_locked_match_ids,
        candidate_match_id
      );
    end if;
  end loop;

  if cardinality(advisory_locked_match_ids) = 0 then
    return;
  end if;

  with requested as (
    select input.match_id
    from unnest(advisory_locked_match_ids) as input(match_id)
    order by input.match_id
  ), locked_cache as (
    select cache.id, cache.match_id
    from public.telemetry_map_cache_entries as cache
    join requested on requested.match_id = cache.match_id
    order by cache.match_id, cache.id
    for update of cache skip locked
  )
  select coalesce(
    array_agg(locked_cache.id order by locked_cache.match_id, locked_cache.id),
    array[]::bigint[]
  )
  into locked_cache_ids
  from locked_cache;

  select coalesce(
    array_agg(candidate.match_id order by candidate.match_id),
    array[]::text[]
  )
  into eligible_match_ids
  from (
    select input.match_id
    from unnest(advisory_locked_match_ids) as input(match_id)
  ) as candidate
  where not exists (
    select 1
    from public.telemetry_map_cache_entries as cache
    where cache.match_id = candidate.match_id
      and not (cache.id = any(locked_cache_ids))
  );

  if cardinality(eligible_match_ids) = 0 then
    return;
  end if;

  with requested as (
    select input.match_id
    from unnest(eligible_match_ids) as input(match_id)
    order by input.match_id
  ), locked_master as (
    select master.match_id
    from public.match_master_telemetry as master
    join requested on requested.match_id = master.match_id
    order by master.match_id
    for update skip locked
  )
  select coalesce(
    array_agg(locked_master.match_id order by locked_master.match_id),
    array[]::text[]
  )
  into locked_master_match_ids
  from locked_master;

  select coalesce(
    array_agg(candidate.match_id order by candidate.match_id),
    array[]::text[]
  )
  into eligible_match_ids
  from unnest(eligible_match_ids) as candidate(match_id)
  where not exists (
    select 1
    from public.match_master_telemetry as master
    where master.match_id = candidate.match_id
  )
    or candidate.match_id = any(locked_master_match_ids);

  select coalesce(
    array_agg(requested.match_id order by requested.match_id),
    array[]::text[]
  )
  into eligible_match_ids
  from unnest(eligible_match_ids) as requested(match_id)
  left join public.match_master_telemetry as master
    on master.match_id = requested.match_id
  where (
      (
        master.match_id is not null
        and (
          master.telemetry_version < p_target_version
          or master.created_at < p_cutoff
        )
      )
      or (
        master.match_id is null
        and exists (
          select 1
          from public.telemetry_map_cache_entries as orphan_cache
          where orphan_cache.match_id = requested.match_id
            and (
              (
                orphan_cache.status = 'ready'
                and orphan_cache.updated_at < p_cutoff
              )
              or (
                orphan_cache.status = 'pending'
                and (
                  orphan_cache.lease_expires_at is null
                  or orphan_cache.lease_expires_at < p_now
                )
              )
            )
        )
      )
    )
    and not exists (
      select 1
      from public.telemetry_map_cache_entries as cache
      where cache.match_id = requested.match_id
        and (
          (cache.status = 'ready' and cache.updated_at >= p_cutoff)
          or (
            cache.status = 'pending'
            and cache.lease_expires_at >= p_now
          )
        )
    );

  if cardinality(eligible_match_ids) = 0 then
    return;
  end if;

  delete from public.match_stats_raw as stats
  where stats.match_id = any(eligible_match_ids);

  delete from public.processed_match_telemetry as processed
  where processed.match_id = any(eligible_match_ids);

  delete from public.telemetry_map_cache_entries as cache
  where cache.match_id = any(eligible_match_ids)
    and (
      (cache.status = 'ready' and cache.updated_at < p_cutoff)
      or (
        cache.status = 'pending'
        and (
          cache.lease_expires_at is null
          or cache.lease_expires_at < p_now
        )
      )
    );

  delete from public.match_master_telemetry as master
  where master.match_id = any(eligible_match_ids)
    and (
      master.telemetry_version < p_target_version
      or master.created_at < p_cutoff
    )
    and not exists (
      select 1
      from public.telemetry_map_cache_entries as cache
      where cache.match_id = master.match_id
    );

  if exists (
    select 1
    from public.telemetry_map_cache_entries as cache
    where cache.match_id = any(eligible_match_ids)
  ) or exists (
    select 1
    from public.match_master_telemetry as master
    where master.match_id = any(eligible_match_ids)
  ) then
    raise exception 'telemetry-cleanup-postcondition-failed' using errcode = '40001';
  end if;

  return query
  select eligible.match_id
  from unnest(eligible_match_ids) as eligible(match_id)
  order by eligible.match_id;
end;
$$;


ALTER FUNCTION "public"."cleanup_expired_telemetry_matches"("p_match_ids" "text"[], "p_cutoff" timestamp with time zone, "p_target_version" numeric, "p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_overwolf_session_events"("p_retention_days" integer) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."cleanup_overwolf_session_events"("p_retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_pubg_response_cache"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.pubg_response_cache WHERE expires_at < now() - interval '1 hour';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  DELETE FROM public.pubg_refresh_locks WHERE claimed_at < now() - interval '1 day';
  RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_pubg_response_cache"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compact_match_stats_raw"("p_apply" boolean DEFAULT false, "p_batch_limit" integer DEFAULT 5000) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  apply_changes boolean;
  batch_limit integer;
  candidate_count bigint;
  deleted_count bigint := 0;
  remaining_count bigint;
  total_count bigint;
BEGIN
  apply_changes := coalesce(p_apply, false);
  batch_limit := least(greatest(coalesce(p_batch_limit, 5000), 100), 5000);

  SELECT count(*)
  INTO candidate_count
  FROM public.match_stats_raw
  WHERE is_analysis_sample = false
    AND win_place <> 1;

  IF apply_changes AND candidate_count > 0 THEN
    WITH target AS (
      SELECT match_id, platform, player_id
      FROM public.match_stats_raw
      WHERE is_analysis_sample = false
        AND win_place <> 1
      ORDER BY created_at NULLS FIRST, match_id, platform, player_id
      LIMIT batch_limit
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.match_stats_raw AS stats
    USING target
    WHERE stats.match_id = target.match_id
      AND stats.platform = target.platform
      AND stats.player_id = target.player_id;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
  END IF;

  remaining_count := greatest(candidate_count - deleted_count, 0);
  SELECT count(*) INTO total_count FROM public.match_stats_raw;

  RETURN jsonb_build_object(
    'candidate_count', candidate_count,
    'deleted_count', deleted_count,
    'remaining_count', remaining_count,
    'total_count', total_count,
    'dry_run', NOT apply_changes
  );
END;
$$;


ALTER FUNCTION "public"."compact_match_stats_raw"("p_apply" boolean, "p_batch_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compact_pubg_player_cache"("p_retention_days" integer DEFAULT 90, "p_apply" boolean DEFAULT false, "p_batch_limit" integer DEFAULT 5000, "p_keep_recent" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  retention_days integer := coalesce(p_retention_days, 90);
  apply_changes boolean := coalesce(p_apply, false);
  batch_limit integer := coalesce(p_batch_limit, 5000);
  keep_recent integer := p_keep_recent;
  cutoff timestamptz;
  keep_boundary timestamptz;
  candidate_count bigint := 0;
  deleted_count bigint := 0;
  remaining_count bigint := 0;
  total_count bigint := 0;
begin
  if retention_days < 1 then
    raise exception 'player-cache-compaction-invalid-retention' using errcode = '22023';
  end if;
  if batch_limit < 100 or batch_limit > 20000 then
    raise exception 'player-cache-compaction-invalid-batch-limit' using errcode = '22023';
  end if;
  if keep_recent is not null and keep_recent < 0 then
    raise exception 'player-cache-compaction-invalid-keep-recent' using errcode = '22023';
  end if;

  cutoff := now() - make_interval(days => retention_days);

  -- 상한이 있으면 "최근 관측 순 keep_recent 번째" 행의 updated_at 을 경계로 쓴다.
  -- 그보다 오래된 행만 삭제 후보가 된다. 경계를 못 구하면(행이 상한보다 적음)
  -- 삭제할 것이 없다.
  if keep_recent is not null then
    select boundary.updated_at
    into keep_boundary
    from (
      select cache.updated_at
      from public.pubg_player_cache as cache
      order by cache.updated_at desc
      offset keep_recent
      limit 1
    ) as boundary;

    if keep_boundary is null then
      select count(*) into total_count from public.pubg_player_cache;
      return jsonb_build_object(
        'candidate_count', 0,
        'deleted_count', 0,
        'remaining_count', 0,
        'total_count', total_count,
        'retention_days', retention_days,
        'keep_recent', keep_recent,
        'dry_run', not apply_changes
      );
    end if;
  end if;

  select count(*)
  into candidate_count
  from public.pubg_player_cache as cache
  where cache.search_count = 0
    and cache.season_stats_data is null
    and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
    and (keep_boundary is null or cache.updated_at <= keep_boundary);

  if apply_changes and candidate_count > 0 then
    with doomed as (
      select cache.id
      from public.pubg_player_cache as cache
      where cache.search_count = 0
        and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
        and (keep_boundary is null or cache.updated_at <= keep_boundary)
      order by cache.updated_at
      limit batch_limit
    )
    delete from public.pubg_player_cache as cache
    using doomed
    where cache.id = doomed.id;

    get diagnostics deleted_count = row_count;
  end if;

  remaining_count := greatest(candidate_count - deleted_count, 0);
  select count(*) into total_count from public.pubg_player_cache;

  return jsonb_build_object(
    'candidate_count', candidate_count,
    'deleted_count', deleted_count,
    'remaining_count', remaining_count,
    'total_count', total_count,
    'retention_days', retention_days,
    'keep_recent', keep_recent,
    'dry_run', not apply_changes
  );
end;
$$;


ALTER FUNCTION "public"."compact_pubg_player_cache"("p_retention_days" integer, "p_apply" boolean, "p_batch_limit" integer, "p_keep_recent" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_board_image_upload"("p_image_id" "uuid", "p_owner_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  v_image public.board_image_objects%ROWTYPE;
  v_mime_type text;
  v_size bigint;
BEGIN
  SELECT image_row.* INTO v_image
  FROM public.board_image_objects AS image_row
  WHERE image_row.id = p_image_id AND image_row.owner_user_id = p_owner_user_id
    AND image_row.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT storage_object.metadata ->> 'mimetype', (storage_object.metadata ->> 'size')::bigint
  INTO v_mime_type, v_size
  FROM storage.objects AS storage_object
  WHERE storage_object.bucket_id = v_image.bucket_id AND storage_object.name = v_image.storage_key;
  IF NOT FOUND OR v_mime_type IS DISTINCT FROM v_image.expected_mime_type
    OR v_size IS NULL OR v_size > v_image.max_bytes THEN RETURN false; END IF;

  UPDATE public.board_image_objects AS image_row
  -- 미참조 ready 객체는 reserve 시점의 24시간 TTL을 유지하여 worker가 수거한다.
  SET status = 'ready', updated_at = now()
  WHERE image_row.id = v_image.id;
  RETURN true;
END;
$$;


ALTER FUNCTION "public"."complete_board_image_upload"("p_image_id" "uuid", "p_owner_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_analytics_event_quota"("p_session_id" "text", "p_event_count" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE current_count integer;
BEGIN
  IF length(p_session_id) = 0 OR length(p_session_id) > 100 OR p_event_count < 1 OR p_event_count > 25 THEN RETURN false; END IF;
  INSERT INTO public.analytics_event_rate_limits (session_id, window_started_at, event_count)
  VALUES (p_session_id, now(), p_event_count)
  ON CONFLICT (session_id) DO UPDATE
  SET window_started_at = CASE WHEN public.analytics_event_rate_limits.window_started_at < now() - interval '1 minute' THEN now() ELSE public.analytics_event_rate_limits.window_started_at END,
      event_count = CASE WHEN public.analytics_event_rate_limits.window_started_at < now() - interval '1 minute' THEN EXCLUDED.event_count ELSE public.analytics_event_rate_limits.event_count + EXCLUDED.event_count END
  RETURNING event_count INTO current_count;
  RETURN current_count <= 60;
END;
$$;


ALTER FUNCTION "public"."consume_analytics_event_quota"("p_session_id" "text", "p_event_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_board_write_quota"("p_scope" "text", "p_actor_hash" "text", "p_window_seconds" integer, "p_limit" integer) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
DECLARE
  v_allowed boolean;
BEGIN
  IF p_scope IS NULL
     OR p_actor_hash IS NULL
     OR p_window_seconds IS NULL
     OR p_limit IS NULL
     OR p_scope NOT IN ('post', 'comment')
     OR p_actor_hash !~ '^[a-f0-9]{64}$'
     OR p_window_seconds NOT BETWEEN 1 AND 3600
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN false;
  END IF;

  INSERT INTO public.board_write_rate_limits AS current_limit (
    scope,
    actor_hash,
    window_started_at,
    request_count
  ) VALUES (
    p_scope,
    p_actor_hash,
    statement_timestamp(),
    1
  )
  ON CONFLICT (scope, actor_hash) DO UPDATE
  SET
    window_started_at = CASE
      WHEN current_limit.window_started_at
        <= statement_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
        THEN statement_timestamp()
      ELSE current_limit.window_started_at
    END,
    request_count = CASE
      WHEN current_limit.window_started_at
        <= statement_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
        THEN 1
      ELSE current_limit.request_count + 1
    END
  WHERE current_limit.window_started_at
      <= statement_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
     OR current_limit.request_count < p_limit
  RETURNING true INTO v_allowed;

  RETURN COALESCE(v_allowed, false);
END;
$_$;


ALTER FUNCTION "public"."consume_board_write_quota"("p_scope" "text", "p_actor_hash" "text", "p_window_seconds" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_discord_room_quota"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."consume_discord_room_quota"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_overwolf_session_quota"("p_quota_key" "text", "p_max_events" integer, "p_window_seconds" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."consume_overwolf_session_quota"("p_quota_key" "text", "p_max_events" integer, "p_window_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."count_pubg_api_errors_in_window"("p_window_started_at" timestamp with time zone, "p_min_status" integer DEFAULT 500, "p_route" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select coalesce(count(*), 0)::integer
  from public.pubg_api_errors as errors
  where errors.created_at >= p_window_started_at
    and errors.status >= p_min_status
    and (p_route is null or errors.route = p_route);
$$;


ALTER FUNCTION "public"."count_pubg_api_errors_in_window"("p_window_started_at" timestamp with time zone, "p_min_status" integer, "p_route" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."crate_asset_key_from_image"("input_url" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
    SELECT nullif(
        regexp_replace(
            regexp_replace(
                split_part(coalesce(input_url, ''), '?', 1),
                '^.*/',
                ''
            ),
            '\.[^.]*$',
            ''
        ),
        ''
    )
$_$;


ALTER FUNCTION "public"."crate_asset_key_from_image"("input_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_published_post_comment"("p_post_id" bigint, "p_user_id" "uuid", "p_author" "text", "p_content" "text", "p_parent_id" bigint, "p_password_hash" "text", "p_ip_address" "text") RETURNS TABLE("id" bigint, "post_id" bigint, "user_id" "uuid", "author" "text", "content" "text", "parent_id" bigint, "created_at" timestamp with time zone)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  PERFORM 1
  FROM public.posts
  WHERE posts.id = p_post_id
    AND posts.status = 'published'
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_parent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.comments
    WHERE comments.id = p_parent_id
      AND comments.post_id = p_post_id
    FOR SHARE;

    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO public.comments (
    post_id,
    user_id,
    author,
    content,
    parent_id,
    password_hash,
    ip_address
  ) VALUES (
    p_post_id,
    p_user_id,
    p_author,
    p_content,
    p_parent_id,
    p_password_hash,
    p_ip_address
  )
  RETURNING
    comments.id,
    comments.post_id,
    comments.user_id,
    comments.author,
    comments.content,
    comments.parent_id,
    comments.created_at;
END;
$$;


ALTER FUNCTION "public"."create_published_post_comment"("p_post_id" bigint, "p_user_id" "uuid", "p_author" "text", "p_content" "text", "p_parent_id" bigint, "p_password_hash" "text", "p_ip_address" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_orphaned_stats"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    DELETE FROM match_stats_raw
    WHERE match_id NOT IN (SELECT match_id FROM match_master_telemetry);
END;
$$;


ALTER FUNCTION "public"."delete_orphaned_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_orphaned_stats_limited"("limit_count" integer) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    deleted_count int;
BEGIN
    WITH target_ids AS (
        SELECT id
        FROM match_stats_raw
        WHERE match_id NOT IN (SELECT match_id FROM match_master_telemetry)
        LIMIT limit_count
    )
    DELETE FROM match_stats_raw
    WHERE id IN (SELECT id FROM target_ids);
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."delete_orphaned_stats_limited"("limit_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_board_image_deletion"("p_image_id" "uuid", "p_lease_token" "uuid", "p_deleted" boolean) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  UPDATE public.board_image_objects AS object_row
  SET status = CASE WHEN p_deleted THEN 'deleted' ELSE 'delete_pending' END,
      delete_after = CASE WHEN p_deleted THEN object_row.delete_after ELSE now() + interval '1 day' END,
      delete_lease_until = NULL, delete_lease_token = NULL, updated_at = now()
  WHERE object_row.id = p_image_id AND object_row.status = 'deleting'
    AND object_row.delete_lease_token = p_lease_token;
  RETURN FOUND;
END;
$$;


ALTER FUNCTION "public"."finalize_board_image_deletion"("p_image_id" "uuid", "p_lease_token" "uuid", "p_deleted" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_telemetry_cache_write"("p_match_id" "text", "p_map_name" "text", "p_game_mode" "text", "p_master_version" numeric, "p_storage_path" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_cache_version" numeric, "p_cache_updated_at" timestamp with time zone, "p_cache_lease_token" "uuid", "p_processed_player_id" "text", "p_processed_platform" "text", "p_processed_data" "jsonb", "p_processed_updated_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if p_match_id is null
    or p_map_name is null
    or p_game_mode is null
    or p_master_version is null
    or p_storage_path is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_mode not in ('lite', 'full')
    or p_cache_version is null
    or p_cache_updated_at is null
    or not (
      (
        p_processed_player_id is null
        and p_processed_platform is null
        and p_processed_data is null
        and p_processed_updated_at is null
      )
      or (
        p_processed_player_id is not null
        and p_processed_platform is not null
        and p_processed_data is not null
        and p_processed_updated_at is not null
      )
    )
  then
    raise exception 'telemetry-finalize-invalid-input' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_match_id, 1952805741));

  if p_cache_lease_token is not null and not exists (
    select 1
    from public.telemetry_map_cache_entries as cache
    where cache.match_id = p_match_id
      and cache.platform = p_platform
      and cache.player_id = p_player_id
      and cache.mode = p_mode
      and cache.telemetry_version = p_cache_version
      and cache.status = 'pending'
      and cache.lease_token = p_cache_lease_token
    for update
  ) then
    raise exception 'telemetry-finalize-lease-lost' using errcode = '40001';
  end if;

  insert into public.match_master_telemetry (
    match_id,
    map_name,
    game_mode,
    telemetry_version,
    storage_path
  ) values (
    p_match_id,
    p_map_name,
    p_game_mode,
    p_master_version,
    p_storage_path
  )
  on conflict (match_id) do update set
    map_name = excluded.map_name,
    game_mode = excluded.game_mode,
    telemetry_version = excluded.telemetry_version,
    storage_path = excluded.storage_path;

  if p_processed_data is not null then
    insert into public.processed_match_telemetry (
      match_id,
      platform,
      player_id,
      data,
      updated_at
    ) values (
      p_match_id,
      p_processed_platform,
      p_processed_player_id,
      p_processed_data,
      p_processed_updated_at
    )
    on conflict (match_id, platform, player_id) do update set
      data = excluded.data,
      updated_at = excluded.updated_at;
  end if;

  insert into public.telemetry_map_cache_entries as cache (
    match_id,
    platform,
    player_id,
    mode,
    telemetry_version,
    storage_path,
    status,
    lease_expires_at,
    lease_token,
    updated_at
  ) values (
    p_match_id,
    p_platform,
    p_player_id,
    p_mode,
    p_cache_version,
    p_storage_path,
    'ready',
    null,
    null,
    p_cache_updated_at
  )
  on conflict (match_id, platform, player_id, mode, telemetry_version) do update set
    storage_path = excluded.storage_path,
    status = excluded.status,
    lease_expires_at = excluded.lease_expires_at,
    lease_token = excluded.lease_token,
    updated_at = excluded.updated_at
  where p_cache_lease_token is null or cache.lease_token = p_cache_lease_token;

  if not found then
    raise exception 'telemetry-finalize-lease-lost' using errcode = '40001';
  end if;
end;
$$;


ALTER FUNCTION "public"."finalize_telemetry_cache_write"("p_match_id" "text", "p_map_name" "text", "p_game_mode" "text", "p_master_version" numeric, "p_storage_path" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_cache_version" numeric, "p_cache_updated_at" timestamp with time zone, "p_cache_lease_token" "uuid", "p_processed_player_id" "text", "p_processed_platform" "text", "p_processed_data" "jsonb", "p_processed_updated_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_db_size"() RETURNS bigint
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT pg_database_size(current_database());
$$;


ALTER FUNCTION "public"."get_db_size"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_index_usage"("p_table_name" "text" DEFAULT NULL::"text") RETURNS TABLE("table_name" "text", "index_name" "text", "index_bytes" bigint, "scan_count" bigint, "tuples_read" bigint, "is_unique" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    stats.relname::text as table_name,
    stats.indexrelname::text as index_name,
    pg_relation_size(stats.indexrelid) as index_bytes,
    stats.idx_scan as scan_count,
    stats.idx_tup_read as tuples_read,
    indexes.indisunique as is_unique
  from pg_stat_user_indexes as stats
  join pg_index as indexes on indexes.indexrelid = stats.indexrelid
  where stats.schemaname = 'public'
    and (p_table_name is null or stats.relname = p_table_name)
  order by pg_relation_size(stats.indexrelid) desc;
$$;


ALTER FUNCTION "public"."get_index_usage"("p_table_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_next_marker_id"("map_id_in" "text", "marker_type_in" "text") RETURNS bigint
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
    next_id BIGINT;
    m_code TEXT;
    t_code TEXT;
BEGIN
    -- MAP_CODE와 TYPE_CODE는 app/api/admin/approve/route.ts의 정의와 일치해야 합니다.
    SELECT CASE map_id_in
        WHEN 'Erangel' THEN '1'
        WHEN 'Miramar' THEN '2'
        WHEN 'Taego'   THEN '3'
        WHEN 'Deston'  THEN '4'
        WHEN 'Vikendi' THEN '5'
        WHEN 'Rondo'   THEN '6'
        ELSE '9' -- Fallback code
    END INTO m_code;

    SELECT CASE marker_type_in
        WHEN 'Garage' THEN '01'
        WHEN 'Esports' THEN '02'
        WHEN 'Boat' THEN '03'
        WHEN 'EsportsBoat' THEN '04'
        WHEN 'Glider' THEN '05'
        WHEN 'Key' THEN '06'
        WHEN 'Porter' THEN '07'
        WHEN 'SecretRoom' THEN '08'
        WHEN 'GoldenMirado' THEN '09'
        WHEN 'EsportsMirado' THEN '10'
        WHEN 'EsportsPickup' THEN '11'
        WHEN 'PoliceCar' THEN '12'
        WHEN 'SecurityCard' THEN '13'
        WHEN 'GasPump' THEN '14'
        WHEN 'Snowmobile' THEN '15'
        ELSE '99' -- Fallback code
    END INTO t_code;

    -- map_markers 테이블에 대한 배타적 잠금 설정 (Race Condition 방지)
    LOCK TABLE map_markers IN EXCLUSIVE MODE;

    -- 현재 맵과 타입에 해당하는 최대 ID 조회
    SELECT COALESCE(MAX(id), 0) INTO next_id
    FROM map_markers
    WHERE map_id = map_id_in AND type = marker_type_in;

    IF next_id = 0 THEN
        -- 해당 차종의 첫 제보라면 001번으로 발급 (예: 103001)
        next_id := (m_code || t_code || '001')::BIGINT;
    ELSE
        -- 기존에 같은 맵, 같은 차종이 있다면 가장 마지막 번호 + 1 (예: 103001 -> 103002)
        next_id := next_id + 1;
    END IF;

    RETURN next_id;
END;
$$;


ALTER FUNCTION "public"."get_next_marker_id"("map_id_in" "text", "marker_type_in" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_orphaned_match_ids"() RETURNS TABLE("match_id" "text")
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT ms.match_id
    FROM match_stats_raw ms
    LEFT JOIN match_master_telemetry mm ON ms.match_id = mm.match_id
    WHERE mm.match_id IS NULL
    LIMIT 1000;
END;
$$;


ALTER FUNCTION "public"."get_orphaned_match_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_overwolf_session"("p_session_id" "text") RETURNS TABLE("session_id" "text", "match_id" "text", "pseudo_match_id" "text", "player_id" "text", "platform" "text", "gep_summary" "jsonb", "event_timeline" "jsonb", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."get_overwolf_session"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_table_sizes"("p_limit" integer DEFAULT 20) RETURNS TABLE("table_name" "text", "total_bytes" bigint, "table_bytes" bigint, "index_bytes" bigint, "row_estimate" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    relations.relname::text as table_name,
    pg_total_relation_size(relations.oid) as total_bytes,
    pg_table_size(relations.oid) as table_bytes,
    pg_indexes_size(relations.oid) as index_bytes,
    relations.reltuples::bigint as row_estimate
  from pg_class as relations
  join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
  where namespaces.nspname = 'public'
    and relations.relkind = 'r'
  order by pg_total_relation_size(relations.oid) desc
  limit greatest(coalesce(p_limit, 20), 1);
$$;


ALTER FUNCTION "public"."get_table_sizes"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.profiles (id, nickname, avatar_url, role)
  VALUES (
    new.id,
    COALESCE(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'user_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'nickname',
      'User'
    ),
    COALESCE(
      new.raw_user_meta_data->>'avatar_url',
      new.raw_user_meta_data->>'avatar'
    ),
    'user'
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_likes"("row_id" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.posts SET likes = likes + 1 WHERE id = row_id;
END;
$$;


ALTER FUNCTION "public"."increment_likes"("row_id" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_player_search_count"("player_id" "text", "player_nickname" "text", "player_platform" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    INSERT INTO pubg_player_cache (id, nickname, lower_nickname, platform, search_count, updated_at)
    VALUES (player_id, player_nickname, LOWER(player_nickname), player_platform, 1, NOW())
    ON CONFLICT (id) 
    DO UPDATE SET 
        search_count = pubg_player_cache.search_count + 1,
        updated_at = EXCLUDED.updated_at,
        nickname = EXCLUDED.nickname;
END;
$$;


ALTER FUNCTION "public"."increment_player_search_count"("player_id" "text", "player_nickname" "text", "player_platform" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_views"("row_id" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.posts SET views = views + 1 WHERE id = row_id;
END;
$$;


ALTER FUNCTION "public"."increment_views"("row_id" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."inspect_board_image_deletion_candidates"("p_now" timestamp with time zone) RETURNS TABLE("candidate_status" "text", "candidate_count" bigint)
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
  SELECT object_row.status, count(*)::bigint
  FROM public.board_image_objects AS object_row
  WHERE p_now IS NOT NULL
    AND ((object_row.status = 'delete_pending' AND object_row.delete_after <= p_now)
      OR (object_row.status = 'deleting' AND object_row.delete_lease_until <= p_now)
      OR (object_row.status IN ('pending', 'ready') AND object_row.expires_at <= p_now))
    AND NOT EXISTS (
      SELECT 1 FROM public.board_post_image_refs AS ref_row
      WHERE ref_row.image_id = object_row.id
    )
  GROUP BY object_row.status
  ORDER BY object_row.status;
$$;


ALTER FUNCTION "public"."inspect_board_image_deletion_candidates"("p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_overwolf_sessions"("p_player_id" "text", "p_platform" "text", "p_limit" integer) RETURNS TABLE("session_id" "text", "match_id" "text", "pseudo_match_id" "text", "player_id" "text", "platform" "text", "gep_summary" "jsonb", "event_timeline" "jsonb", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."list_overwolf_sessions"("p_player_id" "text", "p_platform" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lock_telemetry_cache_match"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  first_match_id text;
  second_match_id text;
begin
  if tg_op = 'DELETE' then
    first_match_id := old.match_id;
  elsif tg_op = 'UPDATE' and old.match_id is distinct from new.match_id then
    first_match_id := least(old.match_id, new.match_id);
    second_match_id := greatest(old.match_id, new.match_id);
  else
    first_match_id := new.match_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(first_match_id, 1952805741));
  if second_match_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(second_match_id, 1952805741));
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."lock_telemetry_cache_match"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_board_post_draft_with_images"("p_draft_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_parent_revision" bigint) RETURNS TABLE("result_code" "text", "post_id" bigint, "revision" bigint, "title" "text", "content" "text", "image_url" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  v_parent public.posts%ROWTYPE;
  v_draft public.posts%ROWTYPE;
  v_sibling_draft_ids bigint[];
  v_candidate_image_ids uuid[];
BEGIN
  IF p_draft_post_id IS NULL OR p_actor_user_id IS NULL OR p_expected_parent_revision IS NULL
    OR p_expected_parent_revision < 0 THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(42117, 1);

  -- 부모와 선택 초안을 같은 순서로 잠가, 서로 다른 shadow 초안 승격도 직렬화한다.
  FOR v_parent IN
    SELECT post_row.*
    FROM public.posts AS post_row
    WHERE post_row.id IN (
      p_draft_post_id,
      (SELECT draft_row.parent_id FROM public.posts AS draft_row WHERE draft_row.id = p_draft_post_id)
    )
    ORDER BY post_row.id
    FOR UPDATE
  LOOP
    IF v_parent.id = p_draft_post_id THEN v_draft := v_parent; END IF;
  END LOOP;

  IF v_draft.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_draft.status <> 'draft' THEN
    RETURN QUERY SELECT 'already_promoted'::text, v_draft.id, v_draft.revision, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS profile_row
    WHERE profile_row.id = p_actor_user_id AND profile_row.role = 'admin'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, v_draft.id, v_draft.revision, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  -- parent 없는 신규 초안도 기존 승격 API 호환을 위해 같은 RPC 안에서 발행한다.
  IF v_draft.parent_id IS NULL THEN
    IF v_draft.revision <> p_expected_parent_revision THEN
      RETURN QUERY SELECT 'revision_conflict'::text, v_draft.id, v_draft.revision, NULL::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    UPDATE public.posts AS post_row
    SET status = 'published', revision = post_row.revision + 1
    WHERE post_row.id = v_draft.id
    RETURNING post_row.revision INTO v_draft.revision;
    RETURN QUERY SELECT 'ok'::text, v_draft.id, v_draft.revision,
      v_draft.title, v_draft.content, v_draft.image_url;
    RETURN;
  END IF;

  SELECT post_row.* INTO v_parent
  FROM public.posts AS post_row
  WHERE post_row.id = v_draft.parent_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_parent.revision <> p_expected_parent_revision THEN
    RETURN QUERY SELECT 'revision_conflict'::text, v_parent.id, v_parent.revision, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 기존 API 의미를 유지해 같은 부모의 모든 shadow draft를 함께 제거한다.
  SELECT array_agg(draft_row.id ORDER BY draft_row.id) INTO v_sibling_draft_ids
  FROM (
    SELECT post_row.id
    FROM public.posts AS post_row
    WHERE post_row.parent_id = v_parent.id
      AND post_row.status = 'draft'
    ORDER BY post_row.id
    FOR UPDATE
  ) AS draft_row;
  IF v_sibling_draft_ids IS NULL OR NOT p_draft_post_id = ANY(v_sibling_draft_ids) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- ref 삭제/이전과 cleanup worker 간의 lock 순서를 image UUID 오름차순으로 맞춘다.
  SELECT array_agg(DISTINCT ref_row.image_id ORDER BY ref_row.image_id) INTO v_candidate_image_ids
  FROM public.board_post_image_refs AS ref_row
  WHERE ref_row.post_id = v_parent.id OR ref_row.post_id = ANY(v_sibling_draft_ids);
  PERFORM image_row.id
  FROM public.board_image_objects AS image_row
  WHERE image_row.id = ANY(COALESCE(v_candidate_image_ids, ARRAY[]::uuid[]))
  ORDER BY image_row.id
  FOR UPDATE;

  DELETE FROM public.board_post_image_refs AS ref_row
  WHERE ref_row.post_id = v_parent.id;

  INSERT INTO public.board_post_image_refs (post_id, image_id, usage)
  SELECT v_parent.id, ref_row.image_id, ref_row.usage
  FROM public.board_post_image_refs AS ref_row
  WHERE ref_row.post_id = p_draft_post_id
  ON CONFLICT DO NOTHING;

  UPDATE public.posts AS post_row
  SET title = v_draft.title, content = v_draft.content, category = v_draft.category,
      image_url = v_draft.image_url, discord_url = v_draft.discord_url,
      discord_channel_id = v_draft.discord_channel_id, clan_info = v_draft.clan_info,
      is_notice = v_draft.is_notice, status = 'published', revision = post_row.revision + 1
  WHERE post_row.id = v_parent.id
  RETURNING post_row.revision INTO v_parent.revision;

  DELETE FROM public.posts AS post_row
  WHERE post_row.id = ANY(v_sibling_draft_ids);

  UPDATE public.board_image_objects AS image_row
  SET status = 'delete_pending', delete_after = now(), delete_lease_until = NULL,
      delete_lease_token = NULL, updated_at = now()
  WHERE image_row.id = ANY(COALESCE(v_candidate_image_ids, ARRAY[]::uuid[]))
    AND image_row.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM public.board_post_image_refs AS ref_row
      WHERE ref_row.image_id = image_row.id
    );

  RETURN QUERY SELECT 'ok'::text, v_parent.id, v_parent.revision,
    v_draft.title, v_draft.content, v_draft.image_url;
END;
$$;


ALTER FUNCTION "public"."merge_board_post_draft_with_images"("p_draft_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_parent_revision" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_crate_asset_name"("input_name" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT trim(both '_' from regexp_replace(lower(coalesce(input_name, '')), '[^[:alnum:]]+', '_', 'g'))
$$;


ALTER FUNCTION "public"."normalize_crate_asset_name"("input_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_profile_role_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."prevent_profile_role_escalation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_pending_marker_admin_action"("p_marker_id" "uuid", "p_action" "text") RETURNS TABLE("id" "uuid", "map_name" "text", "marker_type" "text", "x" double precision, "y" double precision, "contributor_ids" "uuid"[], "new_marker_id" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE pending_marker public.pending_markers%ROWTYPE; marker_id bigint;
BEGIN
  IF p_action NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'invalid admin action'; END IF;
  SELECT * INTO pending_marker FROM public.pending_markers WHERE pending_markers.id = p_marker_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_action = 'approve' THEN
    marker_id := public.get_next_marker_id(pending_marker.map_name, pending_marker.marker_type);
    INSERT INTO public.map_markers (id, map_id, name, type, x, y)
    VALUES (marker_id, pending_marker.map_name, pending_marker.marker_type, pending_marker.marker_type, pending_marker.x, pending_marker.y);
  END IF;
  DELETE FROM public.pending_markers WHERE pending_markers.id = p_marker_id;
  RETURN QUERY SELECT pending_marker.id, pending_marker.map_name, pending_marker.marker_type, pending_marker.x, pending_marker.y, pending_marker.contributor_ids, CASE WHEN p_action = 'approve' THEN marker_id ELSE NULL END;
END;
$$;


ALTER FUNCTION "public"."process_pending_marker_admin_action"("p_marker_id" "uuid", "p_action" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."read_pubg_response_cache"("p_cache_key" "text") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT payload
  FROM public.pubg_response_cache
  WHERE cache_key = p_cache_key
    AND expires_at > now();
$$;


ALTER FUNCTION "public"."read_pubg_response_cache"("p_cache_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_overwolf_session_event"("p_session_id" "text", "p_match_id" "text", "p_pseudo_match_id" "text", "p_player_id" "text", "p_platform" "text", "p_gep_summary" "jsonb", "p_client_environment" "jsonb", "p_source_host" "text", "p_is_internal" boolean, "p_event_timeline" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."record_overwolf_session_event"("p_session_id" "text", "p_match_id" "text", "p_pseudo_match_id" "text", "p_player_id" "text", "p_platform" "text", "p_gep_summary" "jsonb", "p_client_environment" "jsonb", "p_source_host" "text", "p_is_internal" boolean, "p_event_timeline" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_lease_token" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if p_match_id is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_mode not in ('lite', 'full')
    or p_telemetry_version is null
    or p_lease_token is null
  then
    raise exception 'telemetry-release-invalid-input' using errcode = '22023';
  end if;

  delete from public.telemetry_map_cache_entries as cache
  where cache.match_id = p_match_id
    and cache.platform = p_platform
    and cache.player_id = p_player_id
    and cache.mode = p_mode
    and cache.telemetry_version = p_telemetry_version
    and cache.status = 'pending'
    and cache.lease_token = p_lease_token;
end;
$$;


ALTER FUNCTION "public"."release_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_lease_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_board_image_upload"("p_owner_user_id" "uuid", "p_expected_mime_type" "text", "p_max_bytes" bigint) RETURNS TABLE("result_code" "text", "image_id" "uuid", "bucket_id" "text", "storage_key" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  v_image_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_window_started_at timestamptz;
  v_reservation_count integer;
  v_active_count integer;
  v_active_bytes bigint;
BEGIN
  IF p_owner_user_id IS NULL OR p_expected_mime_type NOT IN ('image/png', 'image/jpeg', 'image/webp')
    OR p_max_bytes IS DISTINCT FROM 1572864 THEN
    RAISE EXCEPTION 'invalid_board_image_reservation';
  END IF;

  -- owner 단위 transaction advisory lock으로 동시 reserve의 rate/quota 검사를 직렬화한다.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_user_id::text));

  SELECT rate_limit.window_started_at, rate_limit.reservation_count
  INTO v_window_started_at, v_reservation_count
  FROM public.board_image_reservation_rate_limits AS rate_limit
  WHERE rate_limit.owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_window_started_at <= v_now - interval '1 minute' THEN
    v_window_started_at := v_now;
    v_reservation_count := 0;
  END IF;

  IF v_reservation_count >= 10 THEN
    RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT count(*)::integer, COALESCE(sum(COALESCE(image_row.max_bytes, 0)), 0)
  INTO v_active_count, v_active_bytes
  FROM public.board_image_objects AS image_row
  WHERE image_row.owner_user_id = p_owner_user_id
    AND image_row.status IN ('pending', 'ready', 'delete_pending', 'deleting');

  -- Supabase Free 1 GB의 사용자별 5% 안전 한도로 50 MiB를 hard cap 한다.
  IF v_active_count >= 40 OR v_active_bytes + 1572864 > 52428800 THEN
    RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.board_image_reservation_rate_limits (
    owner_user_id, window_started_at, reservation_count, updated_at
  ) VALUES (
    p_owner_user_id, v_window_started_at, v_reservation_count + 1, v_now
  ) ON CONFLICT (owner_user_id) DO UPDATE
  SET window_started_at = EXCLUDED.window_started_at,
      reservation_count = EXCLUDED.reservation_count,
      updated_at = EXCLUDED.updated_at;

  INSERT INTO public.board_image_objects (
    id, bucket_id, storage_key, owner_user_id, status, expected_mime_type, max_bytes, expires_at
  ) VALUES (
    v_image_id, 'board-images-v2', v_image_id::text, p_owner_user_id, 'pending',
    p_expected_mime_type, 1572864, now() + interval '24 hours'
  );
  RETURN QUERY SELECT 'ok'::text, v_image_id, 'board-images-v2'::text, v_image_id::text;
END;
$$;


ALTER FUNCTION "public"."reserve_board_image_upload"("p_owner_user_id" "uuid", "p_expected_mime_type" "text", "p_max_bytes" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_pubg_api_alert_delivery"("p_alert_key" "text", "p_window_started_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
  with inserted as (
    insert into public.pubg_api_alert_deliveries (
      alert_key,
      window_started_at
    )
    values (
      p_alert_key,
      p_window_started_at
    )
    on conflict do nothing
    returning true as reserved
  )
  select coalesce(
    (select inserted.reserved from inserted),
    false
  );
$$;


ALTER FUNCTION "public"."reserve_pubg_api_alert_delivery"("p_alert_key" "text", "p_window_started_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revert_weapon_patch_apply"("p_log_id" "uuid", "p_actor" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_log public.weapon_patch_apply_log%rowtype;
  v_column_type text;
  v_before_value jsonb;
  v_operation text;
begin
  select * into v_log
  from public.weapon_patch_apply_log
  where weapon_patch_apply_log.id = p_log_id
  for update;

  if not found then
    raise exception 'weapon patch apply log not found: %', p_log_id;
  end if;

  if v_log.reverted_at is not null then
    raise exception 'weapon patch apply log already reverted: %', p_log_id;
  end if;

  select c.operation into v_operation
  from public.weapon_patch_proposal_changes c
  where c.id = v_log.change_id;

  if v_operation = 'remove' then
    -- 적용 전 스냅샷의 삭제 상태를 그대로 되돌린다.
    execute format(
      'update public.%I set removed_at = $1, removed_patch_version = $2 where id = $3',
      v_log.target_table
    ) using
      (v_log.before_row ->> 'removed_at')::timestamptz,
      v_log.before_row ->> 'removed_patch_version',
      v_log.target_id;
  else
    v_before_value := v_log.before_row -> v_log.column_name;

    select a.atttypid::regtype::text into v_column_type
    from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', v_log.target_table)::regclass
      and a.attname = v_log.column_name
      and a.attnum > 0
      and not a.attisdropped;

    if v_column_type is null then
      raise exception 'column not found: %.%', v_log.target_table, v_log.column_name;
    end if;

    if v_before_value is null or v_before_value = 'null'::jsonb then
      execute format('update public.%I set %I = null where id = $1', v_log.target_table, v_log.column_name)
        using v_log.target_id;
    else
      execute format(
        'update public.%I set %I = ($1::text)::%s where id = $2',
        v_log.target_table, v_log.column_name, v_column_type
      ) using (v_before_value #>> '{}'), v_log.target_id;
    end if;
  end if;

  -- 적용 시 patch_version 을 덮어썼다면 이전 값으로 되돌린다.
  if v_log.patch_version is not null then
    execute format(
      'update public.%I set patch_version = $1 where id = $2',
      v_log.target_table
    ) using v_log.previous_patch_version, v_log.target_id;
  end if;

  update public.weapon_patch_apply_log
    set reverted_at = timezone('utc', now()),
        reverted_by = p_actor
    where weapon_patch_apply_log.id = p_log_id;
end;
$_$;


ALTER FUNCTION "public"."revert_weapon_patch_apply"("p_log_id" "uuid", "p_actor" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."serialize_board_post_image_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  -- statement row lock이 시작되기 전에 잠그므로 다중 post 삭제의 역순 image lock을 막는다.
  PERFORM pg_catalog.pg_advisory_xact_lock(42117, 1);
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."serialize_board_post_image_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_profile_role"("p_user_id" "uuid", "p_role" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."set_profile_role"("p_user_id" "uuid", "p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."suggest_similar_players"("search_name" "text", "search_platform" "text", "limit_val" integer DEFAULT 3) RETURNS TABLE("nickname" "text", "platform" "text", "similarity" real)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    c.nickname, 
    c.platform, 
    similarity(c.lower_nickname, lower(search_name))::REAL AS sim
  FROM pubg_player_cache c
  WHERE 
    c.platform = search_platform
    AND similarity(c.lower_nickname, lower(search_name)) > 0.2
  ORDER BY sim DESC
  LIMIT limit_val;
END;
$$;


ALTER FUNCTION "public"."suggest_similar_players"("search_name" "text", "search_platform" "text", "limit_val" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."transition_board_image_orphans_before_post_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_image_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT ref_row.image_id ORDER BY ref_row.image_id) INTO v_image_ids
  FROM public.board_post_image_refs AS ref_row
  WHERE ref_row.post_id = OLD.id;

  PERFORM image_row.id
  FROM public.board_image_objects AS image_row
  WHERE image_row.id = ANY(COALESCE(v_image_ids, ARRAY[]::uuid[]))
  ORDER BY image_row.id
  FOR UPDATE;

  UPDATE public.board_image_objects AS image_row
  SET status = 'delete_pending', delete_after = now(), delete_lease_until = NULL,
      delete_lease_token = NULL, updated_at = now()
  WHERE image_row.id = ANY(COALESCE(v_image_ids, ARRAY[]::uuid[]))
    AND image_row.status = 'ready'
    AND image_row.status <> 'legacy_retained'
    AND NOT EXISTS (
      SELECT 1 FROM public.board_post_image_refs AS ref_row
      WHERE ref_row.image_id = image_row.id AND ref_row.post_id <> OLD.id
    );
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."transition_board_image_orphans_before_post_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_hotdrop_counts"("rows" json) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  r json;
begin
  for r in select * from json_array_elements(rows)
  loop
    insert into public.hotdrop_heatmap
      (map_name, season, grid_x, grid_y, px, py, count, updated_at)
    values (
      (r->>'map_name')::varchar,
      (r->>'season')::varchar,
      (r->>'grid_x')::smallint,
      (r->>'grid_y')::smallint,
      (r->>'px')::float,
      (r->>'py')::float,
      (r->>'count')::integer,
      now()
    )
    on conflict (map_name, season, grid_x, grid_y)
    do update set
      count      = hotdrop_heatmap.count + excluded.count,
      updated_at = now();
  end loop;
end;
$$;


ALTER FUNCTION "public"."upsert_hotdrop_counts"("rows" json) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_hotdrop_counts"("rows" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  r json;
begin
  for r in select * from json_array_elements(rows::json)
  loop
    insert into public.hotdrop_heatmap
      (map_name, season, grid_x, grid_y, px, py, count, updated_at)
    values (
      (r->>'map_name')::varchar,
      (r->>'season')::varchar,
      (r->>'grid_x')::smallint,
      (r->>'grid_y')::smallint,
      (r->>'px')::float,
      (r->>'py')::float,
      (r->>'count')::integer,
      now()
    )
    on conflict (map_name, season, grid_x, grid_y)
    do update set
      count      = hotdrop_heatmap.count + excluded.count,
      updated_at = now();
  end loop;
end;
$$;


ALTER FUNCTION "public"."upsert_hotdrop_counts"("rows" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."weapon_patch_editable_columns"() RETURNS TABLE("target_table" "text", "column_name" "text")
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select * from (values
    ('weapons', 'damage'),
    ('weapons', 'bullet_speed'),
    ('weapons', 'ammo'),
    ('weapons', 'type'),
    ('weapons', 'availability'),
    ('weapons', 'spawn_maps'),
    ('weapons', 'weight'),
    ('weapons', 'patch_notes'),
    ('attachments', 'vertical_recoil'),
    ('attachments', 'horizontal_recoil'),
    ('attachments', 'reload_speed'),
    ('attachments', 'ads_speed'),
    ('attachments', 'weight'),
    ('attachments', 'patch_notes'),
    ('ammo', 'weight'),
    ('ammo', 'patch_notes'),
    ('consumables', 'cast_time'),
    ('consumables', 'weight'),
    ('consumables', 'patch_notes'),
    ('throwables', 'weight'),
    ('throwables', 'patch_notes'),
    ('vehicles', 'trunk_capacity'),
    ('vehicles', 'patch_notes')
  ) as t(target_table, column_name);
$$;


ALTER FUNCTION "public"."weapon_patch_editable_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_board_post_with_images"("p_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_revision" bigint, "p_title" "text", "p_content" "text", "p_category" "text", "p_image_url" "text", "p_is_notice" boolean, "p_author" "text", "p_user_id" "uuid", "p_password_hash" "text", "p_ip_address" "text", "p_discord_url" "text", "p_discord_channel_id" "text", "p_clan_info" "jsonb", "p_content_image_ids" "uuid"[], "p_thumbnail_image_id" "uuid") RETURNS TABLE("result_code" "text", "post_id" bigint, "revision" bigint)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_new_post_id bigint;
  v_old_image_ids uuid[];
  v_requested_image_ids uuid[];
  v_image_id uuid;
BEGIN
  -- post/ref/image mutation은 게시글 삭제와 같은 transaction 잠금으로 직렬화한다.
  PERFORM pg_catalog.pg_advisory_xact_lock(42117, 1);
  IF p_post_id IS NOT NULL THEN
    SELECT post_row.* INTO v_post
    FROM public.posts AS post_row WHERE post_row.id = p_post_id FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::bigint; RETURN; END IF;
    IF p_actor_user_id IS NULL OR (v_post.user_id IS DISTINCT FROM p_actor_user_id AND NOT EXISTS (
      SELECT 1 FROM public.profiles AS profile_row
      WHERE profile_row.id = p_actor_user_id AND profile_row.role = 'admin'
    )) THEN RETURN QUERY SELECT 'forbidden'::text, v_post.id, v_post.revision; RETURN; END IF;
    IF v_post.revision <> p_expected_revision THEN
      RETURN QUERY SELECT 'revision_conflict'::text, v_post.id, v_post.revision; RETURN;
    END IF;
    v_new_post_id := v_post.id;
    SELECT array_agg(DISTINCT ref_row.image_id ORDER BY ref_row.image_id) INTO v_old_image_ids
    FROM public.board_post_image_refs AS ref_row WHERE ref_row.post_id = v_new_post_id;
  ELSE
    INSERT INTO public.posts AS post_row (
      title, content, category, image_url, is_notice, author, user_id, password_hash, ip_address,
      discord_url, discord_channel_id, clan_info
    ) VALUES (
      p_title, p_content, p_category, p_image_url, COALESCE(p_is_notice, false), p_author, p_user_id,
      p_password_hash, p_ip_address, p_discord_url, p_discord_channel_id, p_clan_info
    ) RETURNING post_row.id, post_row.revision INTO v_new_post_id, v_post.revision;
    v_old_image_ids := ARRAY[]::uuid[];
  END IF;

  v_requested_image_ids := array_cat(COALESCE(v_old_image_ids, ARRAY[]::uuid[]),
    array_cat(COALESCE(p_content_image_ids, ARRAY[]::uuid[]),
      CASE WHEN p_thumbnail_image_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[p_thumbnail_image_id] END));

  -- write와 claim은 모두 image id 오름차순으로 잠가 detach/attach와 worker 간 lock 순서를 고정한다.
  PERFORM 1
  FROM (
    WITH requested_image_ids AS (
      SELECT DISTINCT requested_item.requested_image_id
      FROM unnest(v_requested_image_ids) AS requested_item(requested_image_id)
    ), locked_image_ids AS (
      SELECT image_row.id
      FROM public.board_image_objects AS image_row
      JOIN requested_image_ids AS requested_row ON requested_row.requested_image_id = image_row.id
      ORDER BY requested_row.requested_image_id
      FOR UPDATE
    ) SELECT locked_image_ids.id FROM locked_image_ids
  ) AS locked_rows;

  FOREACH v_image_id IN ARRAY COALESCE(p_content_image_ids, ARRAY[]::uuid[]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.board_image_objects AS image_row
      WHERE image_row.id = v_image_id AND image_row.status = 'ready'
        AND (image_row.owner_user_id = p_actor_user_id OR EXISTS (
          SELECT 1 FROM public.board_post_image_refs AS ref_row
          WHERE ref_row.post_id = v_new_post_id AND ref_row.image_id = image_row.id
        ))
    ) THEN RAISE EXCEPTION 'invalid_board_image_reference'; END IF;
  END LOOP;
  IF p_thumbnail_image_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.board_image_objects AS image_row
    WHERE image_row.id = p_thumbnail_image_id AND image_row.status = 'ready'
      AND (image_row.owner_user_id = p_actor_user_id OR EXISTS (
        SELECT 1 FROM public.board_post_image_refs AS ref_row
        WHERE ref_row.post_id = v_new_post_id AND ref_row.image_id = image_row.id
      ))
  ) THEN RAISE EXCEPTION 'invalid_board_image_reference'; END IF;

  DELETE FROM public.board_post_image_refs AS ref_row WHERE ref_row.post_id = v_new_post_id;
  FOREACH v_image_id IN ARRAY COALESCE(p_content_image_ids, ARRAY[]::uuid[]) LOOP
    INSERT INTO public.board_post_image_refs (post_id, image_id, usage)
    VALUES (v_new_post_id, v_image_id, 'content') ON CONFLICT DO NOTHING;
  END LOOP;
  IF p_thumbnail_image_id IS NOT NULL THEN
    INSERT INTO public.board_post_image_refs (post_id, image_id, usage)
    VALUES (v_new_post_id, p_thumbnail_image_id, 'thumbnail') ON CONFLICT DO NOTHING;
  END IF;

  -- 실제로 이 write에서 참조된 ready 객체만 TTL을 제거한다.
  UPDATE public.board_image_objects AS image_row
  SET expires_at = NULL, updated_at = now()
  WHERE image_row.status = 'ready'
    AND image_row.id = ANY(COALESCE(p_content_image_ids, ARRAY[]::uuid[]) ||
      CASE WHEN p_thumbnail_image_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[p_thumbnail_image_id] END)
    AND EXISTS (
      SELECT 1 FROM public.board_post_image_refs AS ref_row
      WHERE ref_row.post_id = v_new_post_id AND ref_row.image_id = image_row.id
    );

  UPDATE public.board_image_objects AS image_row
  SET status = 'delete_pending', delete_after = now(), delete_lease_until = NULL,
      delete_lease_token = NULL, updated_at = now()
  WHERE image_row.id = ANY(COALESCE(v_old_image_ids, ARRAY[]::uuid[]))
    AND image_row.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM public.board_post_image_refs AS ref_row WHERE ref_row.image_id = image_row.id
    );

  IF p_post_id IS NOT NULL THEN
    UPDATE public.posts AS post_row
    SET title = p_title, content = p_content, category = p_category, image_url = p_image_url,
        is_notice = COALESCE(p_is_notice, false), discord_url = p_discord_url,
        discord_channel_id = p_discord_channel_id, clan_info = p_clan_info,
        revision = post_row.revision + 1
    WHERE post_row.id = v_new_post_id
    RETURNING post_row.revision INTO v_post.revision;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v_new_post_id, v_post.revision;
END;
$$;


ALTER FUNCTION "public"."write_board_post_with_images"("p_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_revision" bigint, "p_title" "text", "p_content" "text", "p_category" "text", "p_image_url" "text", "p_is_notice" boolean, "p_author" "text", "p_user_id" "uuid", "p_password_hash" "text", "p_ip_address" "text", "p_discord_url" "text", "p_discord_channel_id" "text", "p_clan_info" "jsonb", "p_content_image_ids" "uuid"[], "p_thumbnail_image_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_pubg_response_cache"("p_cache_key" "text", "p_payload" "jsonb", "p_ttl_seconds" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  ttl integer;
BEGIN
  IF p_cache_key IS NULL OR length(p_cache_key) = 0 OR length(p_cache_key) > 300 THEN
    RETURN;
  END IF;

  ttl := least(greatest(coalesce(p_ttl_seconds, 180), 1), 86400);

  INSERT INTO public.pubg_response_cache (cache_key, payload, expires_at, updated_at)
  VALUES (p_cache_key, p_payload, now() + make_interval(secs => ttl), now())
  ON CONFLICT (cache_key) DO UPDATE
  SET payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at,
      updated_at = now();
END;
$$;


ALTER FUNCTION "public"."write_pubg_response_cache"("p_cache_key" "text", "p_payload" "jsonb", "p_ttl_seconds" integer) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid",
    "step_id" "uuid",
    "requested_by" "uuid",
    "approved_by" "uuid",
    "tool_name" "text" NOT NULL,
    "action_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "text",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "decided_at" timestamp with time zone,
    "executed_at" timestamp with time zone,
    CONSTRAINT "agent_approvals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'executed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."agent_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_memories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."agent_memories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "message" "text" NOT NULL,
    "system_prompt" "text",
    "summary" "text",
    "error" "text",
    "started_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "agent_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."agent_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid",
    "tool_name" "text" NOT NULL,
    "safety_level" "text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "text",
    "error" "text",
    "started_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "agent_steps_safety_level_check" CHECK (("safety_level" = ANY (ARRAY['read'::"text", 'write'::"text", 'dangerous'::"text"]))),
    CONSTRAINT "agent_steps_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'success'::"text", 'failed'::"text", 'approval_required'::"text"])))
);


ALTER TABLE "public"."agent_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_usage_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "model_name" character varying(100) NOT NULL,
    "prompt_tokens" integer NOT NULL,
    "completion_tokens" integer NOT NULL,
    "cost_usd" numeric(10,6) NOT NULL,
    "analysis_type" character varying(50) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."ai_usage_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ammo" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "weight" numeric,
    "patch_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "can_be_in_backpack" boolean DEFAULT true,
    "icon_url" "text",
    "patch_version" "text",
    "patch_applied_at" timestamp with time zone,
    "removed_at" timestamp with time zone,
    "removed_patch_version" "text"
);


ALTER TABLE "public"."ammo" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."analytics_event_rate_limits" (
    "session_id" "text" NOT NULL,
    "window_started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."analytics_event_rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."analytics_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_name" "text" NOT NULL,
    "user_id" "uuid",
    "session_id" "text" NOT NULL,
    "page_path" "text" NOT NULL,
    "page_title" "text",
    "referrer_path" "text",
    "params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "event_date" "date" GENERATED ALWAYS AS ((("created_at" AT TIME ZONE 'Asia/Seoul'::"text"))::"date") STORED,
    "client_environment" "text",
    "source_host" "text",
    "is_internal" boolean DEFAULT false NOT NULL,
    CONSTRAINT "analytics_events_event_name_check" CHECK (("event_name" = ANY (ARRAY['page_view'::"text", 'stats_searched'::"text", 'battle_started'::"text", 'battle_completed'::"text", 'share_clicked'::"text", 'squad_synergy_completed'::"text", 'ai_squad_coaching_requested'::"text", 'ai_analysis_opened'::"text", 'replay_2d_opened'::"text", 'tab_clicked'::"text", 'map_viewed'::"text", 'weapon_viewed'::"text", 'feature_consumption'::"text", 'crate_opened'::"text", 'board_viewed'::"text", 'post_viewed'::"text", 'post_action'::"text"])))
);


ALTER TABLE "public"."analytics_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."analytics_events"."client_environment" IS 'Client-side execution environment reported by the analytics mirror. Used to distinguish production events from local/dev traffic.';



COMMENT ON COLUMN "public"."analytics_events"."source_host" IS 'Hostname that produced the mirrored analytics event. Used by Admin Agent to audit local or preview traffic contamination.';



COMMENT ON COLUMN "public"."analytics_events"."is_internal" IS 'True for local/dev/internal diagnostics when such events are explicitly accepted. Normal production analytics should remain false.';



CREATE TABLE IF NOT EXISTS "public"."attachments" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "weight" numeric,
    "effect" "text",
    "patch_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "can_be_in_backpack" boolean DEFAULT true,
    "icon_url" "text",
    "slot" "text",
    "r2_key" "text",
    "vertical_recoil" integer DEFAULT 0,
    "horizontal_recoil" integer DEFAULT 0,
    "reload_speed" integer DEFAULT 0,
    "ads_speed" integer DEFAULT 0,
    "patch_version" "text",
    "patch_applied_at" timestamp with time zone,
    "removed_at" timestamp with time zone,
    "removed_patch_version" "text"
);


ALTER TABLE "public"."attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."global_benchmarks" (
    "id" bigint NOT NULL,
    "match_id" "text" NOT NULL,
    "player_id" "text" NOT NULL,
    "counter_latency_ms" double precision,
    "initiative_rate" double precision,
    "enemy_death_distance" double precision,
    "damage" double precision,
    "win_place" integer,
    "game_mode" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "kills" integer,
    "revive_rate" double precision,
    "smoke_rate" double precision,
    "supp_count" double precision,
    "team_wipes" integer DEFAULT 0,
    "utility_count" integer DEFAULT 0,
    "survival_time" integer DEFAULT 0,
    "solo_kill_rate" integer DEFAULT 0,
    "map_name" "text",
    "isolation_index" double precision DEFAULT 0,
    "min_dist" double precision DEFAULT 0,
    "height_diff" double precision DEFAULT 0,
    "is_crossfire" boolean DEFAULT false,
    "smoke_count" integer DEFAULT 0,
    "frag_count" integer DEFAULT 0,
    "pressure_index" double precision DEFAULT 0,
    "filter_version" integer DEFAULT 1,
    "death_phase" integer,
    "trade_rate" double precision,
    "reversal_rate" double precision,
    "lethal_throw_count" integer DEFAULT 0,
    "tier" "text" DEFAULT 'A'::"text",
    "score" double precision,
    "duel_win_rate" double precision,
    "trade_latency_ms" double precision,
    "match_type" "text" DEFAULT 'official'::"text",
    "combat_score" double precision DEFAULT 0,
    "tactical_score" double precision DEFAULT 0,
    "survival_score" double precision DEFAULT 0,
    "source" "text" DEFAULT 'scraper'::"text",
    "platform" "text" DEFAULT 'legacy_unknown'::"text" NOT NULL
);


ALTER TABLE "public"."global_benchmarks" OWNER TO "postgres";


COMMENT ON COLUMN "public"."global_benchmarks"."kills" IS 'Number of kills in the match';



COMMENT ON COLUMN "public"."global_benchmarks"."revive_rate" IS 'Percentage of teammate knocks that were directly revived by this player';



COMMENT ON COLUMN "public"."global_benchmarks"."smoke_rate" IS 'Percentage of dangerous knocks covered by smoke';



COMMENT ON COLUMN "public"."global_benchmarks"."supp_count" IS 'Absolute number of suppression fire events in the match';



COMMENT ON COLUMN "public"."global_benchmarks"."team_wipes" IS 'Number of enemy teams wiped (contributed) in the match';



COMMENT ON COLUMN "public"."global_benchmarks"."smoke_count" IS 'Total smoke grenades used in the match';



COMMENT ON COLUMN "public"."global_benchmarks"."frag_count" IS 'Total frag grenades used in the match';



COMMENT ON COLUMN "public"."global_benchmarks"."pressure_index" IS 'Combat pressure exertion per minute (bullets + utility*2 / survival)';



COMMENT ON COLUMN "public"."global_benchmarks"."death_phase" IS '플레이어가 사망한 자기장 페이즈 번호 (0-9)';



COMMENT ON COLUMN "public"."global_benchmarks"."trade_rate" IS 'Percentage of teammate knocks that were successfully traded (avenged) by this player';



COMMENT ON COLUMN "public"."global_benchmarks"."trade_latency_ms" IS '평균 트레이드(복수) 소요 시간 (ms)';



COMMENT ON COLUMN "public"."global_benchmarks"."combat_score" IS '교전 지표 점수 (화력, 주도권, 반응속도 등)';



COMMENT ON COLUMN "public"."global_benchmarks"."tactical_score" IS '전술 지표 점수 (압박, 유틸리티, 팀워크 등)';



COMMENT ON COLUMN "public"."global_benchmarks"."survival_score" IS '생존 지표 점수 (생존 시간, 생존 페이즈 등)';



CREATE OR REPLACE VIEW "public"."benchmark_stats_by_tier" AS
 SELECT "tier",
    "game_mode",
    "match_type",
    "count"(*) AS "match_count",
    "avg"(NULLIF("damage", ('-1'::integer)::double precision)) AS "avg_damage",
    "avg"(NULLIF("kills", '-1'::integer)) AS "avg_kills",
    "avg"(NULLIF("survival_time", '-1'::integer)) AS "avg_survival_time",
    "avg"(NULLIF("duel_win_rate", ('-1'::integer)::double precision)) AS "avg_duel_win_rate",
    "avg"(NULLIF("initiative_rate", ('-1'::integer)::double precision)) AS "avg_initiative_rate",
    "avg"(NULLIF("trade_rate", ('-1'::integer)::double precision)) AS "avg_trade_rate",
    "avg"(NULLIF("revive_rate", ('-1'::integer)::double precision)) AS "avg_revive_rate",
    "avg"(NULLIF("smoke_rate", ('-1'::integer)::double precision)) AS "avg_smoke_rate",
    "avg"(NULLIF("pressure_index", ('-1'::integer)::double precision)) AS "avg_pressure_index",
    "avg"(NULLIF("team_wipes", '-1'::integer)) AS "avg_team_wipes",
    "avg"(NULLIF("reversal_rate", ('-1'::integer)::double precision)) AS "avg_reversal_rate",
    "avg"(NULLIF("isolation_index", ('-1'::integer)::double precision)) AS "avg_isolation_index",
    "avg"(NULLIF("min_dist", ('-1'::integer)::double precision)) AS "avg_min_dist",
    "avg"(NULLIF("counter_latency_ms", ('-1'::integer)::double precision)) AS "avg_counter_latency_ms",
    "avg"(NULLIF("trade_latency_ms", ('-1'::integer)::double precision)) AS "avg_trade_latency_ms",
    "avg"(NULLIF("solo_kill_rate", '-1'::integer)) AS "avg_solo_kill_rate",
    "avg"(NULLIF("death_phase", '-1'::integer)) AS "avg_death_phase"
   FROM "public"."global_benchmarks"
  GROUP BY "tier", "game_mode", "match_type";


ALTER VIEW "public"."benchmark_stats_by_tier" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."board_image_objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bucket_id" "text" NOT NULL,
    "storage_key" "text" NOT NULL,
    "owner_user_id" "uuid",
    "status" "text" NOT NULL,
    "expected_mime_type" "text",
    "max_bytes" bigint,
    "expires_at" timestamp with time zone,
    "delete_after" timestamp with time zone,
    "delete_lease_until" timestamp with time zone,
    "delete_lease_token" "uuid",
    "delete_attempts" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "board_image_objects_delete_attempts_check" CHECK (("delete_attempts" >= 0)),
    CONSTRAINT "board_image_objects_max_bytes_check" CHECK ((("max_bytes" IS NULL) OR (("max_bytes" > 0) AND ("max_bytes" <= 1572864)))),
    CONSTRAINT "board_image_objects_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'delete_pending'::"text", 'deleting'::"text", 'deleted'::"text", 'legacy_retained'::"text"])))
);


ALTER TABLE "public"."board_image_objects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."board_image_reservation_rate_limits" (
    "owner_user_id" "uuid" NOT NULL,
    "window_started_at" timestamp with time zone NOT NULL,
    "reservation_count" integer NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "board_image_reservation_rate_limits_reservation_count_check" CHECK ((("reservation_count" >= 0) AND ("reservation_count" <= 10)))
);


ALTER TABLE "public"."board_image_reservation_rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."board_post_image_refs" (
    "post_id" bigint NOT NULL,
    "image_id" "uuid" NOT NULL,
    "usage" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "board_post_image_refs_usage_check" CHECK (("usage" = ANY (ARRAY['content'::"text", 'thumbnail'::"text"])))
);


ALTER TABLE "public"."board_post_image_refs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."board_write_rate_limits" (
    "scope" "text" NOT NULL,
    "actor_hash" "text" NOT NULL,
    "window_started_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "request_count" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "board_write_rate_limits_actor_hash_check" CHECK (("actor_hash" ~ '^[a-f0-9]{64}$'::"text")),
    CONSTRAINT "board_write_rate_limits_request_count_check" CHECK (("request_count" > 0)),
    CONSTRAINT "board_write_rate_limits_scope_check" CHECK (("scope" = ANY (ARRAY['post'::"text", 'comment'::"text"])))
);


ALTER TABLE "public"."board_write_rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bonus_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "crate_template_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "probability" numeric(10,6) NOT NULL,
    "token_count" integer DEFAULT 0 NOT NULL,
    "is_prime_parcel" boolean DEFAULT false NOT NULL,
    "is_extra_crate" boolean DEFAULT false NOT NULL,
    "image_url" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "asset_key" "text",
    "normalized_name" "text",
    "r2_key" "text",
    "asset_id" "uuid"
);


ALTER TABLE "public"."bonus_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "text" NOT NULL,
    "label" "text" NOT NULL,
    "color" "text" DEFAULT '#ffffff'::"text" NOT NULL,
    "icon_id" "text" DEFAULT 'car'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" bigint NOT NULL,
    "post_id" bigint,
    "user_id" "uuid",
    "author" "text",
    "content" "text",
    "parent_id" bigint,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "password_hash" "text",
    "ip_address" "text"
);


ALTER TABLE "public"."comments" OWNER TO "postgres";


ALTER TABLE "public"."comments" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."comments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."consumables" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "weight" numeric,
    "effect" "text",
    "cast_time" "text",
    "patch_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "can_be_in_backpack" boolean DEFAULT true,
    "icon_url" "text",
    "patch_version" "text",
    "patch_applied_at" timestamp with time zone,
    "removed_at" timestamp with time zone,
    "removed_patch_version" "text"
);


ALTER TABLE "public"."consumables" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."craftable_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "season_key" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "token_cost" integer NOT NULL,
    "asset_id" "uuid",
    "category" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."craftable_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crate_item_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_key" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "r2_key" "text",
    "image_url" "text",
    "aliases" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "rarity" "text"
);


ALTER TABLE "public"."crate_item_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crate_item_relations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "crate_template_id" "uuid" NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "drop_type" "text" NOT NULL,
    "probability" numeric NOT NULL,
    "token_count" integer DEFAULT 0 NOT NULL,
    "is_prime_parcel" boolean DEFAULT false NOT NULL,
    "is_extra_crate" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "crate_item_relations_drop_type_check" CHECK (("drop_type" = ANY (ARRAY['base'::"text", 'prime'::"text", 'bonus'::"text"])))
);


ALTER TABLE "public"."crate_item_relations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crate_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "crate_template_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "rarity" "text" NOT NULL,
    "probability" numeric(10,6) NOT NULL,
    "image_url" "text",
    "is_prime_parcel" boolean DEFAULT false NOT NULL,
    "token_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "asset_key" "text",
    "normalized_name" "text",
    "r2_key" "text",
    "asset_id" "uuid"
);


ALTER TABLE "public"."crate_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crate_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "price_gcoin" integer DEFAULT 200 NOT NULL,
    "bundle_price_gcoin" integer DEFAULT 2000 NOT NULL,
    "image_url" "text",
    "description" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "end_date" timestamp with time zone,
    "asset_key" "text",
    "normalized_name" "text",
    "r2_key" "text",
    "asset_id" "uuid",
    "price_bp" integer,
    "price_bp_limit" integer DEFAULT 50,
    "ticket_currency_code" "text",
    "ticket_price_single" integer,
    "ticket_price_bundle" integer,
    "bonus_currency_code" "text",
    "bonus_amount_single" integer,
    "bonus_amount_bundle" integer
);


ALTER TABLE "public"."crate_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discord_room_rate_limits" (
    "user_id" "uuid" NOT NULL,
    "window_started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "room_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."discord_room_rate_limits" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."global_benchmarks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."global_benchmarks_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."global_benchmarks_id_seq" OWNED BY "public"."global_benchmarks"."id";



CREATE TABLE IF NOT EXISTS "public"."hotdrop_heatmap" (
    "id" bigint NOT NULL,
    "map_name" character varying(50) NOT NULL,
    "season" character varying(100) NOT NULL,
    "grid_x" smallint NOT NULL,
    "grid_y" smallint NOT NULL,
    "px" double precision NOT NULL,
    "py" double precision NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hotdrop_heatmap" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."hotdrop_heatmap_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."hotdrop_heatmap_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."hotdrop_heatmap_id_seq" OWNED BY "public"."hotdrop_heatmap"."id";



CREATE TABLE IF NOT EXISTS "public"."ip_blacklist" (
    "id" bigint NOT NULL,
    "ip_address" "text" NOT NULL,
    "reason" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ip_blacklist" OWNER TO "postgres";


ALTER TABLE "public"."ip_blacklist" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."ip_blacklist_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."map_markers" (
    "id" bigint NOT NULL,
    "map_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "x" double precision NOT NULL,
    "y" double precision NOT NULL
);


ALTER TABLE "public"."map_markers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."map_settings" (
    "map_id" "text" NOT NULL,
    "categories" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."map_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."match_ai_coaching_cache" (
    "match_id" character varying(255) NOT NULL,
    "coaching_style" character varying(50) NOT NULL,
    "ai_result" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "platform" "text" DEFAULT 'steam'::"text",
    "player_id" "text",
    "prompt_version" "text" DEFAULT 'legacy'::"text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."match_ai_coaching_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."match_master_telemetry" (
    "match_id" "text" NOT NULL,
    "map_name" "text",
    "game_mode" "text",
    "telemetry_events" "jsonb",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "telemetry_version" integer DEFAULT 1,
    "storage_path" "text"
);


ALTER TABLE "public"."match_master_telemetry" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."match_stats_raw" (
    "id" bigint NOT NULL,
    "match_id" "text" NOT NULL,
    "player_id" "text" NOT NULL,
    "damage" double precision NOT NULL,
    "kills" integer NOT NULL,
    "win_place" integer NOT NULL,
    "game_mode" "text",
    "map_name" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "match_type" "text" DEFAULT 'official'::"text",
    "platform" "text" DEFAULT 'legacy_unknown'::"text" NOT NULL,
    "is_analysis_sample" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."match_stats_raw" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."match_stats_raw_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."match_stats_raw_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."match_stats_raw_id_seq" OWNED BY "public"."match_stats_raw"."id";



CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "sender_id" "uuid",
    "sender_name" "text",
    "type" "text",
    "post_id" bigint,
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "preview_text" "text"
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


ALTER TABLE "public"."notifications" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."notifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."overwolf_session_events" (
    "session_id" "text" NOT NULL,
    "match_id" "text",
    "pseudo_match_id" "text",
    "player_id" "text",
    "platform" "text",
    "gep_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "client_environment" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_host" "text",
    "is_internal" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event_timeline" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."overwolf_session_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."overwolf_session_quota" (
    "quota_key" "text" NOT NULL,
    "event_count" integer DEFAULT 0 NOT NULL,
    "window_started_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."overwolf_session_quota" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pending_markers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "map_name" "text" NOT NULL,
    "marker_type" "text" NOT NULL,
    "x" double precision NOT NULL,
    "y" double precision NOT NULL,
    "weight" integer DEFAULT 1,
    "contributor_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "is_notified" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "down_weight" integer DEFAULT 0,
    "downvoter_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "is_down_notified" boolean DEFAULT false
);


ALTER TABLE "public"."pending_markers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."player_ai_summary_cache" (
    "player_id" character varying(255) NOT NULL,
    "match_ids_hash" character varying(64) NOT NULL,
    "ai_result" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "platform" "text" DEFAULT 'steam'::"text",
    "prompt_version" "text" DEFAULT 'legacy'::"text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."player_ai_summary_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."post_likes" (
    "id" bigint NOT NULL,
    "post_id" bigint,
    "user_id" "uuid"
);


ALTER TABLE "public"."post_likes" OWNER TO "postgres";


ALTER TABLE "public"."post_likes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."post_likes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."posts" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "content" "text",
    "author" "text",
    "views" bigint DEFAULT '0'::bigint,
    "user_id" "uuid",
    "category" "text",
    "likes" bigint DEFAULT '0'::bigint,
    "is_notice" boolean DEFAULT false,
    "image_url" "text",
    "discord_url" "text",
    "discord_channel_id" "text",
    "clan_info" "jsonb",
    "status" "public"."post_status" DEFAULT 'published'::"public"."post_status",
    "parent_id" integer,
    "password_hash" "text",
    "ip_address" "text",
    "revision" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."posts" OWNER TO "postgres";


ALTER TABLE "public"."posts" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."posts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."prime_parcel_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "crate_template_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "rarity" "text" NOT NULL,
    "probability" numeric(10,6) NOT NULL,
    "image_url" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "asset_key" "text",
    "normalized_name" "text",
    "r2_key" "text",
    "asset_id" "uuid"
);


ALTER TABLE "public"."prime_parcel_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."processed_match_telemetry" (
    "match_id" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "player_id" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "platform" "text" DEFAULT 'legacy_unknown'::"text" NOT NULL
);


ALTER TABLE "public"."processed_match_telemetry" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "nickname" "text",
    "avatar_url" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "role" "text" DEFAULT 'user'::"text",
    "pubg_nickname" "text",
    "pubg_platform" "text" DEFAULT 'steam'::"text",
    "last_active_at" timestamp with time zone
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pubg_api_alert_deliveries" (
    "alert_key" "text" NOT NULL,
    "window_started_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."pubg_api_alert_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pubg_api_errors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route" character varying(255) NOT NULL,
    "status" integer NOT NULL,
    "message" "text" NOT NULL,
    "detail" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "failure_stage" "text",
    "error_code" "text",
    "upstream_status" integer,
    "duration_ms" integer,
    "platform" "text",
    "source" "text",
    "client_kind" "text",
    "request_id" "text",
    "match_fingerprint" "text",
    "nickname_fingerprint" "text"
);


ALTER TABLE "public"."pubg_api_errors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pubg_api_status" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "api_limit" integer NOT NULL,
    "remaining" integer NOT NULL,
    "reset_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."pubg_api_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pubg_player_cache" (
    "id" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "nickname" "text" NOT NULL,
    "lower_nickname" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "search_count" integer DEFAULT 0,
    "clan_data" "jsonb",
    "clan_updated_at" timestamp with time zone,
    "weapon_mastery_data" "jsonb",
    "mastery_updated_at" timestamp with time zone,
    "ban_type" "text" DEFAULT 'None'::"text",
    "season_stats_data" "jsonb",
    "recent_match_ids" "jsonb",
    "last_season_id" "text",
    "seasons_list" "jsonb",
    "last_seen_at" timestamp with time zone
);


ALTER TABLE "public"."pubg_player_cache" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pubg_player_cache"."season_stats_data" IS '시즌별 랭크 및 일반전 통계 요약 데이터 (JSON)';



COMMENT ON COLUMN "public"."pubg_player_cache"."recent_match_ids" IS '플레이어의 최근 20경기 매치 ID 목록 (JSON Array)';



COMMENT ON COLUMN "public"."pubg_player_cache"."last_season_id" IS '최종 검색/업데이트된 시즌 ID';



COMMENT ON COLUMN "public"."pubg_player_cache"."seasons_list" IS '플레이어 시즌 목록 정보 캐시 (JSON)';



CREATE TABLE IF NOT EXISTS "public"."pubg_refresh_locks" (
    "lock_key" "text" NOT NULL,
    "claimed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pubg_refresh_locks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pubg_response_cache" (
    "cache_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pubg_response_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" bigint NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" bigint NOT NULL,
    "reason" "text" NOT NULL,
    "detail" "text",
    "reporter_ip" "text",
    "reporter_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text",
    "admin_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'resolved'::"text", 'dismissed'::"text"]))),
    CONSTRAINT "reports_target_type_check" CHECK (("target_type" = ANY (ARRAY['post'::"text", 'comment'::"text"])))
);


ALTER TABLE "public"."reports" OWNER TO "postgres";


ALTER TABLE "public"."reports" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."reports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."squad_ai_coaching_cache" (
    "group_key" "text" NOT NULL,
    "match_ids_hash" character varying(64) NOT NULL,
    "coaching_style" character varying(50) NOT NULL,
    "ai_result" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "player_id" "text",
    "platform" "text" DEFAULT 'steam'::"text",
    "prompt_version" "text" DEFAULT 'legacy'::"text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."squad_ai_coaching_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "text" NOT NULL,
    "last_url" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sync_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_settings" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."system_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemetry_map_cache_entries" (
    "id" bigint NOT NULL,
    "match_id" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "player_id" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "telemetry_version" numeric NOT NULL,
    "storage_path" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "lease_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lease_token" "uuid",
    CONSTRAINT "telemetry_map_cache_entries_mode_check" CHECK (("mode" = ANY (ARRAY['lite'::"text", 'full'::"text"]))),
    CONSTRAINT "telemetry_map_cache_entries_platform_check" CHECK (("platform" = ANY (ARRAY['steam'::"text", 'kakao'::"text"]))),
    CONSTRAINT "telemetry_map_cache_entries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'ready'::"text"])))
);


ALTER TABLE "public"."telemetry_map_cache_entries" OWNER TO "postgres";


ALTER TABLE "public"."telemetry_map_cache_entries" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."telemetry_map_cache_entries_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."throwables" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "weight" numeric,
    "effect" "text",
    "patch_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "can_be_in_backpack" boolean DEFAULT true,
    "icon_url" "text",
    "patch_version" "text",
    "patch_applied_at" timestamp with time zone,
    "removed_at" timestamp with time zone,
    "removed_patch_version" "text"
);


ALTER TABLE "public"."throwables" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_knowledge_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "vault_name" "text" NOT NULL,
    "file_path" "text" NOT NULL,
    "title" "text" NOT NULL,
    "source" "text" DEFAULT 'obsidian'::"text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "content_hash" "text" NOT NULL,
    "frontmatter" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sync_status" "text" DEFAULT 'SYNCED'::"text" NOT NULL,
    "modified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_knowledge_notes_source_check" CHECK (("source" = ANY (ARRAY['obsidian'::"text", 'app'::"text"]))),
    CONSTRAINT "user_knowledge_notes_sync_status_check" CHECK (("sync_status" = ANY (ARRAY['SYNCED'::"text", 'FAILED'::"text"])))
);


ALTER TABLE "public"."user_knowledge_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_memory_facts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "memory_type" "text" NOT NULL,
    "content" "text" NOT NULL,
    "symbol" "text",
    "confidence" numeric DEFAULT 0.5 NOT NULL,
    "evidence_count" integer DEFAULT 1 NOT NULL,
    "source" "text" DEFAULT 'behavioral_event'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_memory_facts_confidence_check" CHECK ((("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric))),
    CONSTRAINT "user_memory_facts_evidence_count_check" CHECK (("evidence_count" >= 1)),
    CONSTRAINT "user_memory_facts_type_check" CHECK (("memory_type" = ANY (ARRAY['favorite_symbol'::"text", 'repeated_mistake'::"text", 'risk_preference'::"text", 'answer_preference'::"text", 'investment_principle'::"text"])))
);


ALTER TABLE "public"."user_memory_facts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vehicles" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "trunk_capacity" integer DEFAULT 0 NOT NULL,
    "type" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "patch_notes" "text",
    "patch_version" "text",
    "patch_applied_at" timestamp with time zone,
    "removed_at" timestamp with time zone,
    "removed_patch_version" "text"
);


ALTER TABLE "public"."vehicles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weapon_patch_apply_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "proposal_id" "uuid" NOT NULL,
    "change_id" "uuid" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "column_name" "text" NOT NULL,
    "before_row" "jsonb" NOT NULL,
    "after_row" "jsonb" NOT NULL,
    "applied_by" "uuid",
    "applied_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reverted_by" "uuid",
    "reverted_at" timestamp with time zone,
    "patch_version" "text",
    "previous_patch_version" "text",
    "previous_patch_applied_at" timestamp with time zone
);


ALTER TABLE "public"."weapon_patch_apply_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weapon_patch_proposal_changes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "proposal_id" "uuid" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "operation" "text" DEFAULT 'update'::"text" NOT NULL,
    "column_name" "text" NOT NULL,
    "old_value" "jsonb",
    "new_value" "jsonb",
    "evidence_quote" "text" NOT NULL,
    "evidence_found" boolean DEFAULT false NOT NULL,
    "confidence" numeric(3,2),
    "validation_state" "text" DEFAULT 'invalid'::"text" NOT NULL,
    "validation_reason" "text",
    "decision" "text" DEFAULT 'pending'::"text" NOT NULL,
    "decided_at" timestamp with time zone,
    "decided_by" "uuid",
    CONSTRAINT "weapon_patch_proposal_changes_accept_requires_ok" CHECK ((("decision" <> 'accepted'::"text") OR ("validation_state" = 'ok'::"text"))),
    CONSTRAINT "weapon_patch_proposal_changes_decision_check" CHECK (("decision" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text"]))),
    CONSTRAINT "weapon_patch_proposal_changes_new_value_check" CHECK (((("operation" = 'remove'::"text") AND ("new_value" IS NULL)) OR (("operation" = 'update'::"text") AND ("new_value" IS NOT NULL)))),
    CONSTRAINT "weapon_patch_proposal_changes_operation_check" CHECK (("operation" = ANY (ARRAY['update'::"text", 'remove'::"text"]))),
    CONSTRAINT "weapon_patch_proposal_changes_remove_column_check" CHECK ((("operation" <> 'remove'::"text") OR ("column_name" = 'removed_at'::"text"))),
    CONSTRAINT "weapon_patch_proposal_changes_target_table_check" CHECK (("target_table" = ANY (ARRAY['weapons'::"text", 'attachments'::"text", 'ammo'::"text", 'consumables'::"text", 'throwables'::"text", 'vehicles'::"text"]))),
    CONSTRAINT "weapon_patch_proposal_changes_validation_state_check" CHECK (("validation_state" = ANY (ARRAY['ok'::"text", 'stale'::"text", 'invalid'::"text"])))
);


ALTER TABLE "public"."weapon_patch_proposal_changes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weapon_patch_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_post_id" bigint,
    "source_url" "text" NOT NULL,
    "source_text_hash" "text" NOT NULL,
    "patch_label" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "model_name" "text",
    "raw_ai_response" "jsonb",
    "validation_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    CONSTRAINT "weapon_patch_proposals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'partially_applied'::"text", 'applied'::"text", 'rejected'::"text", 'superseded'::"text"])))
);


ALTER TABLE "public"."weapon_patch_proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weapons" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "ammo" "text",
    "availability" "text",
    "spawn_maps" "text",
    "damage" integer,
    "bullet_speed" integer,
    "patch_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "can_be_in_backpack" boolean DEFAULT true,
    "weight" numeric DEFAULT 0,
    "icon_url" "text",
    "category" "text",
    "patch_version" "text",
    "patch_applied_at" timestamp with time zone,
    "removed_at" timestamp with time zone,
    "removed_patch_version" "text"
);


ALTER TABLE "public"."weapons" OWNER TO "postgres";


ALTER TABLE ONLY "public"."global_benchmarks" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."global_benchmarks_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."hotdrop_heatmap" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."hotdrop_heatmap_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."match_stats_raw" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."match_stats_raw_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agent_approvals"
    ADD CONSTRAINT "agent_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_memories"
    ADD CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_runs"
    ADD CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_steps"
    ADD CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage_logs"
    ADD CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ammo"
    ADD CONSTRAINT "ammo_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."analytics_event_rate_limits"
    ADD CONSTRAINT "analytics_event_rate_limits_pkey" PRIMARY KEY ("session_id");



ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attachments"
    ADD CONSTRAINT "attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."board_image_objects"
    ADD CONSTRAINT "board_image_objects_bucket_id_storage_key_key" UNIQUE ("bucket_id", "storage_key");



ALTER TABLE ONLY "public"."board_image_objects"
    ADD CONSTRAINT "board_image_objects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."board_image_reservation_rate_limits"
    ADD CONSTRAINT "board_image_reservation_rate_limits_pkey" PRIMARY KEY ("owner_user_id");



ALTER TABLE ONLY "public"."board_post_image_refs"
    ADD CONSTRAINT "board_post_image_refs_pkey" PRIMARY KEY ("post_id", "image_id", "usage");



ALTER TABLE ONLY "public"."board_write_rate_limits"
    ADD CONSTRAINT "board_write_rate_limits_pkey" PRIMARY KEY ("scope", "actor_hash");



ALTER TABLE ONLY "public"."bonus_items"
    ADD CONSTRAINT "bonus_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consumables"
    ADD CONSTRAINT "consumables_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."craftable_items"
    ADD CONSTRAINT "craftable_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crate_item_assets"
    ADD CONSTRAINT "crate_item_assets_asset_key_key" UNIQUE ("asset_key");



ALTER TABLE ONLY "public"."crate_item_assets"
    ADD CONSTRAINT "crate_item_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crate_item_relations"
    ADD CONSTRAINT "crate_item_relations_crate_template_id_asset_id_drop_type_key" UNIQUE ("crate_template_id", "asset_id", "drop_type");



ALTER TABLE ONLY "public"."crate_item_relations"
    ADD CONSTRAINT "crate_item_relations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crate_items"
    ADD CONSTRAINT "crate_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crate_templates"
    ADD CONSTRAINT "crate_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discord_room_rate_limits"
    ADD CONSTRAINT "discord_room_rate_limits_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."global_benchmarks"
    ADD CONSTRAINT "global_benchmarks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hotdrop_heatmap"
    ADD CONSTRAINT "hotdrop_heatmap_map_name_season_grid_x_grid_y_key" UNIQUE ("map_name", "season", "grid_x", "grid_y");



ALTER TABLE ONLY "public"."hotdrop_heatmap"
    ADD CONSTRAINT "hotdrop_heatmap_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ip_blacklist"
    ADD CONSTRAINT "ip_blacklist_ip_address_key" UNIQUE ("ip_address");



ALTER TABLE ONLY "public"."ip_blacklist"
    ADD CONSTRAINT "ip_blacklist_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."map_markers"
    ADD CONSTRAINT "map_markers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."map_settings"
    ADD CONSTRAINT "map_settings_pkey" PRIMARY KEY ("map_id");



ALTER TABLE ONLY "public"."match_ai_coaching_cache"
    ADD CONSTRAINT "match_ai_coaching_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."match_master_telemetry"
    ADD CONSTRAINT "match_master_telemetry_pkey" PRIMARY KEY ("match_id");



ALTER TABLE ONLY "public"."match_stats_raw"
    ADD CONSTRAINT "match_stats_raw_pkey" PRIMARY KEY ("match_id", "platform", "player_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."overwolf_session_events"
    ADD CONSTRAINT "overwolf_session_events_pkey" PRIMARY KEY ("session_id");



ALTER TABLE ONLY "public"."overwolf_session_quota"
    ADD CONSTRAINT "overwolf_session_quota_pkey" PRIMARY KEY ("quota_key");



ALTER TABLE ONLY "public"."pending_markers"
    ADD CONSTRAINT "pending_markers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."player_ai_summary_cache"
    ADD CONSTRAINT "player_ai_summary_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_post_id_user_id_key" UNIQUE ("post_id", "user_id");



ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prime_parcel_items"
    ADD CONSTRAINT "prime_parcel_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processed_match_telemetry"
    ADD CONSTRAINT "processed_match_telemetry_pkey" PRIMARY KEY ("match_id", "platform", "player_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_nickname_key" UNIQUE ("nickname");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pubg_api_alert_deliveries"
    ADD CONSTRAINT "pubg_api_alert_deliveries_pkey" PRIMARY KEY ("alert_key", "window_started_at");



ALTER TABLE ONLY "public"."pubg_api_errors"
    ADD CONSTRAINT "pubg_api_errors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pubg_api_status"
    ADD CONSTRAINT "pubg_api_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pubg_player_cache"
    ADD CONSTRAINT "pubg_player_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pubg_refresh_locks"
    ADD CONSTRAINT "pubg_refresh_locks_pkey" PRIMARY KEY ("lock_key");



ALTER TABLE ONLY "public"."pubg_response_cache"
    ADD CONSTRAINT "pubg_response_cache_pkey" PRIMARY KEY ("cache_key");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."squad_ai_coaching_cache"
    ADD CONSTRAINT "squad_ai_coaching_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_history"
    ADD CONSTRAINT "sync_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_history"
    ADD CONSTRAINT "sync_history_type_key" UNIQUE ("type");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."telemetry_map_cache_entries"
    ADD CONSTRAINT "telemetry_map_cache_entries_match_id_platform_player_id_mod_key" UNIQUE ("match_id", "platform", "player_id", "mode", "telemetry_version");



ALTER TABLE ONLY "public"."telemetry_map_cache_entries"
    ADD CONSTRAINT "telemetry_map_cache_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemetry_map_cache_entries"
    ADD CONSTRAINT "telemetry_map_cache_entries_storage_path_key" UNIQUE ("storage_path");



ALTER TABLE ONLY "public"."throwables"
    ADD CONSTRAINT "throwables_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_knowledge_notes"
    ADD CONSTRAINT "user_knowledge_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_knowledge_notes"
    ADD CONSTRAINT "user_knowledge_notes_unique_file" UNIQUE ("user_id", "vault_name", "file_path");



ALTER TABLE ONLY "public"."user_memory_facts"
    ADD CONSTRAINT "user_memory_facts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weapon_patch_apply_log"
    ADD CONSTRAINT "weapon_patch_apply_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weapon_patch_proposal_changes"
    ADD CONSTRAINT "weapon_patch_proposal_changes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weapon_patch_proposals"
    ADD CONSTRAINT "weapon_patch_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weapons"
    ADD CONSTRAINT "weapons_pkey" PRIMARY KEY ("id");



CREATE INDEX "analytics_events_created_at_idx" ON "public"."analytics_events" USING "btree" ("created_at" DESC);



CREATE INDEX "analytics_events_event_date_name_idx" ON "public"."analytics_events" USING "btree" ("event_date", "event_name");



CREATE INDEX "analytics_events_event_date_page_path_idx" ON "public"."analytics_events" USING "btree" ("event_date", "page_path");



CREATE INDEX "analytics_events_internal_created_at_idx" ON "public"."analytics_events" USING "btree" ("is_internal", "created_at" DESC);



CREATE INDEX "analytics_events_params_gin_idx" ON "public"."analytics_events" USING "gin" ("params");



CREATE INDEX "analytics_events_session_created_at_idx" ON "public"."analytics_events" USING "btree" ("session_id", "created_at" DESC);



CREATE INDEX "analytics_events_source_host_created_at_idx" ON "public"."analytics_events" USING "btree" ("source_host", "created_at" DESC) WHERE ("source_host" IS NOT NULL);



CREATE INDEX "analytics_events_user_created_at_idx" ON "public"."analytics_events" USING "btree" ("user_id", "created_at" DESC) WHERE ("user_id" IS NOT NULL);



CREATE INDEX "board_image_objects_claim_idx" ON "public"."board_image_objects" USING "btree" ("status", "delete_after", "delete_lease_until", "expires_at", "id") WHERE ("status" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'delete_pending'::"text", 'deleting'::"text"]));



CREATE INDEX "board_post_image_refs_image_id_idx" ON "public"."board_post_image_refs" USING "btree" ("image_id");



CREATE INDEX "board_write_rate_limits_cleanup_idx" ON "public"."board_write_rate_limits" USING "btree" ("window_started_at", "scope", "actor_hash");



CREATE INDEX "bonus_items_asset_key_idx" ON "public"."bonus_items" USING "btree" ("asset_key");



CREATE INDEX "crate_item_assets_normalized_name_idx" ON "public"."crate_item_assets" USING "btree" ("normalized_name");



CREATE INDEX "crate_item_relations_asset_id_idx" ON "public"."crate_item_relations" USING "btree" ("asset_id");



CREATE INDEX "crate_item_relations_drop_type_idx" ON "public"."crate_item_relations" USING "btree" ("drop_type");



CREATE INDEX "crate_item_relations_template_id_idx" ON "public"."crate_item_relations" USING "btree" ("crate_template_id");



CREATE INDEX "crate_items_asset_key_idx" ON "public"."crate_items" USING "btree" ("asset_key");



CREATE INDEX "crate_templates_asset_key_idx" ON "public"."crate_templates" USING "btree" ("asset_key");



CREATE INDEX "discord_room_rate_limits_window_idx" ON "public"."discord_room_rate_limits" USING "btree" ("window_started_at" DESC);



CREATE UNIQUE INDEX "global_benchmarks_match_platform_player_key" ON "public"."global_benchmarks" USING "btree" ("match_id", "platform", "player_id");



CREATE INDEX "idx_agent_approvals_status_created" ON "public"."agent_approvals" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_agent_memories_category_updated" ON "public"."agent_memories" USING "btree" ("category", "updated_at" DESC);



CREATE INDEX "idx_agent_runs_user_started" ON "public"."agent_runs" USING "btree" ("user_id", "started_at" DESC);



CREATE INDEX "idx_agent_steps_run_started" ON "public"."agent_steps" USING "btree" ("run_id", "started_at");



CREATE INDEX "idx_benchmarks_damage" ON "public"."global_benchmarks" USING "btree" ("damage");



CREATE INDEX "idx_benchmarks_game_mode" ON "public"."global_benchmarks" USING "btree" ("game_mode");



CREATE INDEX "idx_benchmarks_win_place" ON "public"."global_benchmarks" USING "btree" ("win_place");



CREATE INDEX "idx_global_benchmarks_filter_version" ON "public"."global_benchmarks" USING "btree" ("filter_version");



CREATE INDEX "idx_global_benchmarks_platform_player_created" ON "public"."global_benchmarks" USING "btree" ("platform", "player_id", "created_at" DESC);



CREATE INDEX "idx_hotdrop_map_season" ON "public"."hotdrop_heatmap" USING "btree" ("map_name", "season");



CREATE INDEX "idx_match_ai_coaching_cache_created_at" ON "public"."match_ai_coaching_cache" USING "btree" ("created_at");



CREATE UNIQUE INDEX "idx_match_ai_coaching_cache_identity_v2" ON "public"."match_ai_coaching_cache" USING "btree" ("match_id", "platform", "player_id", "coaching_style", "prompt_version");



CREATE INDEX "idx_match_ai_coaching_cache_match_id" ON "public"."match_ai_coaching_cache" USING "btree" ("match_id");



CREATE INDEX "idx_match_master_id" ON "public"."match_master_telemetry" USING "btree" ("match_id");



CREATE INDEX "idx_match_stats_raw_analysis_sample_created" ON "public"."match_stats_raw" USING "btree" ("created_at" DESC) WHERE ("is_analysis_sample" = true);



CREATE INDEX "idx_match_stats_raw_compaction_candidates" ON "public"."match_stats_raw" USING "btree" ("created_at", "match_id", "platform", "player_id") WHERE (("is_analysis_sample" = false) AND ("win_place" <> 1));



CREATE INDEX "idx_match_stats_raw_match_id" ON "public"."match_stats_raw" USING "btree" ("match_id");



CREATE INDEX "idx_match_stats_raw_winner_damage" ON "public"."match_stats_raw" USING "btree" ("damage" DESC) WHERE ("win_place" = 1);



CREATE INDEX "idx_player_ai_summary_cache_created_at" ON "public"."player_ai_summary_cache" USING "btree" ("created_at");



CREATE UNIQUE INDEX "idx_player_ai_summary_cache_identity_v2" ON "public"."player_ai_summary_cache" USING "btree" ("player_id", "platform", "match_ids_hash", "prompt_version");



CREATE INDEX "idx_player_ai_summary_cache_player_id" ON "public"."player_ai_summary_cache" USING "btree" ("player_id");



CREATE INDEX "idx_processed_match_telemetry_created_at" ON "public"."processed_match_telemetry" USING "btree" ("created_at");



CREATE INDEX "idx_processed_match_telemetry_platform_player_updated" ON "public"."processed_match_telemetry" USING "btree" ("platform", "player_id", "updated_at" DESC);



CREATE INDEX "idx_pubg_player_cache_lower_platform" ON "public"."pubg_player_cache" USING "btree" ("lower_nickname", "platform");



CREATE INDEX "idx_squad_ai_coaching_cache_created_at" ON "public"."squad_ai_coaching_cache" USING "btree" ("created_at");



CREATE INDEX "idx_squad_ai_coaching_cache_group_key" ON "public"."squad_ai_coaching_cache" USING "btree" ("group_key");



CREATE UNIQUE INDEX "idx_squad_ai_coaching_cache_identity_v2" ON "public"."squad_ai_coaching_cache" USING "btree" ("player_id", "platform", "group_key", "match_ids_hash", "coaching_style", "prompt_version");



CREATE INDEX "idx_telemetry_player_match" ON "public"."processed_match_telemetry" USING "btree" ("player_id", "match_id");



CREATE INDEX "idx_user_knowledge_notes_user_hash" ON "public"."user_knowledge_notes" USING "btree" ("user_id", "content_hash");



CREATE INDEX "idx_user_knowledge_notes_user_updated" ON "public"."user_knowledge_notes" USING "btree" ("user_id", "updated_at" DESC);



CREATE INDEX "idx_user_memory_facts_user_active_type" ON "public"."user_memory_facts" USING "btree" ("user_id", "is_active", "memory_type");



CREATE INDEX "overwolf_session_events_created_at_idx" ON "public"."overwolf_session_events" USING "btree" ("created_at" DESC);



CREATE INDEX "overwolf_session_events_match_id_idx" ON "public"."overwolf_session_events" USING "btree" ("match_id") WHERE ("match_id" IS NOT NULL);



CREATE INDEX "overwolf_session_events_official_match_idx" ON "public"."overwolf_session_events" USING "btree" ("player_id", "created_at" DESC) WHERE (("match_id" IS NOT NULL) AND ("player_id" IS NOT NULL));



CREATE INDEX "overwolf_session_events_player_idx" ON "public"."overwolf_session_events" USING "btree" ("platform", "player_id") WHERE ("player_id" IS NOT NULL);



CREATE INDEX "prime_parcel_items_asset_key_idx" ON "public"."prime_parcel_items" USING "btree" ("asset_key");



CREATE INDEX "pubg_api_errors_created_at_idx" ON "public"."pubg_api_errors" USING "btree" ("created_at" DESC);



CREATE INDEX "pubg_api_errors_created_at_status_idx" ON "public"."pubg_api_errors" USING "btree" ("created_at" DESC, "status");



CREATE INDEX "pubg_api_errors_diagnosis_idx" ON "public"."pubg_api_errors" USING "btree" ("error_code", "failure_stage", "created_at" DESC);



CREATE INDEX "pubg_player_cache_nickname_trgm_idx" ON "public"."pubg_player_cache" USING "gin" ("nickname" "public"."gin_trgm_ops");



CREATE INDEX "pubg_player_cache_retention_idx" ON "public"."pubg_player_cache" USING "btree" ("updated_at") WHERE (("search_count" = 0) AND ("season_stats_data" IS NULL));



CREATE INDEX "pubg_player_cache_updated_at_idx" ON "public"."pubg_player_cache" USING "btree" ("updated_at" DESC);



CREATE INDEX "pubg_response_cache_expires_at_idx" ON "public"."pubg_response_cache" USING "btree" ("expires_at");



CREATE INDEX "telemetry_map_cache_entries_lease_idx" ON "public"."telemetry_map_cache_entries" USING "btree" ("status", "lease_expires_at");



CREATE INDEX "telemetry_map_cache_entries_match_id_idx" ON "public"."telemetry_map_cache_entries" USING "btree" ("match_id");



CREATE INDEX "telemetry_map_cache_entries_updated_at_idx" ON "public"."telemetry_map_cache_entries" USING "btree" ("updated_at");



CREATE UNIQUE INDEX "unique_post_published_title" ON "public"."posts" USING "btree" ("title") WHERE ("status" = 'published'::"public"."post_status");



CREATE INDEX "weapon_patch_apply_log_proposal_idx" ON "public"."weapon_patch_apply_log" USING "btree" ("proposal_id", "applied_at" DESC);



CREATE INDEX "weapon_patch_proposal_changes_proposal_idx" ON "public"."weapon_patch_proposal_changes" USING "btree" ("proposal_id");



CREATE UNIQUE INDEX "weapon_patch_proposal_changes_unique_target" ON "public"."weapon_patch_proposal_changes" USING "btree" ("proposal_id", "target_table", "target_id", "column_name");



CREATE UNIQUE INDEX "weapon_patch_proposals_source_text_hash_key" ON "public"."weapon_patch_proposals" USING "btree" ("source_text_hash");



CREATE INDEX "weapon_patch_proposals_status_created_at_idx" ON "public"."weapon_patch_proposals" USING "btree" ("status", "created_at" DESC);



CREATE OR REPLACE TRIGGER "prevent_profile_role_escalation" BEFORE UPDATE OF "role" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_profile_role_escalation"();



CREATE OR REPLACE TRIGGER "serialize_board_post_image_delete" BEFORE DELETE ON "public"."posts" FOR EACH STATEMENT EXECUTE FUNCTION "public"."serialize_board_post_image_delete"();



CREATE OR REPLACE TRIGGER "telemetry_cache_match_lock" BEFORE INSERT OR DELETE OR UPDATE ON "public"."telemetry_map_cache_entries" FOR EACH ROW EXECUTE FUNCTION "public"."lock_telemetry_cache_match"();



CREATE OR REPLACE TRIGGER "transition_board_image_orphans_before_post_delete" BEFORE DELETE ON "public"."posts" FOR EACH ROW EXECUTE FUNCTION "public"."transition_board_image_orphans_before_post_delete"();



ALTER TABLE ONLY "public"."agent_approvals"
    ADD CONSTRAINT "agent_approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_approvals"
    ADD CONSTRAINT "agent_approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_approvals"
    ADD CONSTRAINT "agent_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_approvals"
    ADD CONSTRAINT "agent_approvals_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."agent_steps"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_runs"
    ADD CONSTRAINT "agent_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_steps"
    ADD CONSTRAINT "agent_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_usage_logs"
    ADD CONSTRAINT "ai_usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."board_image_objects"
    ADD CONSTRAINT "board_image_objects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."board_post_image_refs"
    ADD CONSTRAINT "board_post_image_refs_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "public"."board_image_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."board_post_image_refs"
    ADD CONSTRAINT "board_post_image_refs_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bonus_items"
    ADD CONSTRAINT "bonus_items_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."crate_item_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bonus_items"
    ADD CONSTRAINT "bonus_items_crate_template_id_fkey" FOREIGN KEY ("crate_template_id") REFERENCES "public"."crate_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."craftable_items"
    ADD CONSTRAINT "craftable_items_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."crate_item_assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crate_item_relations"
    ADD CONSTRAINT "crate_item_relations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."crate_item_assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crate_item_relations"
    ADD CONSTRAINT "crate_item_relations_crate_template_id_fkey" FOREIGN KEY ("crate_template_id") REFERENCES "public"."crate_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crate_items"
    ADD CONSTRAINT "crate_items_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."crate_item_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."crate_items"
    ADD CONSTRAINT "crate_items_crate_template_id_fkey" FOREIGN KEY ("crate_template_id") REFERENCES "public"."crate_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crate_templates"
    ADD CONSTRAINT "crate_templates_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."crate_item_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."discord_room_rate_limits"
    ADD CONSTRAINT "discord_room_rate_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prime_parcel_items"
    ADD CONSTRAINT "prime_parcel_items_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."crate_item_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prime_parcel_items"
    ADD CONSTRAINT "prime_parcel_items_crate_template_id_fkey" FOREIGN KEY ("crate_template_id") REFERENCES "public"."crate_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_knowledge_notes"
    ADD CONSTRAINT "user_knowledge_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_memory_facts"
    ADD CONSTRAINT "user_memory_facts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weapon_patch_apply_log"
    ADD CONSTRAINT "weapon_patch_apply_log_applied_by_fkey" FOREIGN KEY ("applied_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."weapon_patch_apply_log"
    ADD CONSTRAINT "weapon_patch_apply_log_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "public"."weapon_patch_proposal_changes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weapon_patch_apply_log"
    ADD CONSTRAINT "weapon_patch_apply_log_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."weapon_patch_proposals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weapon_patch_apply_log"
    ADD CONSTRAINT "weapon_patch_apply_log_reverted_by_fkey" FOREIGN KEY ("reverted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."weapon_patch_proposal_changes"
    ADD CONSTRAINT "weapon_patch_proposal_changes_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."weapon_patch_proposal_changes"
    ADD CONSTRAINT "weapon_patch_proposal_changes_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."weapon_patch_proposals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weapon_patch_proposals"
    ADD CONSTRAINT "weapon_patch_proposals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."weapon_patch_proposals"
    ADD CONSTRAINT "weapon_patch_proposals_source_post_id_fkey" FOREIGN KEY ("source_post_id") REFERENCES "public"."posts"("id") ON DELETE SET NULL;



CREATE POLICY "Allow admin manage blacklist" ON "public"."ip_blacklist" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admin manage reports" ON "public"."reports" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admin to manage" ON "public"."categories" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admin to manage craftable_items" ON "public"."craftable_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admin to manage map settings" ON "public"."map_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins to manage ammo" ON "public"."ammo" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins to manage attachments" ON "public"."attachments" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins to manage consumables" ON "public"."consumables" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins to manage throwables" ON "public"."throwables" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins to manage vehicles" ON "public"."vehicles" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins to manage weapons" ON "public"."weapons" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow authenticated insert" ON "public"."pending_markers" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Allow authenticated update" ON "public"."pending_markers" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Allow owners and admins to delete posts" ON "public"."posts" FOR DELETE USING ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))));



CREATE POLICY "Allow owners and admins to select posts" ON "public"."posts" FOR SELECT USING ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))));



CREATE POLICY "Allow public insert reports" ON "public"."reports" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow public read" ON "public"."categories" FOR SELECT USING (true);



CREATE POLICY "Allow public read" ON "public"."match_stats_raw" FOR SELECT USING (true);



CREATE POLICY "Allow public read access on bonus_items" ON "public"."bonus_items" FOR SELECT USING (true);



CREATE POLICY "Allow public read access on crate_item_assets" ON "public"."crate_item_assets" FOR SELECT USING (true);



CREATE POLICY "Allow public read access on crate_item_relations" ON "public"."crate_item_relations" FOR SELECT USING (true);



CREATE POLICY "Allow public read access on crate_items" ON "public"."crate_items" FOR SELECT USING (true);



CREATE POLICY "Allow public read access on crate_templates" ON "public"."crate_templates" FOR SELECT USING (true);



CREATE POLICY "Allow public read access on prime_parcel_items" ON "public"."prime_parcel_items" FOR SELECT USING (true);



CREATE POLICY "Allow public read access to craftable_items" ON "public"."craftable_items" FOR SELECT USING (true);



CREATE POLICY "Allow public read published posts" ON "public"."posts" FOR SELECT USING (("status" = 'published'::"public"."post_status"));



CREATE POLICY "Allow public read system_settings" ON "public"."system_settings" FOR SELECT USING (true);



CREATE POLICY "Allow public read-only access" ON "public"."map_settings" FOR SELECT USING (true);



CREATE POLICY "Allow public read-only access" ON "public"."processed_match_telemetry" FOR SELECT USING (true);



CREATE POLICY "Allow public select for ammo" ON "public"."ammo" FOR SELECT USING (true);



CREATE POLICY "Allow public select for attachments" ON "public"."attachments" FOR SELECT USING (true);



CREATE POLICY "Allow public select for consumables" ON "public"."consumables" FOR SELECT USING (true);



CREATE POLICY "Allow public select for throwables" ON "public"."throwables" FOR SELECT USING (true);



CREATE POLICY "Allow public select for vehicles" ON "public"."vehicles" FOR SELECT USING (true);



CREATE POLICY "Allow public select for weapons" ON "public"."weapons" FOR SELECT USING (true);



CREATE POLICY "Allow service_role write system_settings" ON "public"."system_settings" USING (false) WITH CHECK (false);



CREATE POLICY "Enable all access for admins" ON "public"."global_benchmarks" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Enable all access for admins" ON "public"."match_master_telemetry" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Enable all access for service role only" ON "public"."sync_history" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Enable read access for all users" ON "public"."global_benchmarks" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."match_master_telemetry" FOR SELECT USING (true);



CREATE POLICY "Public Read" ON "public"."pubg_player_cache" FOR SELECT USING (true);



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."agent_approvals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_memories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_steps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ammo" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."analytics_event_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."analytics_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."board_image_objects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."board_image_reservation_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."board_post_image_refs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."board_write_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bonus_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consumables" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."craftable_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crate_item_assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crate_item_relations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crate_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crate_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discord_room_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."global_benchmarks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hotdrop_heatmap" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hotdrop_heatmap_select_policy" ON "public"."hotdrop_heatmap" FOR SELECT USING (true);



ALTER TABLE "public"."ip_blacklist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."map_markers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."map_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."match_ai_coaching_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."match_master_telemetry" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."match_stats_raw" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "match_stats_raw_service_role_write" ON "public"."match_stats_raw" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_delete_own" ON "public"."notifications" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "notifications_select_own" ON "public"."notifications" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "notifications_update_own" ON "public"."notifications" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."overwolf_session_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."overwolf_session_quota" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_markers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."player_ai_summary_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."post_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prime_parcel_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."processed_match_telemetry" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "processed_match_telemetry_service_role_write" ON "public"."processed_match_telemetry" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pubg_api_alert_deliveries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pubg_api_errors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pubg_api_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pubg_player_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pubg_player_cache_service_role_write" ON "public"."pubg_player_cache" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."pubg_refresh_locks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pubg_response_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."squad_ai_coaching_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sync_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."telemetry_map_cache_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."throwables" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_knowledge_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_knowledge_notes_owner_insert" ON "public"."user_knowledge_notes" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "user_knowledge_notes_owner_select" ON "public"."user_knowledge_notes" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "user_knowledge_notes_owner_update" ON "public"."user_knowledge_notes" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."user_memory_facts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_memory_facts_owner_insert" ON "public"."user_memory_facts" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "user_memory_facts_owner_select" ON "public"."user_memory_facts" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "user_memory_facts_owner_update" ON "public"."user_memory_facts" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."vehicles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weapon_patch_apply_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weapon_patch_proposal_changes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weapon_patch_proposals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weapons" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "관리자는 모든 댓글을 삭제할 수 있음" ON "public"."comments" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "관리자만 마커 삭제 가능" ON "public"."map_markers" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "관리자만 마커 수정 가능" ON "public"."map_markers" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "관리자만 마커 추가 가능" ON "public"."map_markers" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "누구나 댓글 조회 가능" ON "public"."comments" FOR SELECT USING (true);



CREATE POLICY "누구나 제보 구역 조회 가능" ON "public"."pending_markers" FOR SELECT USING (true);



CREATE POLICY "누구나 프로필 조회 가능" ON "public"."profiles" FOR SELECT USING (true);



CREATE POLICY "마커 조회는 누구나 가능" ON "public"."map_markers" FOR SELECT USING (true);



CREATE POLICY "본인 ID로만 추천 가능" ON "public"."post_likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "본인 댓글만 삭제 가능" ON "public"."comments" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "본인 알림만 삭제 가능 (DELETE)" ON "public"."notifications" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "본인 알림만 조작 가능 (UPDATE)" ON "public"."notifications" FOR UPDATE USING (("auth"."uid"() = "user_id"));











GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."apply_weapon_patch_proposal"("p_proposal_id" "uuid", "p_actor" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_weapon_patch_proposal"("p_proposal_id" "uuid", "p_actor" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_role_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_role_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_role_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_board_image_deletions"("p_limit" integer, "p_now" timestamp with time zone, "p_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_board_image_deletions"("p_limit" integer, "p_now" timestamp with time zone, "p_lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_board_image_deletions_for_owner"("p_owner_user_id" "uuid", "p_image_ids" "uuid"[], "p_now" timestamp with time zone, "p_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_board_image_deletions_for_owner"("p_owner_user_id" "uuid", "p_image_ids" "uuid"[], "p_now" timestamp with time zone, "p_lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_pending_marker_notification"("p_marker_id" "uuid", "p_direction" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_pending_marker_notification"("p_marker_id" "uuid", "p_direction" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_pubg_force_refresh"("p_lock_key" "text", "p_cooldown_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_pubg_force_refresh"("p_lock_key" "text", "p_cooldown_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_storage_path" "text", "p_lease_expires_at" timestamp with time zone, "p_lease_token" "uuid", "p_updated_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_storage_path" "text", "p_lease_expires_at" timestamp with time zone, "p_lease_token" "uuid", "p_updated_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_analytics_event_rate_limits"("p_retention_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_analytics_event_rate_limits"("p_retention_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_analytics_events"("p_retention_days" integer, "p_batch_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_analytics_events"("p_retention_days" integer, "p_batch_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_board_write_rate_limits"("p_cutoff" timestamp with time zone, "p_max_rows" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_board_write_rate_limits"("p_cutoff" timestamp with time zone, "p_max_rows" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_discord_room_rate_limits"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_discord_room_rate_limits"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_expired_telemetry_matches"("p_match_ids" "text"[], "p_cutoff" timestamp with time zone, "p_target_version" numeric, "p_now" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_expired_telemetry_matches"("p_match_ids" "text"[], "p_cutoff" timestamp with time zone, "p_target_version" numeric, "p_now" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_overwolf_session_events"("p_retention_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_overwolf_session_events"("p_retention_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_pubg_response_cache"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_pubg_response_cache"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."compact_match_stats_raw"("p_apply" boolean, "p_batch_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."compact_match_stats_raw"("p_apply" boolean, "p_batch_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."compact_pubg_player_cache"("p_retention_days" integer, "p_apply" boolean, "p_batch_limit" integer, "p_keep_recent" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."compact_pubg_player_cache"("p_retention_days" integer, "p_apply" boolean, "p_batch_limit" integer, "p_keep_recent" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_board_image_upload"("p_image_id" "uuid", "p_owner_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_board_image_upload"("p_image_id" "uuid", "p_owner_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_analytics_event_quota"("p_session_id" "text", "p_event_count" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_analytics_event_quota"("p_session_id" "text", "p_event_count" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_board_write_quota"("p_scope" "text", "p_actor_hash" "text", "p_window_seconds" integer, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_board_write_quota"("p_scope" "text", "p_actor_hash" "text", "p_window_seconds" integer, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_discord_room_quota"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_discord_room_quota"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_overwolf_session_quota"("p_quota_key" "text", "p_max_events" integer, "p_window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_overwolf_session_quota"("p_quota_key" "text", "p_max_events" integer, "p_window_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."count_pubg_api_errors_in_window"("p_window_started_at" timestamp with time zone, "p_min_status" integer, "p_route" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."count_pubg_api_errors_in_window"("p_window_started_at" timestamp with time zone, "p_min_status" integer, "p_route" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."crate_asset_key_from_image"("input_url" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."crate_asset_key_from_image"("input_url" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."crate_asset_key_from_image"("input_url" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_published_post_comment"("p_post_id" bigint, "p_user_id" "uuid", "p_author" "text", "p_content" "text", "p_parent_id" bigint, "p_password_hash" "text", "p_ip_address" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_published_post_comment"("p_post_id" bigint, "p_user_id" "uuid", "p_author" "text", "p_content" "text", "p_parent_id" bigint, "p_password_hash" "text", "p_ip_address" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_orphaned_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."delete_orphaned_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_orphaned_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_orphaned_stats_limited"("limit_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."delete_orphaned_stats_limited"("limit_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_orphaned_stats_limited"("limit_count" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."finalize_board_image_deletion"("p_image_id" "uuid", "p_lease_token" "uuid", "p_deleted" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_board_image_deletion"("p_image_id" "uuid", "p_lease_token" "uuid", "p_deleted" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."finalize_telemetry_cache_write"("p_match_id" "text", "p_map_name" "text", "p_game_mode" "text", "p_master_version" numeric, "p_storage_path" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_cache_version" numeric, "p_cache_updated_at" timestamp with time zone, "p_cache_lease_token" "uuid", "p_processed_player_id" "text", "p_processed_platform" "text", "p_processed_data" "jsonb", "p_processed_updated_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_telemetry_cache_write"("p_match_id" "text", "p_map_name" "text", "p_game_mode" "text", "p_master_version" numeric, "p_storage_path" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_cache_version" numeric, "p_cache_updated_at" timestamp with time zone, "p_cache_lease_token" "uuid", "p_processed_player_id" "text", "p_processed_platform" "text", "p_processed_data" "jsonb", "p_processed_updated_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_db_size"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_db_size"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_db_size"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_index_usage"("p_table_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_index_usage"("p_table_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_next_marker_id"("map_id_in" "text", "marker_type_in" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_next_marker_id"("map_id_in" "text", "marker_type_in" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_next_marker_id"("map_id_in" "text", "marker_type_in" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_next_marker_id"("map_id_in" "text", "marker_type_in" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_orphaned_match_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_orphaned_match_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_orphaned_match_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_overwolf_session"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_overwolf_session"("p_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_table_sizes"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_table_sizes"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_likes"("row_id" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_likes"("row_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_likes"("row_id" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_player_search_count"("player_id" "text", "player_nickname" "text", "player_platform" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_player_search_count"("player_id" "text", "player_nickname" "text", "player_platform" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_player_search_count"("player_id" "text", "player_nickname" "text", "player_platform" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_views"("row_id" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_views"("row_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_views"("row_id" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."inspect_board_image_deletion_candidates"("p_now" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."inspect_board_image_deletion_candidates"("p_now" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_overwolf_sessions"("p_player_id" "text", "p_platform" "text", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_overwolf_sessions"("p_player_id" "text", "p_platform" "text", "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."lock_telemetry_cache_match"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."lock_telemetry_cache_match"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_board_post_draft_with_images"("p_draft_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_parent_revision" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_board_post_draft_with_images"("p_draft_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_parent_revision" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_crate_asset_name"("input_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_crate_asset_name"("input_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_crate_asset_name"("input_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."prevent_profile_role_escalation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_profile_role_escalation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."process_pending_marker_admin_action"("p_marker_id" "uuid", "p_action" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."process_pending_marker_admin_action"("p_marker_id" "uuid", "p_action" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."read_pubg_response_cache"("p_cache_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."read_pubg_response_cache"("p_cache_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_overwolf_session_event"("p_session_id" "text", "p_match_id" "text", "p_pseudo_match_id" "text", "p_player_id" "text", "p_platform" "text", "p_gep_summary" "jsonb", "p_client_environment" "jsonb", "p_source_host" "text", "p_is_internal" boolean, "p_event_timeline" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_overwolf_session_event"("p_session_id" "text", "p_match_id" "text", "p_pseudo_match_id" "text", "p_player_id" "text", "p_platform" "text", "p_gep_summary" "jsonb", "p_client_environment" "jsonb", "p_source_host" "text", "p_is_internal" boolean, "p_event_timeline" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_lease_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_telemetry_cache_write"("p_match_id" "text", "p_platform" "text", "p_player_id" "text", "p_mode" "text", "p_telemetry_version" numeric, "p_lease_token" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_board_image_upload"("p_owner_user_id" "uuid", "p_expected_mime_type" "text", "p_max_bytes" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_board_image_upload"("p_owner_user_id" "uuid", "p_expected_mime_type" "text", "p_max_bytes" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_pubg_api_alert_delivery"("p_alert_key" "text", "p_window_started_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_pubg_api_alert_delivery"("p_alert_key" "text", "p_window_started_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."revert_weapon_patch_apply"("p_log_id" "uuid", "p_actor" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revert_weapon_patch_apply"("p_log_id" "uuid", "p_actor" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."serialize_board_post_image_delete"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."serialize_board_post_image_delete"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_profile_role"("p_user_id" "uuid", "p_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_profile_role"("p_user_id" "uuid", "p_role" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."suggest_similar_players"("search_name" "text", "search_platform" "text", "limit_val" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."suggest_similar_players"("search_name" "text", "search_platform" "text", "limit_val" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."suggest_similar_players"("search_name" "text", "search_platform" "text", "limit_val" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."transition_board_image_orphans_before_post_delete"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."transition_board_image_orphans_before_post_delete"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" json) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" json) TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" json) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" json) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_hotdrop_counts"("rows" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."weapon_patch_editable_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."weapon_patch_editable_columns"() TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."write_board_post_with_images"("p_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_revision" bigint, "p_title" "text", "p_content" "text", "p_category" "text", "p_image_url" "text", "p_is_notice" boolean, "p_author" "text", "p_user_id" "uuid", "p_password_hash" "text", "p_ip_address" "text", "p_discord_url" "text", "p_discord_channel_id" "text", "p_clan_info" "jsonb", "p_content_image_ids" "uuid"[], "p_thumbnail_image_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."write_board_post_with_images"("p_post_id" bigint, "p_actor_user_id" "uuid", "p_expected_revision" bigint, "p_title" "text", "p_content" "text", "p_category" "text", "p_image_url" "text", "p_is_notice" boolean, "p_author" "text", "p_user_id" "uuid", "p_password_hash" "text", "p_ip_address" "text", "p_discord_url" "text", "p_discord_channel_id" "text", "p_clan_info" "jsonb", "p_content_image_ids" "uuid"[], "p_thumbnail_image_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."write_pubg_response_cache"("p_cache_key" "text", "p_payload" "jsonb", "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."write_pubg_response_cache"("p_cache_key" "text", "p_payload" "jsonb", "p_ttl_seconds" integer) TO "service_role";


















GRANT ALL ON TABLE "public"."agent_approvals" TO "anon";
GRANT ALL ON TABLE "public"."agent_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."agent_memories" TO "anon";
GRANT ALL ON TABLE "public"."agent_memories" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_memories" TO "service_role";



GRANT ALL ON TABLE "public"."agent_runs" TO "anon";
GRANT ALL ON TABLE "public"."agent_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_runs" TO "service_role";



GRANT ALL ON TABLE "public"."agent_steps" TO "anon";
GRANT ALL ON TABLE "public"."agent_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_steps" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage_logs" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage_logs" TO "service_role";



GRANT ALL ON TABLE "public"."ammo" TO "anon";
GRANT ALL ON TABLE "public"."ammo" TO "authenticated";
GRANT ALL ON TABLE "public"."ammo" TO "service_role";



GRANT ALL ON TABLE "public"."analytics_event_rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."analytics_event_rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."analytics_event_rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."analytics_events" TO "anon";
GRANT ALL ON TABLE "public"."analytics_events" TO "authenticated";
GRANT ALL ON TABLE "public"."analytics_events" TO "service_role";



GRANT ALL ON TABLE "public"."attachments" TO "anon";
GRANT ALL ON TABLE "public"."attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."attachments" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."global_benchmarks" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."global_benchmarks" TO "authenticated";
GRANT ALL ON TABLE "public"."global_benchmarks" TO "service_role";



GRANT ALL ON TABLE "public"."benchmark_stats_by_tier" TO "anon";
GRANT ALL ON TABLE "public"."benchmark_stats_by_tier" TO "authenticated";
GRANT ALL ON TABLE "public"."benchmark_stats_by_tier" TO "service_role";



GRANT ALL ON TABLE "public"."board_image_objects" TO "service_role";



GRANT ALL ON TABLE "public"."board_image_reservation_rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."board_post_image_refs" TO "service_role";



GRANT ALL ON TABLE "public"."board_write_rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."bonus_items" TO "anon";
GRANT ALL ON TABLE "public"."bonus_items" TO "authenticated";
GRANT ALL ON TABLE "public"."bonus_items" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."comments" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."comments" TO "authenticated";
GRANT ALL ON TABLE "public"."comments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."comments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."comments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."comments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."consumables" TO "anon";
GRANT ALL ON TABLE "public"."consumables" TO "authenticated";
GRANT ALL ON TABLE "public"."consumables" TO "service_role";



GRANT ALL ON TABLE "public"."craftable_items" TO "anon";
GRANT ALL ON TABLE "public"."craftable_items" TO "authenticated";
GRANT ALL ON TABLE "public"."craftable_items" TO "service_role";



GRANT ALL ON TABLE "public"."crate_item_assets" TO "anon";
GRANT ALL ON TABLE "public"."crate_item_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."crate_item_assets" TO "service_role";



GRANT ALL ON TABLE "public"."crate_item_relations" TO "anon";
GRANT ALL ON TABLE "public"."crate_item_relations" TO "authenticated";
GRANT ALL ON TABLE "public"."crate_item_relations" TO "service_role";



GRANT ALL ON TABLE "public"."crate_items" TO "anon";
GRANT ALL ON TABLE "public"."crate_items" TO "authenticated";
GRANT ALL ON TABLE "public"."crate_items" TO "service_role";



GRANT ALL ON TABLE "public"."crate_templates" TO "anon";
GRANT ALL ON TABLE "public"."crate_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."crate_templates" TO "service_role";



GRANT ALL ON TABLE "public"."discord_room_rate_limits" TO "service_role";



GRANT ALL ON SEQUENCE "public"."global_benchmarks_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."global_benchmarks_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."global_benchmarks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."hotdrop_heatmap" TO "anon";
GRANT ALL ON TABLE "public"."hotdrop_heatmap" TO "authenticated";
GRANT ALL ON TABLE "public"."hotdrop_heatmap" TO "service_role";



GRANT ALL ON SEQUENCE "public"."hotdrop_heatmap_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."hotdrop_heatmap_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."hotdrop_heatmap_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ip_blacklist" TO "anon";
GRANT ALL ON TABLE "public"."ip_blacklist" TO "authenticated";
GRANT ALL ON TABLE "public"."ip_blacklist" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ip_blacklist_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ip_blacklist_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ip_blacklist_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."map_markers" TO "anon";
GRANT ALL ON TABLE "public"."map_markers" TO "authenticated";
GRANT ALL ON TABLE "public"."map_markers" TO "service_role";



GRANT ALL ON TABLE "public"."map_settings" TO "anon";
GRANT ALL ON TABLE "public"."map_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."map_settings" TO "service_role";



GRANT ALL ON TABLE "public"."match_ai_coaching_cache" TO "anon";
GRANT ALL ON TABLE "public"."match_ai_coaching_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."match_ai_coaching_cache" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."match_master_telemetry" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."match_master_telemetry" TO "authenticated";
GRANT ALL ON TABLE "public"."match_master_telemetry" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."match_stats_raw" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."match_stats_raw" TO "authenticated";
GRANT ALL ON TABLE "public"."match_stats_raw" TO "service_role";



GRANT ALL ON SEQUENCE "public"."match_stats_raw_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."match_stats_raw_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."match_stats_raw_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."notifications" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."overwolf_session_events" TO "service_role";



GRANT ALL ON TABLE "public"."overwolf_session_quota" TO "service_role";



GRANT ALL ON TABLE "public"."pending_markers" TO "anon";
GRANT ALL ON TABLE "public"."pending_markers" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_markers" TO "service_role";



GRANT ALL ON TABLE "public"."player_ai_summary_cache" TO "anon";
GRANT ALL ON TABLE "public"."player_ai_summary_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."player_ai_summary_cache" TO "service_role";



GRANT ALL ON TABLE "public"."post_likes" TO "anon";
GRANT ALL ON TABLE "public"."post_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."post_likes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."post_likes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."post_likes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."post_likes_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."posts" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."posts" TO "authenticated";
GRANT ALL ON TABLE "public"."posts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."posts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."posts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."posts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."prime_parcel_items" TO "anon";
GRANT ALL ON TABLE "public"."prime_parcel_items" TO "authenticated";
GRANT ALL ON TABLE "public"."prime_parcel_items" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."processed_match_telemetry" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."processed_match_telemetry" TO "authenticated";
GRANT ALL ON TABLE "public"."processed_match_telemetry" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."pubg_api_alert_deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."pubg_api_errors" TO "anon";
GRANT ALL ON TABLE "public"."pubg_api_errors" TO "authenticated";
GRANT ALL ON TABLE "public"."pubg_api_errors" TO "service_role";



GRANT ALL ON TABLE "public"."pubg_api_status" TO "anon";
GRANT ALL ON TABLE "public"."pubg_api_status" TO "authenticated";
GRANT ALL ON TABLE "public"."pubg_api_status" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pubg_player_cache" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pubg_player_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."pubg_player_cache" TO "service_role";



GRANT ALL ON TABLE "public"."pubg_refresh_locks" TO "service_role";



GRANT ALL ON TABLE "public"."pubg_response_cache" TO "service_role";



GRANT ALL ON TABLE "public"."reports" TO "anon";
GRANT ALL ON TABLE "public"."reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reports" TO "service_role";



GRANT ALL ON SEQUENCE "public"."reports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."reports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."reports_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."squad_ai_coaching_cache" TO "anon";
GRANT ALL ON TABLE "public"."squad_ai_coaching_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."squad_ai_coaching_cache" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sync_history" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sync_history" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_history" TO "service_role";



GRANT ALL ON TABLE "public"."system_settings" TO "anon";
GRANT ALL ON TABLE "public"."system_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."system_settings" TO "service_role";



GRANT ALL ON TABLE "public"."telemetry_map_cache_entries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."telemetry_map_cache_entries_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."throwables" TO "anon";
GRANT ALL ON TABLE "public"."throwables" TO "authenticated";
GRANT ALL ON TABLE "public"."throwables" TO "service_role";



GRANT ALL ON TABLE "public"."user_knowledge_notes" TO "anon";
GRANT ALL ON TABLE "public"."user_knowledge_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."user_knowledge_notes" TO "service_role";



GRANT ALL ON TABLE "public"."user_memory_facts" TO "anon";
GRANT ALL ON TABLE "public"."user_memory_facts" TO "authenticated";
GRANT ALL ON TABLE "public"."user_memory_facts" TO "service_role";



GRANT ALL ON TABLE "public"."vehicles" TO "anon";
GRANT ALL ON TABLE "public"."vehicles" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicles" TO "service_role";



GRANT ALL ON TABLE "public"."weapon_patch_apply_log" TO "service_role";



GRANT ALL ON TABLE "public"."weapon_patch_proposal_changes" TO "service_role";



GRANT ALL ON TABLE "public"."weapon_patch_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."weapons" TO "anon";
GRANT ALL ON TABLE "public"."weapons" TO "authenticated";
GRANT ALL ON TABLE "public"."weapons" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































