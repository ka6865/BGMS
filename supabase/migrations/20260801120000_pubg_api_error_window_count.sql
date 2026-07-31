-- PUBG API 오류 알림 임계값 판정을 인스턴스 메모리에서 DB 로 이전한다.
--
-- 배경: lib/pubg/apiHelper.ts 가 모듈 스코프 배열(errorQueue)의 길이로
-- "5분 내 10회" 임계값을 판정했다. Vercel 서버리스는 요청을 여러 인스턴스에
-- 분산하므로 각 인스턴스의 큐는 전체 오류의 일부만 본다.
--
-- 운영 실측(2026-08-01 조회): 최근 7일 5xx 74건이 발생했으나 알림은 1건만
-- 발송됐다. 74건이 2026-07-27 약 5분 구간에 집중된 장애였음에도 인스턴스별
-- 카운트가 10에 도달하지 못해 대부분 누락됐다.
--
-- 대응: 이미 모든 오류가 public.pubg_api_errors 에 적립되므로, 그 테이블을
-- 단일 진실 공급원으로 삼아 윈도우 내 발생 건수를 집계한다. 인스턴스 수와
-- 무관하게 동일한 판정 결과를 얻는다.
--
-- 알림 중복 발송은 기존 reserve_pubg_api_alert_delivery 예약이 계속 막는다.
-- 이 함수는 판정에만 쓰이며 쓰기 부수효과가 없다.

-- 윈도우 집계가 created_at 범위 스캔을 타도록 인덱스를 둔다.
-- status 를 포함해 5xx/429 필터를 인덱스에서 처리한다.
create index if not exists pubg_api_errors_created_at_status_idx
  on public.pubg_api_errors (created_at desc, status);

-- 지정 윈도우 안에서 알림 대상(status >= p_min_status)인 오류 건수를 센다.
-- p_route 가 null 이면 전체 라우트를 합산한다.
create or replace function public.count_pubg_api_errors_in_window(
  p_window_started_at timestamptz,
  p_min_status integer default 500,
  p_route text default null
)
returns integer
language sql
security invoker
stable
set search_path = ''
as $$
  select coalesce(count(*), 0)::integer
  from public.pubg_api_errors as errors
  where errors.created_at >= p_window_started_at
    and errors.status >= p_min_status
    and (p_route is null or errors.route = p_route);
$$;

revoke all on function public.count_pubg_api_errors_in_window(timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.count_pubg_api_errors_in_window(timestamptz, integer, text)
  to service_role;
