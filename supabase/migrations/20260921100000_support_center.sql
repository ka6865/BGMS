-- BGMS customer center: public FAQ, private tickets, and private evidence.

create table if not exists public.support_faqs (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('stats', 'account', 'community', 'feature')),
  question text not null,
  answer text not null,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category, question)
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.profiles(id) on delete set null,
  category text not null check (category in ('privacy', 'account', 'community', 'bug', 'other')),
  subject text not null check (char_length(subject) between 1 and 120),
  status text not null default 'new' check (status in ('new', 'in_progress', 'awaiting_user', 'answered', 'resolved', 'rejected')),
  verification_status text not null default 'not_required' check (verification_status in ('not_required', 'pending', 'verified', 'additional_info', 'rejected')),
  target_platform text check (target_platform is null or target_platform in ('steam', 'kakao')),
  target_nickname text,
  target_account_id text,
  target_resolved_nickname text,
  target_resolved_at timestamptz,
  last_message_at timestamptz not null default now(),
  last_message_sender text not null default 'user' check (last_message_sender in ('user', 'admin')),
  user_last_read_at timestamptz,
  admin_last_read_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (category = 'privacy' and verification_status <> 'not_required')
    or (category <> 'privacy' and verification_status = 'not_required')
  )
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  sender_type text not null check (sender_type in ('user', 'admin')),
  idempotency_key text,
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);

alter table public.support_messages add column if not exists idempotency_key text;

