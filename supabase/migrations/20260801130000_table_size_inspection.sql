-- 테이블별 용량 조회 함수. 무료 플랜 500MB 한도에서 어느 테이블이 병목인지
-- 코드로 확인할 수 있어야 정리 우선순위를 근거 있게 정할 수 있다.
--
-- 배경: get_db_size 는 전체 크기만 반환해서, 용량이 늘어도 원인 테이블을
-- 특정하려면 Supabase 콘솔을 사람이 열어봐야 했다. 일일 모니터링이
-- 스크립트로 돌아가는데 진단 정보만 수동이라 대응이 늦어진다.
--
-- 읽기 전용이며 pg_catalog 만 조회한다. service_role 전용으로 제한한다.
create or replace function public.get_table_sizes(p_limit integer default 20)
returns table (
  table_name text,
  total_bytes bigint,
  table_bytes bigint,
  index_bytes bigint,
  row_estimate bigint
)
language sql
security invoker
stable
set search_path = ''
as $$
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

revoke all on function public.get_table_sizes(integer)
  from public, anon, authenticated;
grant execute on function public.get_table_sizes(integer)
  to service_role;
