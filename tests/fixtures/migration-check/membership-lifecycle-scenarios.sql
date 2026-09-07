-- user_lifecycle_events RPC 검증. verify_migrations_local.sh의 격리 DB에서만 실행한다.
truncate table public.user_lifecycle_events;
update public.user_lifecycle_capture_meta
set started_at = '2026-09-01 00:00:00+09';

insert into public.user_lifecycle_events (event_type, occurred_at)
values
  ('signup', '2026-09-01 01:00:00+09'),
  ('signup', '2026-09-03 00:10:00+09'),
  ('signup', '2026-09-03 01:00:00+09'),
  ('signup', '2026-09-06 01:00:00+09'),
  ('deletion', '2026-09-06 02:00:00+09');

-- Optional GoTrue soft-delete followed by hard delete must emit one deletion.
insert into auth.users (created_at) values ('2026-09-02 01:00:00+09') returning id \gset lifecycle_
update auth.users set deleted_at = '2026-09-06 03:00:00+09' where id = :'lifecycle_id';
delete from auth.users where id = :'lifecycle_id';

do $$
declare
  row_count integer;
  observed_signups bigint;
  observed_deletions bigint;
begin
  select count(*) into row_count
  from public.get_user_lifecycle_daily(7, '2026-09-07 12:00:00+09');
  if row_count <> 7 then raise exception 'FAIL: lifecycle RPC returned % rows', row_count; end if;

  select daily.signups, daily.deletions
  into observed_signups, observed_deletions
  from public.get_user_lifecycle_daily(7, '2026-09-07 12:00:00+09') daily
  where daily.event_date = '2026-09-06';
  if observed_signups <> 1 or observed_deletions <> 1 then
    raise exception 'FAIL: lifecycle KST grouping signup=% deletion=%', observed_signups, observed_deletions;
  end if;
  select daily.signups into observed_signups
  from public.get_user_lifecycle_daily(7, '2026-09-07 12:00:00+09') daily
  where daily.event_date = '2026-09-03';
  if observed_signups <> 2 then
    raise exception 'FAIL: lifecycle lower-bound early-day signup count=%', observed_signups;
  end if;
  select daily.signups into observed_signups
  from public.get_user_lifecycle_daily(7, '2026-09-07 12:00:00+09') daily
  where daily.event_date = '2026-09-01';
  if observed_signups <> 1 then
    raise exception 'FAIL: lifecycle KST midnight lower bound signup count=%', observed_signups;
  end if;
  select count(*) into row_count
  from public.user_lifecycle_events
  where event_type = 'deletion';
  if row_count <> 2 then raise exception 'FAIL: soft-delete/hard-delete duplicate handling count=%', row_count; end if;
  raise notice 'PASS: lifecycle RPC KST daily grouping and bounded row count';
end $$;
