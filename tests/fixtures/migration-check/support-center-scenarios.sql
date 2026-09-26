-- 고객센터 migration 경계: private evidence bucket, RLS, service-role RPC ACL.
do $$
declare
  bucket_public boolean;
  bucket_size_limit bigint;
  bucket_mime_types text[];
  has_ticket_rls boolean;
  has_message_rls boolean;
  has_attachment_rls boolean;
  rpc_acl text[];
  public_settings_policy text;
  completion_result text;
  attachment_status text;
begin
  select public, file_size_limit, allowed_mime_types
  into bucket_public, bucket_size_limit, bucket_mime_types
  from storage.buckets
  where id = 'support-evidence';
  if bucket_public is distinct from false then
    raise exception 'support evidence bucket must remain private';
  end if;
  if bucket_size_limit <> 3145728
    or not (array['image/png', 'image/jpeg', 'image/webp']::text[] <@ coalesce(bucket_mime_types, '{}'::text[])) then
    raise exception 'support evidence bucket upload limits are not enforced';
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

  select qual into public_settings_policy
  from pg_policies
  where schemaname = 'public'
    and tablename = 'system_settings'
    and policyname = 'Allow public read non-private system_settings';
  if public_settings_policy is null or public_settings_policy not ilike '%private_players_list%' then
    raise exception 'private player registry must not be publicly readable';
  end if;

  insert into public.profiles (id, nickname, role)
  values ('11111111-1111-4111-8111-111111111111', 'support-user', 'user')
  on conflict (id) do nothing;
  insert into public.support_attachments (
    id, uploader_id, bucket_id, storage_key, original_name, mime_type, byte_size, status
  ) values (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'support-evidence',
    'attachments/22222222-2222-4222-8222-222222222222',
    'proof.png', 'image/png', 100, 'pending'
  );
  insert into storage.objects (bucket_id, name, metadata)
  values ('support-evidence', 'attachments/22222222-2222-4222-8222-222222222222', '{"mimetype":"image/png","size":100}'::jsonb);
  select public.complete_support_attachment(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111'
  ) into completion_result;
  select status into attachment_status from public.support_attachments
  where id = '22222222-2222-4222-8222-222222222222';
  if completion_result <> 'ready' or attachment_status <> 'ready' then
    raise exception 'support attachment metadata completion RPC failed';
  end if;
  raise notice 'PASS: 고객센터 private bucket, RLS, RPC 권한 격리';
end $$;

-- 관리자 답변은 메시지와 알림을 함께 저장해야 한다. 부분 유니크 인덱스의
-- ON CONFLICT 대상이 맞지 않으면 RPC 전체가 롤백되는 회귀를 잡는다.
do $$
declare
  admin_id uuid := '33333333-3333-4333-8333-333333333333';
  requester_id uuid := '11111111-1111-4111-8111-111111111111';
  v_ticket_id uuid;
  reply jsonb;
begin
  insert into public.profiles (id, nickname, role)
  values (admin_id, 'support-admin', 'admin')
  on conflict (id) do update set role = 'admin';

  insert into public.support_tickets (requester_id, category, subject)
  values (requester_id, 'other', 'reply regression')
  returning id into v_ticket_id;

  reply := public.append_support_message(
    v_ticket_id, admin_id, 'admin', '확인 후 답변드립니다.',
    '44444444-4444-4444-8444-444444444444'
  );

  if not (reply ? 'id')
    or (select count(*) from public.support_messages
        where ticket_id = v_ticket_id and sender_type = 'admin') <> 1
    or (select count(*) from public.notifications
        where support_message_id = (reply->>'id')::uuid) <> 1 then
    raise exception 'admin reply or notification was not saved';
  end if;
  raise notice 'PASS: 관리자 답변과 알림 저장';
end $$;
