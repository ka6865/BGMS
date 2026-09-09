-- Deliver an outcome even if an administrator decides before the initial alert is sent.
create or replace function public.claim_community_review_notification()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare q public.community_content_reviews%rowtype;
begin
 select * into q from public.community_content_reviews
 where status in ('pending','failed','published','rejected','expired') and discord_message_id is null
 and (notification_lease_until is null or notification_lease_until<clock_timestamp())
 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.community_content_reviews set notification_attempts=notification_attempts+1,notification_lease_until=clock_timestamp()+interval '5 minutes' where id=q.id returning * into q;
 return to_jsonb(q);
end; $$;
revoke all on function public.claim_community_review_notification() from public,anon,authenticated;
grant execute on function public.claim_community_review_notification() to service_role;
