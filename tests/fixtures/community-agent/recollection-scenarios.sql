begin;
-- Isolate a new local day, leaving existing publication evidence intact for rollback.
update public.community_agent_runs set day=day-30;
set role service_role;
do $$
declare r jsonb; q jsonb; successor jsonb; replay jsonb; template public.community_agent_runs%rowtype; rid uuid;
begin
 select * into strict template from public.community_agent_runs where approved_hash is not null limit 1;
 r:=public.start_community_run('22222222-2222-4222-8222-222222222222',true);
 rid:=(r->>'id')::uuid;
 update public.community_agent_runs set status='ready',approved_title=template.approved_title,
 approved_html=template.approved_html,approved_hash=template.approved_hash,approved_category=template.approved_category,
 validation=template.validation,model_calls=3,
 topic='{"evidenceIds":["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]}',
 draft='{"paragraphs":[{"evidenceIds":["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]}]}'
 where run_id=rid;
 q:=public.enqueue_community_post_review(rid);
 if q is null then raise exception 'draft missing'; end if;
 begin
   perform public.retry_community_run('22222222-2222-4222-8222-222222222222',rid);
   raise exception 'pending review allowed retry';
 exception when others then
   if sqlerrm<>'community_retry_not_available' then raise; end if;
 end;
 perform public.decide_community_review((q->>'id')::uuid,'reject','22222222-2222-4222-8222-222222222222');
 if not exists(select 1 from public.community_agent_runs where run_id=rid and status='deferred' and reason='review_rejected' and model_calls=3 and draft is not null) then raise exception 'rejected attempt not released/preserved'; end if;
 if public.community_rejected_evidence_ids() @> '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]'::jsonb is not true then raise exception 'rejected evidence missing'; end if;
 r:=public.decide_community_review((q->>'id')::uuid,'approve','22222222-2222-4222-8222-222222222222');
 if r->>'code'<>'rejected' then raise exception 'rejected draft approved'; end if;
 if exists(select 1 from public.posts where id=(q->>'target_post_id')::bigint and status='published') then raise exception 'rejected post was published'; end if;
 successor:=public.retry_community_run('22222222-2222-4222-8222-222222222222',rid);
 replay:=public.retry_community_run('22222222-2222-4222-8222-222222222222',rid);
 if successor->>'id'=rid::text or successor->>'id' is distinct from replay->>'id' then raise exception 'retry not idempotent'; end if;
 if successor->>'status'<>'collecting' or successor->>'dryRun'<>'true' then raise exception 'retry not fresh dry run'; end if;
 update public.community_content_reviews set decided_at=now()-interval '8 days' where id=(q->>'id')::uuid;
 if public.community_rejected_evidence_ids() @> '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]'::jsonb then raise exception 'expired rejection blocks candidates forever'; end if;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.community_rejected_evidence_ids()','EXECUTE') or has_function_privilege('authenticated','public.release_rejected_community_run()','EXECUTE') then raise exception 'private functions exposed'; end if;
end $$;
rollback;
