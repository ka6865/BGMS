begin;
set local lock_timeout = '2s';

-- 사용자가 올린 증바람 조합 제보와 질문. 챔피언이 없으면 공용 글이다.
-- 질문은 관련 증강 없이도 올릴 수 있고, 조합 제보는 증강이 1개 이상 있어야 한다.
-- 쓰기와 조회는 서버(service role)만 하고, 공개 화면에는 published 행만 내보낸다.
create table public.lol_mayhem_combo_tips (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_patch text not null check (client_patch ~ '^[0-9]{2}\.[0-9]{1,2}$'),
  kind text not null default 'tip' check (kind in ('tip', 'question')),
  champion_id integer check (champion_id between 1 and 100000),
  augment_ids integer[] not null check (cardinality(augment_ids) <= 6 and array_position(augment_ids, null) is null and (kind = 'question' or cardinality(augment_ids) >= 1)),
  item_ids integer[] not null default '{}' check (cardinality(item_ids) <= 6 and array_position(item_ids, null) is null),
  summary text not null check (length(btrim(summary)) between 2 and 60),
  usage text not null default '' check (length(usage) <= 1000),
  anonymous boolean not null default false,
  status text not null default 'published' check (status in ('published', 'hidden')),
  up_count integer not null default 0 check (up_count >= 0),
  down_count integer not null default 0 check (down_count >= 0),
  score integer generated always as (up_count - down_count) stored,
  comment_count integer not null default 0 check (comment_count >= 0),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz
);

create index lol_mayhem_combo_tips_recent_idx on public.lol_mayhem_combo_tips (client_patch, created_at desc) where status = 'published';
create index lol_mayhem_combo_tips_top_idx on public.lol_mayhem_combo_tips (client_patch, score desc, created_at desc) where status = 'published';
create index lol_mayhem_combo_tips_user_idx on public.lol_mayhem_combo_tips (user_id, created_at desc);

-- 댓글과 답글. 답글은 한 단계만 두고, 답글이 달린 댓글은 지워도 자리(deleted)를 남긴다.
create table public.lol_mayhem_combo_tip_comments (
  id bigint generated always as identity primary key,
  tip_id bigint not null references public.lol_mayhem_combo_tips(id) on delete cascade,
  parent_id bigint references public.lol_mayhem_combo_tip_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 500),
  anonymous boolean not null default false,
  status text not null default 'published' check (status in ('published', 'deleted', 'hidden')),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
create index lol_mayhem_combo_tip_comments_tip_idx on public.lol_mayhem_combo_tip_comments (tip_id, created_at);
create index lol_mayhem_combo_tip_comments_parent_idx on public.lol_mayhem_combo_tip_comments (parent_id) where parent_id is not null;
create index lol_mayhem_combo_tip_comments_user_idx on public.lol_mayhem_combo_tip_comments (user_id, created_at desc);

-- 목록에 보여 줄 댓글 수를 댓글이 바뀔 때마다 다시 센다.
create function public.refresh_lol_mayhem_combo_tip_comment_count()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tip_id bigint := coalesce(new.tip_id, old.tip_id);
begin
  update public.lol_mayhem_combo_tips t
  set comment_count = (select count(*) from public.lol_mayhem_combo_tip_comments c where c.tip_id = v_tip_id and c.status = 'published')
  where t.id = v_tip_id;
  return null;
end;
$$;
revoke all on function public.refresh_lol_mayhem_combo_tip_comment_count() from public, anon, authenticated;
create trigger lol_mayhem_combo_tip_comment_count
after insert or delete or update of status on public.lol_mayhem_combo_tip_comments
for each row execute function public.refresh_lol_mayhem_combo_tip_comment_count();

-- 1인 1표. 제보가 지워지거나 탈퇴하면 표도 함께 지운다.
create table public.lol_mayhem_combo_tip_votes (
  tip_id bigint not null references public.lol_mayhem_combo_tips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (tip_id, user_id)
);
create index lol_mayhem_combo_tip_votes_user_idx on public.lol_mayhem_combo_tip_votes (user_id);

alter table public.lol_mayhem_combo_tips enable row level security;
alter table public.lol_mayhem_combo_tip_votes enable row level security;
alter table public.lol_mayhem_combo_tip_comments enable row level security;
revoke all on table public.lol_mayhem_combo_tips, public.lol_mayhem_combo_tip_votes, public.lol_mayhem_combo_tip_comments from anon, authenticated;
grant select, insert, update, delete on table public.lol_mayhem_combo_tips, public.lol_mayhem_combo_tip_votes, public.lol_mayhem_combo_tip_comments to service_role;

-- 표를 바꾸고 제보의 추천·비추천 수를 같은 트랜잭션에서 다시 센다. p_value 0은 표 취소다.
create function public.vote_lol_mayhem_combo_tip(p_tip_id bigint, p_user_id uuid, p_value smallint)
returns table (up_count integer, down_count integer)
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_value not in (-1, 0, 1) then
    raise exception 'invalid_vote' using errcode = '22023';
  end if;
  select t.user_id into v_owner from public.lol_mayhem_combo_tips t where t.id = p_tip_id and t.status = 'published' for update;
  if not found then
    raise exception 'tip_not_found' using errcode = 'P0002';
  end if;
  if v_owner = p_user_id then
    raise exception 'own_tip' using errcode = '42501';
  end if;
  if p_value = 0 then
    delete from public.lol_mayhem_combo_tip_votes v where v.tip_id = p_tip_id and v.user_id = p_user_id;
  else
    insert into public.lol_mayhem_combo_tip_votes (tip_id, user_id, value) values (p_tip_id, p_user_id, p_value)
    on conflict (tip_id, user_id) do update set value = excluded.value;
  end if;
  return query
  update public.lol_mayhem_combo_tips t set
    up_count = (select count(*) from public.lol_mayhem_combo_tip_votes v where v.tip_id = p_tip_id and v.value = 1),
    down_count = (select count(*) from public.lol_mayhem_combo_tip_votes v where v.tip_id = p_tip_id and v.value = -1)
  where t.id = p_tip_id
  returning t.up_count, t.down_count;
end;
$$;

revoke all on function public.vote_lol_mayhem_combo_tip(bigint, uuid, smallint) from public, anon, authenticated;
grant execute on function public.vote_lol_mayhem_combo_tip(bigint, uuid, smallint) to service_role;

commit;
