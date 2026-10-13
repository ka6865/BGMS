-- 게시글 조회수 증가 경로를 보호한다.
--
-- increment_views 는 사용자 확인 없이 views + 1 만 수행하므로 anon 과
-- authenticated 실행 권한을 회수한다.
--
-- 웹과 모바일 모두 increment_board_post_views 원자 RPC(service role 전용)를
-- 거친다. 이 함수는 IP 해시와 post ID 조합으로 최근 1시간 내 중복 증가를
-- 방지한다. 비공개 글은 제외된다.
--
-- 배포 순서: 조회수를 API route 로 옮긴 앱 배포가 먼저 끝난 뒤 적용한다.
-- 재실행해도 결과가 같다.

set lock_timeout = '3s';
set statement_timeout = '30s';

-- 게시글 조회 추적 테이블 (IP 해시 기반 중복 방지)
create table if not exists public.board_post_view_tracking (
  post_id integer not null,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  last_viewed_at timestamptz not null default statement_timestamp(),
  primary key (post_id, ip_hash)
);

alter table public.board_post_view_tracking enable row level security;
create index if not exists board_post_view_tracking_cleanup_idx
  on public.board_post_view_tracking (last_viewed_at);

revoke all on table public.board_post_view_tracking from public, anon, authenticated;
grant select, insert, update on table public.board_post_view_tracking to service_role;

-- 조회수 증가 RPC (IP 기반 중복 방지, 비공개 글 제외)
create or replace function public.increment_board_post_views(
  p_post_id integer,
  p_ip_hash text
)
returns json
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_published boolean;
  v_views bigint;
  v_last_viewed_at timestamptz;
  v_view_window_minutes constant integer := 60;
begin
  -- 게시글 존재 및 published 여부 확인
  select is_published into v_published
    from public.posts
    where id = p_post_id;

  if v_published is null then
    return json_build_object('status', 'not_found');
  end if;

  -- 비공개 글은 조회수 증가 안 함
  if not v_published then
    return json_build_object('status', 'not_found');
  end if;

  -- 최근 조회 기록 확인 (IP 해시와 post ID 조합)
  select last_viewed_at into v_last_viewed_at
    from public.board_post_view_tracking
    where post_id = p_post_id
      and ip_hash = p_ip_hash
      and last_viewed_at > now() - make_interval(mins => v_view_window_minutes);

  -- 최근에 이미 조회했으면 증가 안 함, 현재 조회수만 반환
  if v_last_viewed_at is not null then
    select views into v_views
      from public.posts
      where id = p_post_id;
    return json_build_object(
      'status', 'incremented',
      'views', coalesce(v_views, 0)
    );
  end if;

  -- 조회수 증가 (원자 작업)
  update public.posts
    set views = views + 1
    where id = p_post_id
    returning views into v_views;

  -- 조회 기록 생성 또는 갱신
  insert into public.board_post_view_tracking (post_id, ip_hash, last_viewed_at)
    values (p_post_id, p_ip_hash, now())
    on conflict (post_id, ip_hash)
    do update set last_viewed_at = now();

  return json_build_object(
    'status', 'incremented',
    'views', coalesce(v_views, 0)
  );
end;
$$;

-- increment_views 의 public 실행 권한 회수
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
