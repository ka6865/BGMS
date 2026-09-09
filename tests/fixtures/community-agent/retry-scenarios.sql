begin;
do $$
declare
  v_admin uuid := gen_random_uuid();
  v_bot uuid := gen_random_uuid();
  v_old uuid;
  v_new uuid;
  v_third uuid;
  v_evidence uuid := gen_random_uuid();
  v_payload jsonb;
  v_hash text;
  v_id uuid;
begin
  insert into auth.users(id) values(v_admin),(v_bot);
  insert into public.profiles(id,nickname,role) values(v_admin,'retry admin','admin'),(v_bot,'BGMS AI 비서','user');
  update public.community_agent_policy set bot_user_id=v_bot, enabled=true, publishing_enabled=false where singleton;
  v_old := (public.start_community_run(v_admin,true)->>'id')::uuid;
  update public.community_agent_runs set status='deferred',reason='no_usable_evidence',model_calls=2,
    stages='{"select":{"status":"failed","result":{"usage":{"promptTokens":12,"completionTokens":8}}}}'::jsonb where run_id=v_old;
  if (public.start_community_run(v_admin,true)->>'id')::uuid <> v_old then raise exception 'ordinary start retried implicitly'; end if;
  begin
    perform public.retry_community_run(v_bot,v_old);
    raise exception 'nonadmin retried';
  exception when others then if sqlerrm <> 'community_retry_admin_required' then raise; end if; end;
  v_payload := public.retry_community_run(v_admin,v_old);
  v_new := (v_payload->>'id')::uuid;
  if v_new=v_old or v_payload->>'status'<>'collecting' or not (v_payload->>'dryRun')::boolean
    or (v_payload->>'modelCalls')::integer<>0 or v_payload->'stages'<>'{}'::jsonb then raise exception 'retry was not a fresh dryrun'; end if;
  if (select model_calls from public.community_agent_runs where run_id=v_old)<>2
    or (select stages #>> '{select,result,usage,promptTokens}' from public.community_agent_runs where run_id=v_old)<>'12' then raise exception 'old usage lost'; end if;
  if (public.retry_community_run(v_admin,v_old)->>'id')::uuid<>v_new then raise exception 'duplicate retry created another run'; end if;
  if (public.start_community_run(null,false)->>'id')::uuid<>v_new then raise exception 'worker did not resume latest retry'; end if;
  if (public.claim_community_stage(v_old,'dc')->>'claimed')::boolean then raise exception 'old attempt resumed'; end if;
  begin
    perform public.retry_community_run(v_admin,v_new);
    raise exception 'active run retried';
  exception when others then if sqlerrm <> 'community_retry_not_available' then raise; end if; end;
  -- An active retry still owns the daily publication slot at database level.
  begin
    v_id := gen_random_uuid();
    insert into public.agent_runs(id,message) values(v_id,'duplicate active');
    insert into public.community_agent_runs(run_id,day) values(v_id,(clock_timestamp() at time zone 'Asia/Seoul')::date);
    raise exception 'duplicate active day allowed';
  exception when unique_violation then null; end;
  update public.community_agent_runs set status='failed',reason='model_failed' where run_id=v_new;
  update public.community_agent_policy set enabled=false where singleton;
  begin
    perform public.retry_community_run(v_admin,v_new);
    raise exception 'paused agent retried';
  exception when others then if sqlerrm <> 'community_agent_disabled' then raise; end if; end;
  update public.community_agent_policy set enabled=true,publishing_enabled=true where singleton;
  begin
    perform public.retry_community_run(v_admin,v_new);
    raise exception 'publishing-enabled agent retried';
  exception when others then if sqlerrm <> 'community_agent_dry_run_requires_publish_paused' then raise; end if; end;
  update public.community_agent_policy set publishing_enabled=false where singleton;
  update public.community_agent_runs set day=day-1 where run_id=v_new;
  begin
    perform public.retry_community_run(v_admin,v_new);
    raise exception 'yesterday retried';
  exception when others then if sqlerrm <> 'community_retry_not_available' then raise; end if; end;
  update public.community_agent_runs set day=day+1 where run_id=v_new;
  v_third := (public.retry_community_run(v_admin,v_new)->>'id')::uuid;
  -- Promotion selects the ready successor despite earlier failed rows on the same date.
  insert into public.community_agent_evidence(id,source,external_id,url,title,excerpt,fetched_at,access,content_hash,official,expires_at)
    values(v_evidence,'dc','retry-test','https://gall.dcinside.com/board/view/?id=battlegrounds&no=1','source','verified body',clock_timestamp(),'body',repeat('e',64),false,clock_timestamp()+interval '7 days');
  v_hash := encode(sha256(convert_to('retry validated'||E'\n'||'<p>validated</p>','UTF8')),'hex');
  update public.community_agent_runs set status='ready',approved_title='retry validated',approved_html='<p>validated</p>',approved_category='자유',approved_hash=v_hash,
    draft=jsonb_build_object('title','retry validated','paragraphs',jsonb_build_array(jsonb_build_object('text','verified body','kind','observed_opinion','evidenceIds',jsonb_build_array(v_evidence::text))),'question','question'),
    validation=jsonb_build_object('passed',true,'contentHash',v_hash) where run_id=v_third;
  perform public.configure_community_agent_policy('{"publishingEnabled":true}'::jsonb);
  if (select dry_run from public.community_agent_runs where run_id=v_third) then raise exception 'retry draft not promoted'; end if;
  if public.publish_community_post(v_third)->>'code'<>'published' then raise exception 'retry draft not published'; end if;
  update public.community_agent_policy set publishing_enabled=false where singleton;
  begin
    perform public.retry_community_run(v_admin,v_third);
    raise exception 'published run retried';
  exception when others then if sqlerrm <> 'community_retry_not_available' then raise; end if; end;
  if (select count(*) from public.posts where title='retry validated')<>1 then raise exception 'retry duplicated post'; end if;
  if has_function_privilege('anon','public.retry_community_run(uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.retry_community_run(uuid,uuid)','execute')
    or not has_function_privilege('service_role','public.retry_community_run(uuid,uuid)','execute') then raise exception 'retry privileges wrong'; end if;
end $$;
rollback;
select 'manual retry scenarios passed' as result;
