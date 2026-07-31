-- 인덱스 사용량 조회 함수.
--
-- 배경: 2026-08-01 용량 점검에서 인덱스가 데이터보다 큰 테이블이 나왔다.
--   pubg_player_cache   데이터 77.5MB / 인덱스 87.9MB
--   analytics_events    데이터 25.6MB / 인덱스 19.0MB (인덱스 8개)
--
-- 쓰이지 않는 인덱스는 용량만 차지하고 쓰기 성능도 떨어뜨린다. 다만 실제
-- 사용 여부를 모르고 지우면 쿼리가 순차 스캔으로 떨어진다. 2026-08-01 에
-- suggest 라우트가 인덱스 부재로 2,179ms 를 쓴 사례가 있다.
--
-- pg_stat_user_indexes 의 누적 스캔 횟수를 근거로 판단할 수 있게 노출한다.
-- 읽기 전용이며 service_role 전용이다.
--
-- 주의: idx_scan 은 마지막 통계 초기화 이후 누적값이다. 값이 0이어도 최근
-- 배포된 인덱스일 수 있으므로 stats_reset 시점과 함께 봐야 한다.
create or replace function public.get_index_usage(p_table_name text default null)
returns table (
  table_name text,
  index_name text,
  index_bytes bigint,
  scan_count bigint,
  tuples_read bigint,
  is_unique boolean
)
language sql
security invoker
stable
set search_path = ''
as $$
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

revoke all on function public.get_index_usage(text)
  from public, anon, authenticated;
grant execute on function public.get_index_usage(text)
  to service_role;
