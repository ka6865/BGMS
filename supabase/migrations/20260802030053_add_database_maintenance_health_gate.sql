-- 무거운 일일 유지보수를 시작하기 전 DB 압력을 한 번에 점검한다.
-- service_role 전용이며 사용자 쿼리나 식별자를 반환하지 않는다.

create or replace function public.get_database_maintenance_health()
returns table (
  total_connections bigint,
  max_connections integer,
  active_queries bigint,
  lock_waiters bigint,
  longest_active_seconds numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with activity as (
    select state, wait_event_type, query_start
    from pg_catalog.pg_stat_activity
    where datname = pg_catalog.current_database()
      and backend_type = 'client backend'
      and pid <> pg_catalog.pg_backend_pid()
  )
  select
    count(*)::bigint as total_connections,
    pg_catalog.current_setting('max_connections')::integer as max_connections,
    count(*) filter (where state = 'active')::bigint as active_queries,
    count(*) filter (
      where wait_event_type = 'Lock'
        and pg_catalog.clock_timestamp() - query_start >= interval '5 seconds'
    )::bigint as lock_waiters,
    coalesce(
      max(extract(epoch from (pg_catalog.clock_timestamp() - query_start)))
        filter (where state = 'active'),
      0
    )::numeric as longest_active_seconds
  from activity;
$$;

revoke all on function public.get_database_maintenance_health() from public;
revoke all on function public.get_database_maintenance_health() from anon;
revoke all on function public.get_database_maintenance_health() from authenticated;
grant execute on function public.get_database_maintenance_health() to service_role;

comment on function public.get_database_maintenance_health() is
  'service_role 전용 일일 유지보수 시작 전 연결·active query·lock pressure 점검';
