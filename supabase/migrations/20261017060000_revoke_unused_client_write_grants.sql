-- 공개 키(anon)와 일반 로그인 사용자에게 남아 있던 쓰기 권한 중 쓰지 않는 것을 회수한다.
-- 지금은 RLS 정책이 막고 있지만, 정책 하나를 잘못 만들면 바로 열리는 구조라 권한에서도 닫는다.
-- - anon: 모든 쓰기 정책이 auth.uid()·관리자·service role을 요구해 통과할 수 없으므로 쓰기 권한을 모두 회수한다.
-- - authenticated: 해당 명령(또는 ALL)에 authenticated/public 대상 정책이 있는 표만 그 명령 권한을 남긴다.
--   service role 전용(auth.role() = 'service_role')이나 false 정책은 통과할 수 없으므로 남기지 않는다.
-- - TRUNCATE·REFERENCES·TRIGGER는 RLS를 거치지 않거나 쓰이지 않으므로 둘 다 회수한다.
-- 이후 public 스키마에 만드는 표는 anon 쓰기 권한이 기본으로 붙지 않는다.
begin;

do $$
declare
  r record;
  priv text;
begin
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from anon', r.relname);
    execute format('revoke truncate, references, trigger on table public.%I from authenticated', r.relname);
    foreach priv in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = r.relname
          and p.cmd in (priv, 'ALL')
          and p.roles && array['public', 'authenticated']::name[]
          and coalesce(p.qual, p.with_check, '') !~ '^\(*auth\.role\(\) = ''service_role''::text\)*$'
          and coalesce(p.qual, p.with_check, '') <> 'false'
      ) then
        execute format('revoke %s on table public.%I from authenticated', priv, r.relname);
      end if;
    end loop;
  end loop;
end $$;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;

commit;
