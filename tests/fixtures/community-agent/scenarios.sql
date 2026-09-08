\set ON_ERROR_STOP on

do $$
begin
  if has_function_privilege('anon', 'public.publish_community_post(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.publish_community_post(uuid)', 'execute') then
    raise exception 'community publisher must not be public';
  end if;
  if has_table_privilege('anon', 'public.community_agent_runs', 'select')
     or has_table_privilege('authenticated', 'public.community_agent_evidence', 'insert') then
    raise exception 'community tables must not be public';
  end if;
end $$;

do $$
begin
  begin
    update public.community_agent_policy set enabled = true where singleton;
    raise exception 'enabled policy accepted a missing bot';
  exception when others then
    if sqlerrm <> 'community_agent_invalid_bot' then raise; end if;
  end;
  begin
    update public.community_agent_policy set categories = array[]::text[] where singleton;
    raise exception 'empty categories accepted';
  exception when check_violation then null;
  end;
  begin
    update public.community_agent_policy set source_enabled = '{"dc":true,"naver":true,"youtube":true,"other":true}'::jsonb where singleton;
    raise exception 'unexpected source key accepted';
  exception when check_violation then null;
  end;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-000000000901');
insert into public.profiles (id, nickname, role)
values ('00000000-0000-0000-0000-000000000901', 'BGMS AI 비서', 'user');
update public.community_agent_policy
set bot_user_id = '00000000-0000-0000-0000-000000000901', enabled = true, publishing_enabled = true;

do $$
declare
  v_first uuid;
  v_second uuid;
  v_claim jsonb;
  v_lease uuid;
  v_run jsonb;
begin
  v_first := (public.start_community_run(null, false) ->> 'id')::uuid;
  v_second := (public.start_community_run(null, false) ->> 'id')::uuid;
  if v_first <> v_second then raise exception 'same day produced two community runs'; end if;

  v_claim := public.claim_community_stage(v_first, 'dc');
  if v_claim ->> 'claimed' is distinct from 'true' then raise exception 'first stage claim failed'; end if;
  v_lease := (v_claim ->> 'lease')::uuid;
  if (public.claim_community_stage(v_first, 'dc') ->> 'claimed')::boolean then
    raise exception 'duplicate stage claim succeeded';
  end if;
  perform public.finish_community_stage(v_first, 'dc', v_lease, jsonb_build_object(
    'state', 'ok', 'reason', null, 'fetchedCount', 1, 'retainedCount', 0,
    'evidenceIds', '[]'::jsonb, 'rawSourceExcerpt', 'must not be persisted'
  ));
  if (select stages::text like '%must not be persisted%' or reports::text like '%must not be persisted%'
      from public.community_agent_runs where run_id = v_first) then
    raise exception 'raw source text was retained in run state';
  end if;

  -- Fourth model claim is deferred and never refunds the three already consumed calls.
  update public.community_agent_runs
  set model_calls = 3, status = 'collecting', stages = jsonb_build_object(
    'dc', jsonb_build_object('status','completed','lease',gen_random_uuid()::text,'result','{}'::jsonb),
    'naver', jsonb_build_object('status','completed','lease',gen_random_uuid()::text,'result','{}'::jsonb),
    'youtube', jsonb_build_object('status','completed','lease',gen_random_uuid()::text,'result','{}'::jsonb)
  ) where run_id = v_first;
  v_claim := public.claim_community_stage(v_first, 'select');
  if v_claim ->> 'claimed' is distinct from 'false'
    or (v_claim -> 'run' ->> 'modelCalls')::integer <> 3
    or v_claim -> 'run' ->> 'status' <> 'deferred' then
    raise exception 'fourth model claim was not deferred without refund';
  end if;

  -- A stale lease is terminal for the day's run and must not reset its model budget.
  update public.community_agent_runs
  set status = 'collecting', stages = jsonb_build_object('draft', jsonb_build_object(
    'status','running','lease',gen_random_uuid()::text,'startedAt',clock_timestamp() - interval '3 minutes','result','{}'::jsonb
  )) where run_id = v_first;
  v_run := public.get_community_run(v_first);
  if v_run ->> 'status' <> 'deferred' or (v_run ->> 'modelCalls')::integer <> 3 then
    raise exception 'stale lease cleanup reset the run budget';
  end if;
  update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 2 where run_id = v_first;
