-- 게시글 조회수 증가 경로를 서버 전용으로 닫는다.
--
-- increment_views 는 anon 도 실행할 수 있는 SECURITY DEFINER 함수로, 호출할 때마다
-- views + 1 만 수행해 PostgREST 직접 호출로 조회수를 무제한 올릴 수 있었다.
--
-- - 웹은 /api/board/posts/[postId]/views 가 service role 로 increment_board_post_views 를 호출한다.
-- - 같은 게시글·같은 IP 해시는 1시간에 한 번만 센다. 게시글 행을 잠근 뒤 기록을 넣고,
--   기록이 새로 들어가거나 1시간이 지나 갱신된 경우에만 조회수를 올린다.
-- - 공개(status = 'published') 게시글만 센다.
-- - 기록은 그 게시글을 셀 때 하루가 지난 것부터 지운다.
-- - increment_views 의 anon·authenticated 실행 권한을 회수한다.
--
-- 배포 순서: 조회수를 API route 로 옮긴 앱 배포가 끝난 뒤 적용한다.
-- 재실행해도 결과가 같다.

set lock_timeout = '3s';
set statement_timeout = '30s';

create table if not exists public.board_post_view_tracking (
  post_id bigint not null references public.posts(id) on delete cascade,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  last_viewed_at timestamptz not null default now(),
  primary key (post_id, ip_hash)
);

alter table public.board_post_view_tracking enable row level security;
create index if not exists board_post_view_tracking_viewed_at_idx
  on public.board_post_view_tracking (post_id, last_viewed_at);

revoke all on table public.board_post_view_tracking from public, anon, authenticated;
grant select, insert, update, delete on table public.board_post_view_tracking to service_role;

create or replace function public.increment_board_post_views(
  p_post_id bigint,
  p_ip_hash text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_views bigint;
  v_counted boolean;
begin
  if p_post_id is null or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'post ID and IP hash are required';
  end if;

  -- 같은 게시글의 조회 처리를 직렬화하고 공개 글만 받는다.
  select post_row.views
  into v_views
  from public.posts as post_row
  where post_row.id = p_post_id
    and post_row.status = 'published'
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found', 'views', null);
  end if;

  insert into public.board_post_view_tracking as tracking (post_id, ip_hash, last_viewed_at)
  values (p_post_id, p_ip_hash, now())
  on conflict (post_id, ip_hash) do update
    set last_viewed_at = excluded.last_viewed_at
    where tracking.last_viewed_at <= now() - interval '1 hour'
  returning true into v_counted;

  if not coalesce(v_counted, false) then
    return jsonb_build_object('status', 'already_counted', 'views', coalesce(v_views, 0));
  end if;

  update public.posts as post_row
  set views = coalesce(post_row.views, 0) + 1
  where post_row.id = p_post_id
  returning post_row.views into v_views;

  delete from public.board_post_view_tracking as tracking
  where tracking.post_id = p_post_id
    and tracking.last_viewed_at < now() - interval '1 day';

  return jsonb_build_object('status', 'counted', 'views', v_views);
end;
$$;

revoke all on function public.increment_board_post_views(bigint, text) from public, anon, authenticated;
grant execute on function public.increment_board_post_views(bigint, text) to service_role;

do $$
begin
  if to_regprocedure('public.increment_views(integer)') is not null then
    revoke execute on function public.increment_views(integer) from public, anon, authenticated;
    grant execute on function public.increment_views(integer) to service_role;
  end if;
end;
$$;

reset lock_timeout;
reset statement_timeout;
