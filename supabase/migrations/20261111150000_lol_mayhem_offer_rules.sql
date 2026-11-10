begin;
set local lock_timeout = '2s';

-- 증강이 제시되지 않는 조건. Riot이 데이터로 주지 않아 관리자가 정리하고, 패치노트에서 찾은 문장은 후보(candidate)로 쌓는다.
-- random_excluded: 전환·판도라의 상자·나는 왕이다가 무작위로 주는 증강에서 빠지는 증강. condition: 그 밖의 제시 조건 문장.
-- verified=false는 Riot 원문으로 확인하지 못한 정보라 화면에 "확인 필요"로 표시한다.
create table public.lol_mayhem_offer_rules (
  id bigint generated always as identity primary key,
  augment_id integer check (augment_id between 1 and 1000000),
  kind text not null check (kind in ('random_excluded', 'condition')),
  text text not null default '' check (length(text) <= 300),
  patch text check (patch ~ '^[0-9]{2}\.[0-9]{1,2}$'),
  verified boolean not null default false,
  status text not null default 'active' check (status in ('candidate', 'active', 'rejected')),
  source_quote text check (length(source_quote) <= 1000),
  source_url text check (length(source_url) <= 500 and source_url ~ '^https://'),
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz,
  -- 공개되는 규칙은 대상 증강과, 조건이면 문장이 있어야 한다.
  check (status <> 'active' or (augment_id is not null and (kind = 'random_excluded' or length(btrim(text)) > 0)))
);

-- 같은 패치노트 문장은 후보로 한 번만 쌓는다. 수집 작업이 on conflict로 쓰도록 부분 인덱스가 아닌 일반 인덱스로 둔다.
create unique index lol_mayhem_offer_rules_quote_idx on public.lol_mayhem_offer_rules (source_quote);
create unique index lol_mayhem_offer_rules_random_idx on public.lol_mayhem_offer_rules (augment_id) where kind = 'random_excluded' and status = 'active';
create index lol_mayhem_offer_rules_status_idx on public.lol_mayhem_offer_rules (status, created_at desc);

alter table public.lol_mayhem_offer_rules enable row level security;
revoke all on table public.lol_mayhem_offer_rules from anon, authenticated;
grant select, insert, update, delete on table public.lol_mayhem_offer_rules to service_role;

-- 2026-11-11에 정리한 첫 자료. 모두 Riot 원문으로 확인하지 못한 정보다.
insert into public.lol_mayhem_offer_rules (augment_id, kind, text, patch) values
  (1205, 'random_excluded', '', '26.18'),
  (1004, 'random_excluded', '', '26.18'),
  (1134, 'random_excluded', '', '26.18'),
  (1206, 'random_excluded', '', '26.18'),
  (1311, 'random_excluded', '', '26.18'),
  (2018, 'random_excluded', '', '26.18'),
  (1134, 'condition', '루난의 허리케인을 가지고 있으면 제시되지 않습니다.', '26.17'),
  (1004, 'condition', '궁극기로 모습을 바꾸는 제이스·니달리·엘리스에게는 제시되지 않습니다.', null),
  (1243, 'condition', '펜타킬 헤드라이너 게임에서는 등장하지 않습니다.', '26.21'),
  (1337, 'condition', '펜타킬 헤드라이너 게임에서는 등장하지 않습니다.', '26.21');

commit;
