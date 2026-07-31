-- analytics_events 보존 정책 도입
--
-- 배경: analytics_events 에 정리 로직이 전혀 없어 2026-06-10 부터 두 달간
-- 한 번도 삭제되지 않았다. 82,056 행 / 45MB 로 DB 용량 상위 4위이며
-- 무료 플랜 한도(500MB) 대비 461MB 사용 중인 상황에 기여하고 있다.
--
-- 이 테이블은 사용자 행동 분석용 원본 로그이며 화면에 직접 표시되지 않는다.
-- 관리자 통계는 집계 조회로 처리되므로 오래된 원본을 삭제해도 기능 영향이 없다.
--
-- 보존 기간은 기본 30일로 둔다. 조회 시점 기준 30일 초과 행이 27,868 건이다.

/**
 * 보존 기간이 지난 analytics_events 행을 삭제합니다.
 * 배치 단위로 삭제해 장시간 락을 피합니다.
 * 남은 대상이 있으면 다음 실행에서 이어서 처리합니다.
 */
CREATE OR REPLACE FUNCTION public.cleanup_analytics_events(
  p_retention_days integer DEFAULT 30,
  p_batch_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

/**
 * 보존 기간이 지난 analytics_event_rate_limits 행을 삭제합니다.
 * rate limit 기록은 짧은 기간만 필요하므로 기본 7일로 둡니다.
 * 이 테이블에는 created_at 이 없고 window_started_at 이 기록 시점을 나타냅니다.
 */
CREATE OR REPLACE FUNCTION public.cleanup_analytics_event_rate_limits(
  p_retention_days integer DEFAULT 7
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

-- created_at 기준 삭제가 순차 스캔으로 처리되지 않도록 인덱스를 보장한다.
CREATE INDEX IF NOT EXISTS analytics_events_created_at_idx
  ON public.analytics_events (created_at);

REVOKE ALL ON FUNCTION public.cleanup_analytics_events(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_analytics_event_rate_limits(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_analytics_events(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_analytics_event_rate_limits(integer) TO service_role;
