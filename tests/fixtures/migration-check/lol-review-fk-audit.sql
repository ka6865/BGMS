-- FK의 참조 열이 유효한 비부분 인덱스의 선두에 있는지 PG17 카탈로그로 확인한다.
select c.conrelid::regclass as table_name, c.conname, c.conkey
from pg_catalog.pg_constraint c
join pg_catalog.pg_class t on t.oid = c.conrelid
join pg_catalog.pg_namespace n on n.oid = t.relnamespace
where c.contype = 'f' and n.nspname = 'public'
  and (t.relname like 'lol_augment%' or t.relname in ('lol_public_rate_limits','lol_data_dragon_versions'))
  and not exists (
    select 1 from pg_catalog.pg_index i
    where i.indrelid = c.conrelid and i.indisvalid and i.indpred is null and i.indexprs is null
      and i.indnkeyatts >= pg_catalog.cardinality(c.conkey)
      and (i.indkey::smallint[])[0:pg_catalog.cardinality(c.conkey)-1] @> c.conkey
  )
order by c.conrelid::regclass::text, c.conname;
