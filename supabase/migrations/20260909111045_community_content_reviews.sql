-- Human review is mandatory for community publications. No existing content is deleted.
create table public.community_content_reviews (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('post','reply')),
  status text not null check (status in ('generating','pending','published','rejected','expired','failed')),
  run_id uuid unique,
  title text not null,
  body text not null default '',
  category text,
  target_post_id bigint,
  target_comment_id bigint unique,
  target_comment_content text,
  target_comment_author text,
  post_content text,
  parent_content text,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '7 days',
  decided_at timestamptz,
  decided_by text,
  reason text,
  usage jsonb,
  result_post_id bigint,
  result_comment_id bigint,
  discord_message_id text,
  notification_attempts integer not null default 0,
  notification_lease_until timestamptz,
  notification_error text
);
create index community_reviews_outbox on public.community_content_reviews(created_at) where discord_message_id is null;
alter table public.community_content_reviews enable row level security;
revoke all on public.community_content_reviews from public,anon,authenticated;
grant select,insert,update,delete on public.community_content_reviews to service_role;

create or replace function public.validate_community_agent_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.publishing_enabled then raise exception 'community_human_approval_required'; end if;
  if new.enabled and not exists(select 1 from public.profiles where id=new.bot_user_id and nickname='BGMS AI' and role='user') then
    raise exception 'community_agent_invalid_bot';
  end if;
  new.updated_at:=clock_timestamp(); return new;
end; $$;
-- Rename only the reserved configured bot, never a similarly named user.
update public.profiles p set nickname='BGMS AI'
from public.community_agent_policy c
where p.id=c.bot_user_id and p.nickname='BGMS AI 비서' and p.role='user';
update public.community_agent_policy set publishing_enabled=false where singleton;

create or replace function public.publish_community_post(p_run_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('code','approval_required','postId',null);
$$;

create function public.enqueue_community_post_review(p_run_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.community_agent_policy%rowtype; r public.community_agent_runs%rowtype; q public.community_content_reviews%rowtype; w record;
begin
 select * into strict p from public.community_agent_policy where singleton for update;
 select * into q from public.community_content_reviews where run_id=p_run_id;
 if found then return to_jsonb(q); end if;
 if not p.enabled then return null; end if;
 select * into strict r from public.community_agent_runs where run_id=p_run_id for update;
 if r.status<>'ready' or r.published_at is not null or r.validation->>'passed' is distinct from 'true'
 or r.approved_title is null or r.approved_html is null or r.approved_category is null
 or r.approved_hash is distinct from encode(sha256(convert_to(r.approved_title||E'\n'||r.approved_html,'UTF8')),'hex')
 or r.validation->>'contentHash' is distinct from r.approved_hash then return null; end if;
 if not exists(select 1 from public.profiles where id=p.bot_user_id and nickname='BGMS AI' and role='user') then raise exception 'community_agent_invalid_bot'; end if;
 select * into strict w from public.write_board_post_with_images(null,p.bot_user_id,null,r.approved_title,r.approved_html,r.approved_category,null,false,'BGMS AI',p.bot_user_id,null,null,'',null,null,array[]::uuid[],null);
 if w.result_code<>'ok' then raise exception 'community_draft_write_failed'; end if;
 update public.posts set status='draft' where id=w.post_id;
 insert into public.community_content_reviews(kind,status,run_id,title,body,category,target_post_id)
 values('post','pending',r.run_id,r.approved_title,r.approved_html,r.approved_category,w.post_id) returning * into q;
 return to_jsonb(q);
end; $$;

create function public.claim_community_reply()
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
 where ps.user_id=p.bot_user_id and ps.status='published'
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

create function public.finish_community_reply(p_review_id uuid,p_body text,p_reason text,p_usage jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare q public.community_content_reviews%rowtype;
begin
 select * into strict q from public.community_content_reviews where id=p_review_id for update;
 if q.status<>'generating' then return to_jsonb(q); end if;
 if p_body is not null and (char_length(btrim(p_body)) not between 1 and 1000 or p_body ~ '<[^>]+>') then raise exception 'invalid_reply_body'; end if;
 update public.community_content_reviews set status=case when p_body is null then 'failed' else 'pending' end,
 body=coalesce(p_body,''),reason=left(p_reason,200),usage=p_usage where id=p_review_id returning * into q;
 return to_jsonb(q);
end; $$;

create function public.decide_community_review(p_review_id uuid,p_decision text,p_actor_id uuid default null,p_discord_user_id text default null,p_message_id text default null)
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
   if ps.status<>'published' or ps.title is distinct from q.title or ps.content is distinct from q.post_content then return jsonb_build_object('code','target_changed'); end if;
   select * into c from public.comments where id=q.target_comment_id and post_id=ps.id for update;
   if not found or c.content is distinct from q.target_comment_content or c.author is distinct from q.target_comment_author or c.user_id is not distinct from p.bot_user_id then return jsonb_build_object('code','target_changed'); end if;
   if c.parent_id is not null then
     perform 1 from public.comments where id=c.parent_id and content is not distinct from q.parent_content for share;
     if not found then return jsonb_build_object('code','target_changed'); end if;
   end if;
   if exists(select 1 from public.comments where parent_id=c.id and user_id=p.bot_user_id) then return jsonb_build_object('code','already_replied'); end if;
   select * into strict w from public.create_published_post_comment(ps.id,p.bot_user_id,'BGMS AI',q.body,c.id,null,null);
   if c.user_id is not null then
     insert into public.notifications(user_id,sender_id,sender_name,type,post_id,preview_text) values(c.user_id,p.bot_user_id,'BGMS AI','reply',ps.id,left(q.body,200));
   end if;
   result:=jsonb_build_object('code','published','postId',ps.id,'commentId',w.id);
 end if;
 update public.community_content_reviews set status='published',decided_at=clock_timestamp(),decided_by=coalesce(p_actor_id::text,'discord:'||p_discord_user_id),result_post_id=(result->>'postId')::bigint,result_comment_id=(result->>'commentId')::bigint where id=q.id;
 return result;
end; $$;

create function public.claim_community_review_notification()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare q public.community_content_reviews%rowtype;
begin
 select * into q from public.community_content_reviews
 where status in ('pending','failed') and discord_message_id is null
 and (notification_lease_until is null or notification_lease_until<clock_timestamp())
 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.community_content_reviews set notification_attempts=notification_attempts+1,notification_lease_until=clock_timestamp()+interval '5 minutes' where id=q.id returning * into q;
 return to_jsonb(q);
end; $$;

revoke all on function public.enqueue_community_post_review(uuid),public.claim_community_reply(),public.finish_community_reply(uuid,text,text,jsonb),public.decide_community_review(uuid,text,uuid,text,text),public.claim_community_review_notification() from public,anon,authenticated;
grant execute on function public.enqueue_community_post_review(uuid),public.claim_community_reply(),public.finish_community_reply(uuid,text,text,jsonb),public.decide_community_review(uuid,text,uuid,text,text),public.claim_community_review_notification() to service_role;
