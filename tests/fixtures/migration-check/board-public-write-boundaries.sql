-- Runs only in the verifier's disposable PostgreSQL database.
begin;
do $$
begin
  if exists(select from pg_policies where schemaname='public' and tablename='reports' and policyname='Allow public insert reports') then
    raise exception 'public report insert policy must be removed';
  end if;
  if has_table_privilege('anon','public.reports','INSERT')
    or has_table_privilege('authenticated','public.reports','INSERT') then
    raise exception 'anon and authenticated must not insert reports directly';
  end if;
  if not has_table_privilege('service_role','public.reports','INSERT') then
    raise exception 'service role must keep report insert access';
  end if;
  if has_table_privilege('anon','public.reports','TRUNCATE')
    or has_table_privilege('authenticated','public.reports','TRUNCATE')
    or exists (
      select from aclexplode((select relacl from pg_class where oid='public.reports'::regclass))
      where grantee=0 and privilege_type='TRUNCATE'
    ) then
    raise exception 'PUBLIC, anon and authenticated must not truncate reports';
  end if;
  if not has_table_privilege('service_role','public.reports','TRUNCATE') then
    raise exception 'service role must keep report truncate access';
  end if;
  if exists (
    select from unnest(array['anon','authenticated','service_role']) as r(role_name)
    cross join unnest(array['SELECT','UPDATE','DELETE']) as p(privilege)
    where not has_table_privilege(role_name,'public.reports',privilege)
  ) then
    raise exception 'reports SELECT/UPDATE/DELETE grants must be preserved';
  end if;

  if has_function_privilege('anon','public.increment_likes(integer)','EXECUTE')
    or has_function_privilege('authenticated','public.increment_likes(integer)','EXECUTE') then
    raise exception 'increment_likes must not be executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role','public.increment_likes(integer)','EXECUTE') then
    raise exception 'service role must keep increment_likes access';
  end if;

  if has_function_privilege('anon','public.increment_views(integer)','EXECUTE')
    or has_function_privilege('authenticated','public.increment_views(integer)','EXECUTE') then
    raise exception 'increment_views must not be executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role','public.increment_views(integer)','EXECUTE') then
    raise exception 'service role must keep increment_views access';
  end if;
end;
$$;

-- An authenticated session cannot write a report row through PostgREST.
do $$
declare blocked boolean := false;
begin
  execute 'set local role authenticated';
  begin
    insert into public.reports(target_type,target_id,reason,reporter_ip,status)
    values ('post',1,'direct','1.1.1.1','resolved');
  exception when insufficient_privilege then
    blocked := true;
  end;
  execute 'reset role';
  if not blocked then
    raise exception 'direct report insert by authenticated must be rejected';
  end if;
end;
$$;
rollback;
