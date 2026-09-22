-- Admins can exercise the human-reviewed reply flow while a BGMS AI post is
-- still a private draft. Public and ordinary-member writes remain blocked by
-- the server route; this RPC is service-role only.
create function public.create_reviewable_post_comment(
  p_post_id bigint,
  p_user_id uuid,
  p_author text,
  p_content text,
  p_parent_id bigint,
  p_password_hash text,
  p_ip_address text
)
returns table (
  id bigint,
  post_id bigint,
  user_id uuid,
  author text,
  content text,
  parent_id bigint,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1
  from public.posts
  where posts.id = p_post_id
    and posts.status in ('published', 'draft')
  for share;

  if not found then return; end if;

  if p_parent_id is not null then
    perform 1
    from public.comments
    where comments.id = p_parent_id
      and comments.post_id = p_post_id
    for share;
    if not found then return; end if;
  end if;

  return query
  insert into public.comments(post_id,user_id,author,content,parent_id,password_hash,ip_address)
  values(p_post_id,p_user_id,p_author,p_content,p_parent_id,p_password_hash,p_ip_address)
  returning comments.id,comments.post_id,comments.user_id,comments.author,comments.content,comments.parent_id,comments.created_at;
end;
$$;

revoke all on function public.create_reviewable_post_comment(bigint,uuid,text,text,bigint,text,text)
  from public,anon,authenticated;
grant execute on function public.create_reviewable_post_comment(bigint,uuid,text,text,bigint,text,text)
  to service_role;

create or replace function public.claim_community_reply()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.community_agent_policy%rowtype; c record; q public.community_content_reviews%rowtype;
begin
 select * into strict p from public.community_agent_policy where singleton for update;
 if not p.enabled or p.bot_user_id is null then return null; end if;
 update public.community_content_reviews set status='failed',reason='generation_interrupted' where status='generating' and created_at<clock_timestamp()-interval '5 minutes';
 if (select count(*) from public.community_content_reviews where kind='reply' and created_at >= date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')>=5 then return null; end if;
 select cm.id,cm.post_id,cm.content,cm.author,ps.title,ps.content as post_content,pc.content as parent_content into c
 from public.comments cm join public.posts ps on ps.id=cm.post_id
 left join public.comments pc on pc.id=cm.parent_id
 where ps.user_id=p.bot_user_id and ps.status in ('published','draft')
 and cm.user_id is distinct from p.bot_user_id
 and cm.created_at >= clock_timestamp()-interval '7 days'
 and not exists(select 1 from public.community_content_reviews existing_review where existing_review.target_comment_id=cm.id)
 and not exists(select 1 from public.comments reply where reply.parent_id=cm.id and reply.user_id=p.bot_user_id)
 order by cm.created_at,cm.id limit 1;
 if not found then return null; end if;
 insert into public.community_content_reviews(kind,status,title,target_post_id,target_comment_id,target_comment_content,target_comment_author,post_content,parent_content)
 values('reply','generating',c.title,c.post_id,c.id,c.content,c.author,c.post_content,c.parent_content) returning * into q;
 return to_jsonb(q);
end; $$;

create or replace function public.decide_community_review(p_review_id uuid,p_decision text,p_actor_id uuid default null,p_discord_user_id text default null,p_message_id text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.community_agent_policy%rowtype; q public.community_content_reviews%rowtype; ps public.posts%rowtype; c public.comments%rowtype; w record; result jsonb;
begin
 if p_decision not in ('approve','reject') then raise exception 'invalid_decision'; end if;
 if p_actor_id is not null then
   if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'admin_required'; end if;
 elsif p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' or p_message_id is null then raise exception 'review_actor_required'; end if;
 select * into strict p from public.community_agent_policy where singleton for update;
 select * into strict q from public.community_content_reviews where id=p_review_id for update;
 if p_actor_id is null and q.discord_message_id is distinct from p_message_id then raise exception 'review_message_mismatch'; end if;
 if q.status<>'pending' then return jsonb_build_object('code',q.status,'postId',q.result_post_id,'commentId',q.result_comment_id); end if;
 if p_decision='reject' then
   update public.community_content_reviews set status='rejected',decided_at=clock_timestamp(),decided_by=coalesce(p_actor_id::text,'discord:'||p_discord_user_id) where id=q.id;
   return jsonb_build_object('code','rejected');
 end if;
 if q.expires_at<=clock_timestamp() then
   update public.community_content_reviews set status='expired',reason='review_expired' where id=q.id;
   return jsonb_build_object('code','expired');
 end if;
 if not p.enabled then return jsonb_build_object('code','paused'); end if;
 if not exists(select 1 from public.profiles where id=p.bot_user_id and nickname='BGMS AI' and role='user') then return jsonb_build_object('code','invalid_bot'); end if;
 select * into ps from public.posts where id=q.target_post_id for update;
 if not found or ps.user_id is distinct from p.bot_user_id then return jsonb_build_object('code','target_changed'); end if;
 if q.kind='post' then
   if ps.status<>'draft' or ps.title is distinct from q.title or ps.content is distinct from q.body or ps.category is distinct from q.category then return jsonb_build_object('code','target_changed'); end if;
   if not (q.category=any(p.categories)) then return jsonb_build_object('code','category_disabled'); end if;
   if p.daily_post_limit=0 or exists(select 1 from public.community_agent_runs where published_at >= date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') then return jsonb_build_object('code','limit'); end if;
   update public.posts set status='published',author='BGMS AI' where id=ps.id;
   update public.community_agent_runs set status='published',post_id=ps.id,published_at=clock_timestamp() where run_id=q.run_id;
   result:=jsonb_build_object('code','published','postId',ps.id);
 else
   if ps.status not in ('published','draft') or ps.title is distinct from q.title or ps.content is distinct from q.post_content then return jsonb_build_object('code','target_changed'); end if;
   select * into c from public.comments where id=q.target_comment_id and post_id=ps.id for update;
   if not found or c.content is distinct from q.target_comment_content or c.author is distinct from q.target_comment_author or c.user_id is not distinct from p.bot_user_id then return jsonb_build_object('code','target_changed'); end if;
   if c.parent_id is not null then
     perform 1 from public.comments where id=c.parent_id and content is not distinct from q.parent_content for share;
     if not found then return jsonb_build_object('code','target_changed'); end if;
   end if;
   if exists(select 1 from public.comments where parent_id=c.id and user_id=p.bot_user_id) then return jsonb_build_object('code','already_replied'); end if;
   select * into strict w from public.create_reviewable_post_comment(ps.id,p.bot_user_id,'BGMS AI',q.body,c.id,null,null);
   if c.user_id is not null then
     insert into public.notifications(user_id,sender_id,sender_name,type,post_id,preview_text) values(c.user_id,p.bot_user_id,'BGMS AI','reply',ps.id,left(q.body,200));
   end if;
   result:=jsonb_build_object('code','published','postId',ps.id,'commentId',w.id);
 end if;
 update public.community_content_reviews set status='published',decided_at=clock_timestamp(),decided_by=coalesce(p_actor_id::text,'discord:'||p_discord_user_id),result_post_id=(result->>'postId')::bigint,result_comment_id=(result->>'commentId')::bigint where id=q.id;
 return result;
end; $$;