end $$;

do $$
declare
  v_run uuid;
  v_result jsonb;
  v_hash text := repeat('a', 64);
begin
  v_run := (public.start_community_run(null, false) ->> 'id')::uuid;
  update public.community_agent_runs set status = 'ready', approved_title = 'publisher checks',
    approved_html = '<p>validated</p>', approved_category = '자유', approved_hash = v_hash,
    validation = jsonb_build_object('passed', true, 'contentHash', v_hash)
  where run_id = v_run;

  update public.community_agent_runs set validation = jsonb_build_object('passed', true, 'contentHash', repeat('b',64)) where run_id = v_run;
  if public.publish_community_post(v_run) ->> 'code' <> 'not_ready' then raise exception 'hash mismatch published'; end if;
  update public.community_agent_runs set validation = jsonb_build_object('passed', true, 'contentHash', v_hash) where run_id = v_run;

  update public.profiles set nickname = 'not the bot' where id = '00000000-0000-0000-0000-000000000901';
  if public.publish_community_post(v_run) ->> 'code' <> 'invalid_bot' then raise exception 'invalid bot published'; end if;
  update public.profiles set nickname = 'BGMS AI 비서' where id = '00000000-0000-0000-0000-000000000901';

  update public.community_agent_policy set daily_post_limit = 0;
  if public.publish_community_post(v_run) ->> 'code' <> 'limit' then raise exception 'daily limit did not block'; end if;
  update public.community_agent_policy set daily_post_limit = 1, enabled = false, publishing_enabled = false;
  if public.publish_community_post(v_run) ->> 'code' <> 'paused' then raise exception 'paused publisher wrote a post'; end if;
  update public.community_agent_policy set enabled = true, publishing_enabled = true;
  update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 1 where run_id = v_run;
  if public.publish_community_post(v_run) ->> 'code' <> 'expired' then raise exception 'old run published'; end if;
end $$;

do $$
declare
  v_run uuid;
  v_hash text := repeat('c', 64);
begin
  v_run := (public.start_community_run(null, false) ->> 'id')::uuid;
  update public.community_agent_runs set status = 'ready', approved_title = 'rollback write',
    approved_html = '<p>validated</p>', approved_category = '자유', approved_hash = v_hash,
    validation = jsonb_build_object('passed', true, 'contentHash', v_hash)
  where run_id = v_run;
end $$;

create or replace function public.test_reject_community_write()
returns trigger language plpgsql as $$
begin
  if new.title = 'rollback write' then raise exception 'fixture board write failure'; end if;
  return new;
end;
$$;
create trigger test_reject_community_write before insert on public.posts
for each row execute function public.test_reject_community_write();

do $$
declare v_run uuid;
begin
  select run_id into v_run from public.community_agent_runs
  where day = (clock_timestamp() at time zone 'Asia/Seoul')::date;
  begin
    perform public.publish_community_post(v_run);
    raise exception 'publisher did not surface board failure';
  exception when others then
    if sqlerrm not like '%fixture board write failure%' then raise; end if;
  end;
  if exists (select 1 from public.posts where title = 'rollback write')
    or exists (select 1 from public.community_agent_runs where run_id = v_run and (post_id is not null or published_at is not null)) then
    raise exception 'board write failure did not roll back publisher state';
  end if;
end $$;

drop trigger test_reject_community_write on public.posts;
drop function public.test_reject_community_write();
update public.community_agent_runs
set approved_title = 'concurrency publish'
where day = (clock_timestamp() at time zone 'Asia/Seoul')::date;

select 'community-agent sequential scenarios passed' as result;