create table if not exists public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  message_id uuid references public.support_messages(id) on delete set null,
  uploader_id uuid references public.profiles(id) on delete set null,
  bucket_id text not null default 'support-evidence',
  storage_key text not null unique,
  original_name text not null,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 3145728),
  status text not null default 'pending' check (status in ('pending', 'ready', 'deleted')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.support_attachments drop constraint if exists support_attachments_status_check;
alter table public.support_attachments add constraint support_attachments_status_check
  check (status in ('pending', 'ready', 'deleting', 'deleted'));

create table if not exists public.support_ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists support_tickets_requester_updated_idx
  on public.support_tickets(requester_id, updated_at desc);
create index if not exists support_tickets_status_last_message_idx
  on public.support_tickets(status, last_message_at);
create index if not exists support_messages_ticket_created_idx
  on public.support_messages(ticket_id, created_at);
create unique index if not exists support_messages_idempotency_idx
  on public.support_messages(ticket_id, sender_type, idempotency_key)
  where idempotency_key is not null;
create index if not exists support_attachments_ticket_status_idx
  on public.support_attachments(ticket_id, status);
create index if not exists support_ticket_events_ticket_created_idx
  on public.support_ticket_events(ticket_id, created_at);

create unique index if not exists support_tickets_open_privacy_identity_idx
  on public.support_tickets(requester_id, target_platform, target_account_id)
  where category = 'privacy' and status not in ('resolved', 'rejected');

create unique index if not exists support_ticket_privacy_action_once_idx
  on public.support_ticket_events(ticket_id)
  where event_type in ('privacy_player_registered', 'privacy_player_already_registered');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'support-evidence',
  'support-evidence',
  false,
  3145728,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = 3145728,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']::text[];

alter table public.notifications
  add column if not exists support_ticket_id uuid references public.support_tickets(id) on delete cascade;
alter table public.notifications
  add column if not exists support_message_id uuid references public.support_messages(id) on delete cascade;
create unique index if not exists notifications_support_message_once_idx
  on public.notifications(support_message_id)
  where support_message_id is not null;

create or replace function public.set_support_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_faqs_updated_at on public.support_faqs;
create trigger support_faqs_updated_at
before update on public.support_faqs
for each row execute function public.set_support_updated_at();

drop trigger if exists support_tickets_updated_at on public.support_tickets;
create trigger support_tickets_updated_at
before update on public.support_tickets
for each row execute function public.set_support_updated_at();

create or replace function public.create_support_ticket(
  p_requester_id uuid,
  p_category text,
  p_subject text,
  p_body text,
  p_verification_status text,
  p_target_platform text,
  p_target_nickname text,
  p_target_account_id text,
  p_target_resolved_nickname text,
  p_attachment_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket_id uuid;
  v_message_id uuid;
  v_attachment_count integer;
  v_distinct_attachment_count integer;
  v_requested_attachment_count integer := coalesce(array_length(p_attachment_ids, 1), 0);
begin
  if p_requester_id is null or p_category is null or p_subject is null or p_body is null then
    raise exception 'support_ticket_invalid_input' using errcode = '22023';
  end if;

  -- Serialize the per-user quota check with ticket creation so concurrent
  -- requests cannot both pass the 24-hour limit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_requester_id::text, 47114));
  if (select count(*) from public.support_tickets
      where requester_id = p_requester_id
        and created_at >= now() - interval '24 hours') >= 5 then
    raise exception 'support_ticket_daily_quota' using errcode = 'P0001';
  end if;

  if p_category = 'privacy' then
    if p_verification_status <> 'pending'
      or p_target_platform not in ('steam', 'kakao')
      or nullif(trim(p_target_nickname), '') is null
      or nullif(trim(p_target_account_id), '') is null
      or v_requested_attachment_count = 0 then
      raise exception 'support_ticket_privacy_requirements' using errcode = '22023';
    end if;
  elsif p_verification_status <> 'not_required' then
    raise exception 'support_ticket_verification_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct attachment_id)
  into v_attachment_count, v_distinct_attachment_count
  from unnest(coalesce(p_attachment_ids, '{}'::uuid[])) as requested(attachment_id)
  where requested.attachment_id is not null;

  if v_attachment_count <> v_distinct_attachment_count then
    raise exception 'support_ticket_attachment_duplicate' using errcode = '22023';
  end if;

  if v_requested_attachment_count > 0 then
    select count(*) into v_attachment_count
    from (
      select attachment.id
      from public.support_attachments as attachment
      join unnest(p_attachment_ids) as requested(attachment_id)
        on requested.attachment_id = attachment.id
      where attachment.status = 'ready'
        and attachment.ticket_id is null
        and attachment.uploader_id = p_requester_id
        and (attachment.expires_at is null or attachment.expires_at > now())
      for update
    ) as locked_attachments;

    if v_attachment_count <> v_requested_attachment_count then
      raise exception 'support_ticket_attachment_not_ready' using errcode = '42501';
    end if;
  end if;

  insert into public.support_tickets (
    requester_id,
    category,
    subject,
    verification_status,
    target_platform,
    target_nickname,
    target_account_id,
    target_resolved_nickname,
    target_resolved_at
  ) values (
    p_requester_id,
    p_category,
    trim(p_subject),
    p_verification_status,
    nullif(trim(p_target_platform), ''),
    nullif(trim(p_target_nickname), ''),
    nullif(trim(p_target_account_id), ''),
    nullif(trim(p_target_resolved_nickname), ''),
    case when p_category = 'privacy' then now() else null end
  ) returning id into v_ticket_id;

  insert into public.support_messages (ticket_id, sender_id, sender_type, body)
  values (v_ticket_id, p_requester_id, 'user', trim(p_body))
  returning id into v_message_id;

  if v_requested_attachment_count > 0 then
    update public.support_attachments
    set ticket_id = v_ticket_id,
        message_id = v_message_id,
        expires_at = null
    where id = any(p_attachment_ids)
      and status = 'ready'
      and ticket_id is null
      and uploader_id = p_requester_id;

    insert into public.support_ticket_events (ticket_id, actor_id, event_type, metadata)
    select v_ticket_id, p_requester_id, 'attachment_added', jsonb_build_object('attachment_id', attachment.id)
    from public.support_attachments as attachment
    where attachment.ticket_id = v_ticket_id
      and attachment.message_id = v_message_id;
  end if;

  insert into public.support_ticket_events (ticket_id, actor_id, event_type, to_status)
  values (v_ticket_id, p_requester_id, 'created', 'new');

  return v_ticket_id;
