-- 관리자 감사 로그: 회원 삭제·권한 변경, 게시글 강제 삭제, 신고 처리, 제보 승인·파기,
-- 무기 패치 반영·되돌리기, 비공개 플레이어 변경, 고객지원 개인정보 처리 같은 관리자 조작을 남긴다.
-- 서버(service role)만 쓰고 읽는다. RLS 를 켜고 정책을 두지 않으며 클라이언트 권한을 회수한다.
-- actor_id 는 auth.users 를 참조하지 않는다. 관리자 계정이 삭제되어도 감사 기록이 남아야 하기 때문이다.
begin;
set local lock_timeout = '2s';

create table if not exists public.admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null check (length(btrim(action)) between 1 and 128),
  target_type text check (target_type is null or length(target_type) <= 64),
  target_id text check (target_id is null or length(target_id) <= 256),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_events_created_at_idx
  on public.admin_audit_events (created_at desc);

create index if not exists admin_audit_events_target_idx
  on public.admin_audit_events (target_type, target_id, created_at desc);

alter table public.admin_audit_events enable row level security;

revoke all on table public.admin_audit_events from public, anon, authenticated;
grant all on table public.admin_audit_events to service_role;

comment on table public.admin_audit_events is
  'Admin action audit trail. Service role only (RLS enabled, no policies). Written by lib/server/adminAudit.ts.';
comment on column public.admin_audit_events.actor_id is
  'Admin auth user id at the time of the action. Intentionally not a foreign key so records survive account deletion.';
comment on column public.admin_audit_events.detail is
  'Action-specific context. Must not contain secrets, tokens, or email addresses.';

commit;
