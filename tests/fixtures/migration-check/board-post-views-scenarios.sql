-- Runs only in the verifier's disposable PostgreSQL database.
-- Tests increment_board_post_views RPC function and board_post_view_tracking table.
begin;

do $$
declare
  v_published_post_id bigint;
  v_unpublished_post_id bigint;
  v_result jsonb;
  v_ip_hash_1 text := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  v_ip_hash_2 text := 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
begin
  -- 공개 및 비공개 게시글 생성
  insert into public.posts(title, content, is_published, views)
    values ('published post', 'content', true, 0)
    returning id into v_published_post_id;

  insert into public.posts(title, content, is_published, views)
    values ('unpublished post', 'content', false, 0)
    returning id into v_unpublished_post_id;

  -- 공개 게시글의 조회수 증가 (첫 IP)
  select increment_board_post_views(v_published_post_id, v_ip_hash_1) into v_result;
  if v_result->>'status' != 'incremented' or (v_result->>'views')::bigint != 1 then
    raise exception 'first view increment for published post should succeed: %', v_result;
  end if;

  -- 같은 IP가 1시간 내에 다시 조회 (중복 방지)
  select increment_board_post_views(v_published_post_id, v_ip_hash_1) into v_result;
  if v_result->>'status' != 'incremented' or (v_result->>'views')::bigint != 1 then
    raise exception 'duplicate view within window should not increment: %', v_result;
  end if;

  -- 다른 IP가 조회 (증가)
  select increment_board_post_views(v_published_post_id, v_ip_hash_2) into v_result;
  if v_result->>'status' != 'incremented' or (v_result->>'views')::bigint != 2 then
    raise exception 'different IP should increment views: %', v_result;
  end if;

  -- 비공개 게시글은 조회수가 증가하지 않음
  select increment_board_post_views(v_unpublished_post_id, v_ip_hash_1) into v_result;
  if v_result->>'status' != 'not_found' then
    raise exception 'unpublished post should not be found: %', v_result;
  end if;

  -- 존재하지 않는 게시글
  select increment_board_post_views(999999, v_ip_hash_1) into v_result;
  if v_result->>'status' != 'not_found' then
    raise exception 'nonexistent post should not be found: %', v_result;
  end if;

  -- board_post_view_tracking 테이블 검증: 정확히 2개 행 (IP 2개, 각각 1회)
  if (select count(*) from public.board_post_view_tracking where post_id = v_published_post_id) != 2 then
    raise exception 'view tracking should have exactly 2 entries (2 IPs)';
  end if;
end;
$$;

-- service_role만 increment_board_post_views를 직접 호출할 수 있음
do $$
declare
  v_result jsonb;
  v_ip_hash text := 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
begin
  insert into public.posts(title, content, is_published, views)
    values ('test post', 'content', true, 0);

  execute 'set local role anon';
  begin
    select increment_board_post_views(1, v_ip_hash) into v_result;
    raise exception 'anon role should not be able to execute increment_board_post_views';
  exception when insufficient_privilege then
    null; -- expected
  end;
  execute 'reset role';
end;
$$;

-- board_post_view_tracking 테이블 권한 검증
do $$
begin
  if has_table_privilege('anon','public.board_post_view_tracking','INSERT')
    or has_table_privilege('authenticated','public.board_post_view_tracking','INSERT') then
    raise exception 'anon and authenticated must not insert into board_post_view_tracking';
  end if;
  if not has_table_privilege('service_role','public.board_post_view_tracking','INSERT') then
    raise exception 'service role must keep insert access on board_post_view_tracking';
  end if;
end;
$$;

rollback;