exception
  when unique_violation then
    raise exception 'support_ticket_duplicate' using errcode = '23505';
end;
$$;

revoke all on function public.create_support_ticket(uuid, text, text, text, text, text, text, text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.create_support_ticket(uuid, text, text, text, text, text, text, text, text, uuid[])
  to service_role;

revoke all on function public.set_support_updated_at() from public, anon, authenticated;
grant execute on function public.set_support_updated_at() to service_role;

alter table public.support_faqs enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_attachments enable row level security;
alter table public.support_ticket_events enable row level security;

drop policy if exists support_faqs_public_select on public.support_faqs;
create policy support_faqs_public_select on public.support_faqs
for select to anon, authenticated
using (is_published = true);

drop policy if exists support_faqs_admin_all on public.support_faqs;
create policy support_faqs_admin_all on public.support_faqs
for all to authenticated
using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists support_tickets_actor_select on public.support_tickets;
create policy support_tickets_actor_select on public.support_tickets
for select to authenticated
using (
  requester_id = auth.uid()
  or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

drop policy if exists support_tickets_owner_insert on public.support_tickets;
create policy support_tickets_owner_insert on public.support_tickets
for insert to authenticated
with check (requester_id = auth.uid());

drop policy if exists support_messages_actor_select on public.support_messages;
create policy support_messages_actor_select on public.support_messages
for select to authenticated
using (
  exists (
    select 1 from public.support_tickets ticket
    where ticket.id = support_messages.ticket_id
      and (
        ticket.requester_id = auth.uid()
        or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
      )
  )
);

drop policy if exists support_attachments_actor_select on public.support_attachments;
create policy support_attachments_actor_select on public.support_attachments
for select to authenticated
using (
  uploader_id = auth.uid()
  or exists (
    select 1 from public.support_tickets ticket
    where ticket.id = support_attachments.ticket_id and ticket.requester_id = auth.uid()
  )
  or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

drop policy if exists support_ticket_events_admin_select on public.support_ticket_events;
create policy support_ticket_events_admin_select on public.support_ticket_events
for select to authenticated
using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

revoke all on public.support_faqs, public.support_tickets, public.support_messages,
  public.support_attachments, public.support_ticket_events
  from anon, authenticated;
grant select on public.support_faqs to anon, authenticated;
grant select on public.support_tickets, public.support_messages, public.support_attachments,
  public.support_ticket_events to authenticated;
grant all on public.support_faqs, public.support_tickets, public.support_messages,
  public.support_attachments, public.support_ticket_events to service_role;

insert into public.support_faqs (category, question, answer, sort_order, is_published)
values
  ('stats', '전적 비공개 요청은 어디에서 하나요?', '로그인 후 고객센터에서 1:1 문의를 열고 전적 비공개 요청 유형을 선택해 주세요.', 10, true),
  ('stats', '비공개 요청에 어떤 증빙이 필요한가요?', '게임 내 프로필 또는 최근 전적 화면에서 닉네임과 플랫폼이 보이는 PNG, JPEG, WebP 스크린샷이 최소 1장 필요합니다.', 20, true),
  ('stats', '비공개 처리까지 얼마나 걸리나요?', '관리자가 증빙과 PUBG 대상 정보를 확인한 뒤 처리합니다. 추가 확인이 필요하면 같은 문의로 안내합니다.', 30, true),
  ('stats', '닉네임을 바꾸면 비공개 상태가 유지되나요?', '비공개 목록은 닉네임이 아니라 서버에서 확인한 PUBG account_id를 기준으로 처리합니다.', 40, true),
  ('account', '계정·커뮤니티 문의는 어디로 보내나요?', '고객센터의 1:1 문의에서 계정, 커뮤니티, 오류 또는 기타 유형을 선택해 보내 주세요.', 50, true)
on conflict (category, question) do update set
  answer = excluded.answer,
  sort_order = excluded.sort_order,
  is_published = excluded.is_published,
  updated_at = now();
