-- A rejected post is a finished unpublished attempt, eligible for the existing
-- administrator-only retry RPC. Keep the draft, usage and decision audit intact.
create function public.release_rejected_community_run()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.kind='post' and new.status='rejected' and old.status is distinct from new.status then
    update public.community_agent_runs set status='deferred', reason='review_rejected'
    where run_id=new.run_id and status='ready' and post_id is null and published_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.release_rejected_community_run() from public, anon, authenticated;
grant execute on function public.release_rejected_community_run() to service_role;
create trigger community_review_rejected_run
  after update of status on public.community_content_reviews
  for each row execute function public.release_rejected_community_run();

-- Repair decisions made before this trigger existed, without touching public posts.
update public.community_agent_runs r set status='deferred',reason='review_rejected'
where r.status='ready' and r.post_id is null and r.published_at is null
and exists(select 1 from public.community_content_reviews q where q.run_id=r.run_id and q.kind='post' and q.status='rejected');

create function public.community_rejected_evidence_ids()
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(distinct evidence.id),'[]'::jsonb)
  from public.community_content_reviews q
  join public.community_agent_runs r on r.run_id=q.run_id
  cross join lateral (
    select jsonb_array_elements_text(coalesce(r.topic->'evidenceIds','[]'::jsonb)) as id
    union
    select jsonb_array_elements_text(coalesce(paragraph->'evidenceIds','[]'::jsonb))
    from jsonb_array_elements(coalesce(r.draft->'paragraphs','[]'::jsonb)) paragraph
  ) evidence
  where q.kind='post' and q.status='rejected'
    and q.decided_at >= now()-interval '7 days';
$$;
revoke all on function public.community_rejected_evidence_ids() from public, anon, authenticated;
grant execute on function public.community_rejected_evidence_ids() to service_role;
