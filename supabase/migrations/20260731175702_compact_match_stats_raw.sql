-- match_stats_raw 표본 축소
--
-- 관리자 통계는 분석 대상 사용자 표본과 승자 데이터만 필요하지만 기존 적재는
-- 매치 참가자 전원을 저장했다. 분석 대상 표본을 명시하고 안전한 배치 정리
-- 함수로 나머지 행을 제거할 수 있게 한다.

ALTER TABLE public.match_stats_raw
  ADD COLUMN IF NOT EXISTS is_analysis_sample boolean NOT NULL DEFAULT false;

-- 기존 분석 대상자는 processed_match_telemetry의 동일 identity로 판별할 수 있다.
UPDATE public.match_stats_raw AS stats
SET is_analysis_sample = true
FROM public.processed_match_telemetry AS processed
WHERE processed.match_id = stats.match_id
  AND processed.platform = stats.platform
  AND processed.player_id = stats.player_id
  AND stats.is_analysis_sample = false;

-- 최근 분석 사용자 표본과 승자 상위 딜량 조회를 각각 지원한다.
CREATE INDEX IF NOT EXISTS idx_match_stats_raw_analysis_sample_created
  ON public.match_stats_raw (created_at DESC)
  WHERE is_analysis_sample = true;

CREATE INDEX IF NOT EXISTS idx_match_stats_raw_winner_damage
  ON public.match_stats_raw (damage DESC)
  WHERE win_place = 1;

-- 정리 전용 partial index는 후보가 줄어들수록 함께 작아진다.
CREATE INDEX IF NOT EXISTS idx_match_stats_raw_compaction_candidates
  ON public.match_stats_raw (created_at, match_id, platform, player_id)
  WHERE is_analysis_sample = false AND win_place <> 1;

-- 현재 코드에는 player 단독 조회가 없으며 해당 인덱스는 원본 전체 행에 중복된다.
DROP INDEX IF EXISTS public.idx_match_stats_raw_player_id;
DROP INDEX IF EXISTS public.idx_match_stats_raw_platform_player_created;

/**
 * 분석 대상 표본도 승자도 아닌 기존 행을 제한된 배치로 정리한다.
 * p_apply 기본값은 false이며 dry-run에서는 삭제하지 않는다.
 */
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

  RETURN jsonb_build_object(
    'candidate_count', candidate_count,
    'deleted_count', deleted_count,
    'remaining_count', remaining_count,
    'dry_run', NOT apply_changes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compact_match_stats_raw(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compact_match_stats_raw(boolean, integer)
  TO service_role;
