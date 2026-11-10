begin;
set local lock_timeout = '2s';

-- 사용자가 제보한 증바람 조합. 챔피언이 없으면 공용 조합이다.
-- 쓰기와 조회는 서버(service role)만 하고, 공개 화면에는 published 행만 내보낸다.
create table public.lol_mayhem_combo_tips (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_patch text not null check (client_patch ~ '^[0-9]{2}\.[0-9]{1,2}$'),
  champion_id integer check (champion_id between 1 and 100000),
  augment_ids integer[] not null check (cardinality(augment_ids) between 1 and 6 and array_position(augment_ids, null) is null),
  item_ids integer[] not null default '{}' check (cardinality(item_ids) <= 6 and array_position(item_ids, null) is null),
  summary text not null check (length(btrim(summary)) between 2 and 60),
  usage text not null default '' check (length(usage) <= 1000),
  status text not null default 'published' check (status in ('published', 'hidden')),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index lol_mayhem_combo_tips_public_idx on public.lol_mayhem_combo_tips (client_patch, created_at desc) where status = 'published';
create index lol_mayhem_combo_tips_user_idx on public.lol_mayhem_combo_tips (user_id, created_at desc);

alter table public.lol_mayhem_combo_tips enable row level security;
revoke all on table public.lol_mayhem_combo_tips from anon, authenticated;
grant select, insert, update, delete on table public.lol_mayhem_combo_tips to service_role;

commit;
