-- compact_match_stats_raw 응답에 total_count 를 추가한다.
--
-- 관리자 화면의 데이터 관리 섹션은 "테이블 총 크기 / 총 행수 * 삭제 대상 행수"로
-- 회수 가능 용량을 추정한다. 이 함수가 total_count 를 돌려주지 않아 추정치가
-- 항상 0MB 로 표시됐다(2026-08-01 실측 확인).
--
-- compact_pubg_player_cache 는 이미 total_count 를 반환한다. 두 함수의 응답
-- 형태를 맞춰 화면이 대상별로 분기하지 않게 한다.
--
-- 기존 필드는 그대로 두므로 scripts/cleanup_match_stats_raw.ts 의 계약은
-- 변하지 않는다.
CREATE OR REPLACE FUNCTION public.compact_match_stats_raw(
  p_apply boolean DEFAULT false,
  p_batch_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.compact_match_stats_raw(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compact_match_stats_raw(boolean, integer)
  TO service_role;
