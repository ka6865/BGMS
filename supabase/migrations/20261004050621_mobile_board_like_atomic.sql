set lock_timeout = '3s';
set statement_timeout = '30s';

create or replace function public.recommend_mobile_board_post(
  p_post_id bigint,
  p_user_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_likes bigint;
  v_inserted integer;
begin
  if p_post_id is null or p_user_id is null then
    raise exception 'post and user IDs are required';
  end if;

  -- Serialize recommendations for this post and only accept published posts.
  select post_row.likes
  into v_likes
  from public.posts as post_row
  where post_row.id = p_post_id
    and post_row.status = 'published'
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found', 'likes', null);
  end if;

  insert into public.post_likes (post_id, user_id)
  values (p_post_id, p_user_id)
  on conflict (post_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    update public.posts as post_row
    set likes = coalesce(post_row.likes, 0) + 1
    where post_row.id = p_post_id
    returning post_row.likes into v_likes;

    return jsonb_build_object('status', 'liked', 'likes', v_likes);
  end if;

  return jsonb_build_object('status', 'already_liked', 'likes', coalesce(v_likes, 0));
end;
$$;

revoke all on function public.recommend_mobile_board_post(bigint, uuid) from public, anon, authenticated;
grant execute on function public.recommend_mobile_board_post(bigint, uuid) to service_role;

reset lock_timeout;
reset statement_timeout;
