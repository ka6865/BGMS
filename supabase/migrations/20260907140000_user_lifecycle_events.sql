-- 관리자 회원 증감 그래프를 위한 최소 수명주기 이벤트.
-- 운영 DB에는 자동 적용하지 않고 검토 후 배포한다.
-- user_id/email/profile 내용은 저장하지 않으며 가입·탈퇴 시각과 종류만 남긴다.

create table if not exists public.user_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('signup', 'deletion')),
  occurred_at timestamptz not null default now()
);

create index if not exists user_lifecycle_events_occurred_at_idx
  on public.user_lifecycle_events (occurred_at desc, event_type);

-- 최초 이벤트 시각은 지연될 수 있으므로 migration 적용 시각을 별도 기록한다.
create table if not exists public.user_lifecycle_capture_meta (
  id boolean primary key default true check (id),
  started_at timestamptz not null default now()
);

insert into public.user_lifecycle_capture_meta (id)
values (true)
on conflict (id) do nothing;

create index if not exists user_lifecycle_capture_meta_started_at_idx
  on public.user_lifecycle_capture_meta (started_at);

alter table public.user_lifecycle_events enable row level security;
alter table public.user_lifecycle_capture_meta enable row level security;
revoke all on table public.user_lifecycle_events, public.user_lifecycle_capture_meta from anon, authenticated;
grant select on table public.user_lifecycle_events, public.user_lifecycle_capture_meta to service_role;

create or replace function public.record_user_lifecycle_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.user_lifecycle_events (event_type, occurred_at)
    values ('signup', now());
    return new;
  end if;

  -- GoTrue versions with deleted_at represent a soft-delete as UPDATE.
  -- to_jsonb keeps this migration compatible with older local stubs without that column.
  if tg_op = 'UPDATE' then
    if nullif(to_jsonb(new)->>'deleted_at', '') is not null
      and nullif(to_jsonb(old)->>'deleted_at', '') is null then
      insert into public.user_lifecycle_events (event_type, occurred_at)
      values ('deletion', now());
    end if;
    return new;
  end if;

  -- A later hard delete of an already soft-deleted row must not double count.
  if nullif(to_jsonb(old)->>'deleted_at', '') is not null then
    return old;
  end if;

  insert into public.user_lifecycle_events (event_type, occurred_at)
  values ('deletion', now());
  return old;
end;
$$;

revoke all on function public.record_user_lifecycle_event() from public, anon, authenticated;

create or replace function public.get_user_lifecycle_daily(
  p_window_days integer,
  p_window_end timestamptz default now()
)
returns table (
  event_date date,
  signups bigint,
  deletions bigint,
  collection_started_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end timestamptz := least(coalesce(p_window_end, now()), now());
  v_start timestamptz;
begin
  if p_window_days not in (7, 30, 90) then
    raise exception 'window_days must be 7, 30, or 90';
  end if;
  -- Align the lower bound to KST midnight so early-day events are included.
  v_start := (((v_end at time zone 'Asia/Seoul')::date - (p_window_days - 1))::timestamp at time zone 'Asia/Seoul');

  return query
  with days as (
    select generate_series(
      (v_start at time zone 'Asia/Seoul')::date,
      (v_end at time zone 'Asia/Seoul')::date,
      interval '1 day'
    )::date as event_date
  ), grouped as (
    select
      (event.occurred_at at time zone 'Asia/Seoul')::date as event_date,
      count(*) filter (where event.event_type = 'signup')::bigint as signups,
      count(*) filter (where event.event_type = 'deletion')::bigint as deletions
    from public.user_lifecycle_events event
    where event.occurred_at >= v_start and event.occurred_at <= v_end
    group by 1
  )
  select days.event_date,
    coalesce(grouped.signups, 0)::bigint,
    coalesce(grouped.deletions, 0)::bigint,
    meta.started_at
  from days
  cross join public.user_lifecycle_capture_meta meta
  left join grouped using (event_date)
  order by days.event_date;
end;
$$;

revoke all on function public.get_user_lifecycle_daily(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.get_user_lifecycle_daily(integer, timestamptz) to service_role;

drop trigger if exists on_auth_user_lifecycle_recorded on auth.users;
create trigger on_auth_user_lifecycle_recorded
  after insert or update or delete on auth.users
  for each row execute function public.record_user_lifecycle_event();
