-- 고객센터 migration 경계: private evidence bucket, RLS, service-role RPC ACL.
do $$
declare
  bucket_public boolean;
  has_ticket_rls boolean;
  has_message_rls boolean;
  has_attachment_rls boolean;
  rpc_acl text[];
begin
  select public into bucket_public
  from storage.buckets
  where id = 'support-evidence';
  if bucket_public is distinct from false then
    raise exception 'support evidence bucket must remain private';
  end if;

  select relrowsecurity into has_ticket_rls from pg_class where oid = 'public.support_tickets'::regclass;
  select relrowsecurity into has_message_rls from pg_class where oid = 'public.support_messages'::regclass;
  select relrowsecurity into has_attachment_rls from pg_class where oid = 'public.support_attachments'::regclass;
  if not coalesce(has_ticket_rls, false) or not coalesce(has_message_rls, false) or not coalesce(has_attachment_rls, false) then
    raise exception 'support tables must enable RLS';
  end if;

  select coalesce(array_agg(grantee order by grantee), '{}'::text[]) into rpc_acl
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name = 'create_support_ticket'
    and privilege_type = 'EXECUTE';
  if not ('service_role' = any(rpc_acl)) or 'anon' = any(rpc_acl) or 'authenticated' = any(rpc_acl) then
    raise exception 'support ticket RPC ACL is not service-role only';
  end if;
  raise notice 'PASS: 고객센터 private bucket, RLS, RPC 권한 격리';
end $$;
