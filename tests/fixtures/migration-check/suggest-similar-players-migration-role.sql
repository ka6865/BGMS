-- 전체 migration 적용 직후 같은 새 연결에서 소유권·ACL·실제 service_role 호출을 검증한다.
reset role;
begin;
do $$
begin
  if (select rolsuper from pg_roles where rolname='bgms_migration_check') then
    raise exception 'migration check role must be NOSUPERUSER';
  end if;
  if not exists (
    select from pg_proc
    where oid='public.suggest_similar_players(text,text,integer)'::regprocedure
      and proowner='bgms_migration_check'::regrole
      and not prosecdef
      and array_position(proconfig,'search_path=public') is not null
      and array_position(proconfig,'pg_trgm.similarity_threshold=0.2') is not null
  ) then
    raise exception 'non-superuser migration must preserve owner and invoker settings';
  end if;
  if has_function_privilege('anon','public.suggest_similar_players(text,text,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.suggest_similar_players(text,text,integer)','EXECUTE')
    or exists (
      select from aclexplode((select proacl from pg_proc where oid='public.suggest_similar_players(text,text,integer)'::regprocedure))
      where grantee=0 and privilege_type='EXECUTE'
    )
    or not has_function_privilege('service_role','public.suggest_similar_players(text,text,integer)','EXECUTE') then
    raise exception 'non-superuser migration must restrict execute to service_role';
  end if;
end;
$$;

insert into public.pubg_player_cache(id,nickname,lower_nickname,platform,updated_at,search_count)
values
  ('account.migration-trgm1','MigrationTrgm','migrationtrgm','steam',now(),0),
  ('account.migration-trgm2','MigrationTrgm2','migrationtrgm2','steam',now(),0);

set local role service_role;
do $$
declare
  results integer;
  best_similarity real;
  before_threshold text := current_setting('pg_trgm.similarity_threshold');
begin
  select count(*), max(similarity) into results, best_similarity
  from public.suggest_similar_players('MigrationTrgm','steam',10);
  if current_user <> 'service_role' or results < 2 or best_similarity is distinct from 1::real then
    raise exception 'service_role must actually receive matching RPC results';
  end if;
  if current_setting('pg_trgm.similarity_threshold') <> before_threshold then
    raise exception 'RPC must preserve the session similarity threshold';
  end if;
  raise notice 'PASS: 새 연결의 NOSUPERUSER migration·service_role 호출·ACL';
end;
$$;
rollback;
