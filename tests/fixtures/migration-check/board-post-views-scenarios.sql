-- Runs only in the verifier's disposable PostgreSQL database.
begin;
do $$
declare
  result jsonb;
  hash_a text := repeat('a', 64);
  hash_b text := repeat('b', 64);
begin
  if has_function_privilege('anon','public.increment_board_post_views(bigint,text)','EXECUTE')
    or has_function_privilege('authenticated','public.increment_board_post_views(bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.increment_board_post_views(bigint,text)','EXECUTE')
    or exists(select from pg_proc where oid='public.increment_board_post_views(bigint,text)'::regprocedure and prosecdef)
    or not exists(select from pg_proc where oid='public.increment_board_post_views(bigint,text)'::regprocedure
      and array_position(proconfig, 'search_path=""') is not null) then
    raise exception 'view RPC must be service-only, invoker, and use an empty search path';
  end if;
  if has_table_privilege('anon','public.board_post_view_tracking','SELECT')
    or has_table_privilege('authenticated','public.board_post_view_tracking','INSERT') then
    raise exception 'view tracking table must be service-only';
  end if;
  if has_function_privilege('anon','public.increment_views(integer)','EXECUTE')
    or has_function_privilege('authenticated','public.increment_views(integer)','EXECUTE')
    or not has_function_privilege('service_role','public.increment_views(integer)','EXECUTE') then
    raise exception 'increment_views must be executable by service_role only';
  end if;

  insert into public.posts(id,title,status,views) values (920001,'Published view fixture','published',10);
  insert into public.posts(id,title,status,views) values (920002,'Draft view fixture','draft',3);
  execute 'set local role service_role';

  result := public.increment_board_post_views(920001, hash_a);
  if result->>'status' <> 'counted' or (result->>'views')::bigint <> 11 then
    raise exception 'first view should be counted once: %', result;
  end if;

  result := public.increment_board_post_views(920001, hash_a);
  if result->>'status' <> 'already_counted' or (result->>'views')::bigint <> 11 then
    raise exception 'repeat view within the window must not count: %', result;
  end if;

  result := public.increment_board_post_views(920001, hash_b);
  if result->>'status' <> 'counted' or (result->>'views')::bigint <> 12 then
    raise exception 'another client should be counted: %', result;
  end if;

  result := public.increment_board_post_views(920002, hash_a);
  if result->>'status' <> 'not_found' then
    raise exception 'draft post must not be counted: %', result;
  end if;

  result := public.increment_board_post_views(999999, hash_a);
  if result->>'status' <> 'not_found' then
    raise exception 'missing post must not be counted: %', result;
  end if;

  execute 'reset role';

  -- 1시간이 지난 기록은 다시 세고, 하루가 지난 다른 기록은 정리한다.
  update public.board_post_view_tracking set last_viewed_at = now() - interval '2 hours'
  where post_id = 920001 and ip_hash = hash_a;
  insert into public.board_post_view_tracking(post_id, ip_hash, last_viewed_at)
  values (920001, repeat('c', 64), now() - interval '2 days');
  execute 'set local role service_role';
  result := public.increment_board_post_views(920001, hash_a);
  if result->>'status' <> 'counted' or (result->>'views')::bigint <> 13 then
    raise exception 'view after the window should count again: %', result;
  end if;
  execute 'reset role';
  if exists(select from public.board_post_view_tracking where post_id = 920001 and ip_hash = repeat('c', 64)) then
    raise exception 'tracking rows older than a day must be removed';
  end if;
  if (select views from public.posts where id = 920002) <> 3 then
    raise exception 'draft view count must not change';
  end if;

  begin
    perform public.increment_board_post_views(920001, 'not-a-hash');
    raise exception 'invalid hash accepted';
  exception when raise_exception then
    if sqlerrm = 'invalid hash accepted' then raise; end if;
  end;
end;
$$;
rollback;
