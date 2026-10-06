-- A bounded global scan resumes after its last inspected match, including protected rows.
-- Exhausting the scan resets it so incomplete snapshots are reconsidered later.
create table public.pubg_archive_cleanup_cursor (
  id integer primary key check (id=1),
  played_at timestamptz,
  platform text check (platform in ('steam','kakao')),
  match_id text,
  generation bigint not null default 0,
  updated_at timestamptz not null default now(),
  check ((played_at is null and platform is null and match_id is null)
    or (played_at is not null and platform is not null and match_id is not null and match_id ~ '^[A-Za-z0-9_-]{1,128}$'))
);
insert into public.pubg_archive_cleanup_cursor(id) values(1);
alter table public.pubg_archive_cleanup_cursor enable row level security;
revoke all on public.pubg_archive_cleanup_cursor from public,anon,authenticated;
grant select,update on public.pubg_archive_cleanup_cursor to service_role;
