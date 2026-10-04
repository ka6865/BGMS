-- Runs only in the verifier's disposable PostgreSQL database.
begin;
do $$
declare result jsonb; failed boolean := false;
begin
  if has_function_privilege('anon','public.recommend_mobile_board_post(bigint,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.recommend_mobile_board_post(bigint,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.recommend_mobile_board_post(bigint,uuid)','EXECUTE')
    or exists(select from pg_proc where oid='public.recommend_mobile_board_post(bigint,uuid)'::regprocedure and prosecdef)
    or not exists(select from pg_proc where oid='public.recommend_mobile_board_post(bigint,uuid)'::regprocedure
      and array_position(proconfig, 'search_path=""') is not null) then
    raise exception 'mobile recommendation RPC must be service-only, invoker, and use an empty search path';
  end if;

  insert into public.profiles(id,nickname) values
    ('11111111-1111-4111-8111-111111111111','Like Fixture'),
    ('22222222-2222-4222-8222-222222222222','Like Fixture Two')
  on conflict (id) do nothing;
  insert into public.posts(id,title,status,likes) values (910001,'Published like fixture','published',4);
  insert into public.posts(id,title,status,likes) values (910002,'Hidden like fixture','draft',7);
  execute 'set local role service_role';

  result := public.recommend_mobile_board_post(910001,'11111111-1111-4111-8111-111111111111');
  if result->>'status' <> 'liked' or (result->>'likes')::bigint <> 5 then
    raise exception 'first recommendation should increment and acknowledge once: %',result;
  end if;

  -- A retry after a committed request whose acknowledgement was lost must not
  -- increment the counter again.
  result := public.recommend_mobile_board_post(910001,'11111111-1111-4111-8111-111111111111');
  if result->>'status' <> 'already_liked' or (result->>'likes')::bigint <> 5 then
    raise exception 'retry must report the prior recommendation without incrementing: %',result;
  end if;

  result := public.recommend_mobile_board_post(910002,'22222222-2222-4222-8222-222222222222');
  if result->>'status' <> 'not_found' or result->'likes' <> 'null'::jsonb then
    raise exception 'unpublished posts must not be recommendable: %',result;
  end if;
  result := public.recommend_mobile_board_post(910003,'22222222-2222-4222-8222-222222222222');
  if result->>'status' <> 'not_found' then raise exception 'missing posts must return not_found: %',result; end if;

  -- Force a counter overflow after inserting the like marker. PostgreSQL must
  -- roll back both writes when the atomic RPC fails.
  update public.posts set likes=9223372036854775807 where id=910001;
  begin
    perform public.recommend_mobile_board_post(910001,'22222222-2222-4222-8222-222222222222');
  exception when numeric_value_out_of_range then
    failed := true;
  end;
  if not failed then raise exception 'counter overflow should fail the RPC'; end if;
  if exists(select from public.post_likes where post_id=910001 and user_id='22222222-2222-4222-8222-222222222222')
    or (select likes from public.posts where id=910001) <> 9223372036854775807 then
    raise exception 'failed counter update must roll back the like marker and count';
  end if;

  execute 'reset role';
  raise notice 'mobile board like scenarios passed';
end $$;
rollback;
