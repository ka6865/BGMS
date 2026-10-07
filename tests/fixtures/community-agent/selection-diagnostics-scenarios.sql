\set ON_ERROR_STOP on

begin;
insert into auth.users(id) values ('99999999-9999-4999-8999-999999999901');
insert into public.profiles(id, nickname, role)
values ('99999999-9999-4999-8999-999999999901', 'BGMS AI 비서', 'user');
update public.community_agent_policy
set bot_user_id = '99999999-9999-4999-8999-999999999901', enabled = true;

set local role service_role;
do $$
declare
  v_run uuid := gen_random_uuid();
  v_lease uuid := gen_random_uuid();
  v_selection jsonb := jsonb_build_object(
    'storedCount', 24, 'usableCount', 12, 'inputCount', 15, 'emptyCount', 3,
    'rejectedCount', 9, 'supplementalCount', 3, 'detail', '선별 근거 부족',
    'candidates', jsonb_build_array(jsonb_build_object('title', '차량 운용', 'reason', '독립 근거 부족', 'rawBody', 'discard')),
    'rawProviderBody', 'discard'
  );
  v_topic jsonb := jsonb_build_object('kind', 'tip', 'title', '차량 운용', 'topicKey', 'vehicle',
    'evidenceIds', jsonb_build_array(gen_random_uuid()::text), 'reason', '유용한 전술', 'officialUpdate', false);
  v_result jsonb;
  v_invalid jsonb;
begin
  if has_function_privilege('anon', 'public.finish_community_stage(uuid,text,uuid,jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.finish_community_stage(uuid,text,uuid,jsonb)', 'execute') then
    raise exception 'selection diagnostics exposed finish RPC';
  end if;
  insert into public.agent_runs(id, message) values(v_run, 'selection fixture');
  insert into public.community_agent_runs(run_id, day, model_calls, stages)
  values(v_run, (clock_timestamp() at time zone 'Asia/Seoul')::date, 2,
    jsonb_build_object('select', jsonb_build_object('status', 'running', 'lease', v_lease::text, 'result', '{}'::jsonb)));

  begin
    perform public.finish_community_stage(v_run, 'select', gen_random_uuid(), jsonb_build_object('selection', '{}'));
    raise exception 'diagnostics bypassed lease validation';
  exception when others then
    if sqlerrm <> 'community_stage_lease_mismatch' then raise; end if;
  end;
  update public.community_agent_policy set enabled = false where singleton;
  begin
    perform public.finish_community_stage(v_run, 'select', v_lease, jsonb_build_object('selection', v_selection));
    raise exception 'diagnostics bypassed disabled policy';
  exception when others then
    if sqlerrm <> 'community_agent_disabled' then raise; end if;
  end;
  update public.community_agent_policy set enabled = true where singleton;

  for v_invalid in select value from jsonb_array_elements(jsonb_build_array(
    jsonb_set(v_selection, '{storedCount}', '201'),
    jsonb_set(v_selection, '{usableCount}', '-1'),
    jsonb_set(v_selection, '{inputCount}', '1.5'),
    jsonb_set(v_selection, '{emptyCount}', '"3"'),
    v_selection - 'rejectedCount',
    jsonb_set(v_selection, '{supplementalCount}', 'null'),
    jsonb_set(v_selection, '{detail}', to_jsonb(repeat('x', 501))),
    v_selection - 'detail',
    jsonb_set(v_selection, '{candidates}', jsonb_build_array('{}', '{}', '{}', '{}', '{}', '{}')),
    jsonb_set(v_selection, '{candidates,0,title}', to_jsonb(repeat('x', 121))),
    jsonb_set(v_selection, '{candidates,0,reason}', to_jsonb(repeat('x', 301))),
    jsonb_set(v_selection, '{candidates,0,title}', 'null')
  )) loop
    begin
      perform public.finish_community_stage(v_run, 'select', v_lease, jsonb_build_object('topic', v_topic, 'selection', v_invalid));
      raise exception 'invalid selection diagnostics accepted';
    exception when others then
      if sqlerrm <> 'community_invalid_selection_diagnostics' then raise; end if;
    end;
  end loop;

  v_result := public.finish_community_stage(v_run, 'select', v_lease,
    jsonb_build_object('topic', v_topic, 'selection', v_selection, 'usage', jsonb_build_object('promptTokens', 12, 'completionTokens', 3)));
  if v_result ->> 'status' <> 'selected' or v_result ->> 'modelCalls' <> '2'
    or v_result -> 'stages' -> 'select' -> 'result' -> 'selection' ->> 'inputCount' <> '15'
    or v_result -> 'stages' -> 'select' -> 'result' -> 'usage' ->> 'completionTokens' <> '3'
    or v_result -> 'topic' ? 'selection' or v_result::text like '%discard%' then
    raise exception 'successful selection did not preserve only safe diagnostics';
  end if;

  update public.community_agent_runs set status = 'collecting',
    stages = jsonb_build_object('select', jsonb_build_object('status', 'running', 'lease', v_lease::text, 'result', '{}'::jsonb))
  where run_id = v_run;
  v_selection := jsonb_set(v_selection, '{detail}', 'null');
  v_result := public.finish_community_stage(v_run, 'select', v_lease, jsonb_build_object(
    'terminal', jsonb_build_object('status', 'deferred', 'reason', 'insufficient_topic_evidence'),
    'selection', v_selection, 'usage', jsonb_build_object('promptTokens', 12, 'completionTokens', 3)));
  if v_result ->> 'status' <> 'deferred' or v_result ->> 'modelCalls' <> '2'
    or v_result -> 'stages' -> 'select' -> 'result' -> 'selection' ->> 'storedCount' <> '24'
    or v_result -> 'stages' -> 'select' -> 'result' -> 'selection' -> 'detail' <> 'null'::jsonb
    or v_result::text like '%discard%' then
    raise exception 'terminal selection did not preserve safe diagnostics';
  end if;
  if (select status from public.agent_runs where id = v_run) <> 'completed' then
    raise exception 'deferred selection changed parent run completion';
  end if;
end $$;
rollback;
select 'selection diagnostics scenarios passed' as result;
