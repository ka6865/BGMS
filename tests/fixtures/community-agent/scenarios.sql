\set ON_ERROR_STOP on

do $$
begin
  if has_function_privilege('anon', 'public.publish_community_post(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.publish_community_post(uuid)', 'execute')
     or has_function_privilege('anon', 'public.configure_community_agent_policy(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.configure_community_agent_policy(jsonb)', 'execute') then
    raise exception 'community publisher must not be public';
  end if;
  if has_table_privilege('anon', 'public.community_agent_runs', 'select')
     or has_table_privilege('authenticated', 'public.community_agent_evidence', 'insert') then
    raise exception 'community tables must not be public';
  end if;
  if (select source_enabled ->> 'youtube' from public.community_agent_policy where singleton) <> 'false' then
    raise exception 'youtube must be initially deselected';
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
set bot_user_id = '00000000-0000-0000-0000-000000000901',
    enabled = false, publishing_enabled = false,
    categories = array['자유']::text[], daily_post_limit = 0,
    source_enabled = '{"dc":false,"naver":true,"youtube":false}'::jsonb;

set role service_role;
select public.configure_community_agent_policy(jsonb_build_object(
  'categories', jsonb_build_array('배그 소식', '자유'),
  'sourceEnabled', '{"dc":true,"naver":false,"youtube":false}'::jsonb
));
reset role;

do $$
begin
  if (select enabled or publishing_enabled or daily_post_limit <> 0
      or bot_user_id <> '00000000-0000-0000-0000-000000000901'::uuid
      or categories <> array['배그 소식', '자유']::text[]
      or source_enabled <> '{"dc":true,"naver":false,"youtube":false}'::jsonb
      from public.community_agent_policy where singleton) then
    raise exception 'partial configure changed a paused or omitted policy field';
  end if;
end $$;

update public.community_agent_policy
set enabled = true, publishing_enabled = true,
    daily_post_limit = 1,
    source_enabled = '{"dc":true,"naver":true,"youtube":true}'::jsonb;

-- These are SECURITY INVOKER calls. Run as service_role so missing helper grants fail here.
set role service_role;
with started as materialized (
  select public.start_community_run(null, false) as run
), checked as materialized (
  select public.get_community_run((run ->> 'id')::uuid) as run from started
), claimed as materialized (
  select public.claim_community_stage((run ->> 'id')::uuid, 'dc') as claim from started
)
select public.finish_community_stage(
  (started.run ->> 'id')::uuid, 'dc', (claimed.claim ->> 'lease')::uuid,
  jsonb_build_object('state', 'ok', 'reason', null, 'fetchedCount', 1, 'retainedCount', 0, 'evidenceIds', '[]'::jsonb)
)
from started cross join checked cross join claimed
where claimed.claim ->> 'claimed' = 'true';
reset role;

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

  v_claim := public.claim_community_stage(v_first, 'naver');
  if v_claim ->> 'claimed' is distinct from 'true' then raise exception 'first stage claim failed'; end if;
  v_lease := (v_claim ->> 'lease')::uuid;
  if (public.claim_community_stage(v_first, 'naver') ->> 'claimed')::boolean then
    raise exception 'duplicate stage claim succeeded';
  end if;
  perform public.finish_community_stage(v_first, 'naver', v_lease, jsonb_build_object(
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

set role service_role;
do $$
declare
  v_run uuid;
  v_claim jsonb;
  v_lease uuid;
  v_result jsonb;
begin
  v_run := (public.start_community_run(null, false) ->> 'id')::uuid;
  update public.community_agent_runs
  set stages = jsonb_build_object(
    'dc', jsonb_build_object('status','completed','lease',gen_random_uuid()::text,'result','{}'::jsonb),
    'naver', jsonb_build_object('status','completed','lease',gen_random_uuid()::text,'result','{}'::jsonb),
    'youtube', jsonb_build_object('status','completed','lease',gen_random_uuid()::text,'result','{}'::jsonb)
  ) where run_id = v_run;
  v_claim := public.claim_community_stage(v_run, 'select');
  v_lease := (v_claim ->> 'lease')::uuid;
  begin
    perform public.finish_community_stage(v_run, 'select', gen_random_uuid(), jsonb_build_object(
      'terminal', jsonb_build_object('status', 'deferred', 'reason', 'no_usable_evidence')
    ));
    raise exception 'stale terminal lease was accepted';
  exception when others then
    if sqlerrm <> 'community_stage_lease_mismatch' then raise; end if;
  end;
  v_result := public.finish_community_stage(v_run, 'select', v_lease, jsonb_build_object(
    'terminal', jsonb_build_object('status', 'deferred', 'reason', 'no_usable_evidence'),
    'usage', jsonb_build_object('promptTokens', 12, 'completionTokens', 3),
    'rawProviderBody', 'must not be persisted'
  ));
  if v_result ->> 'status' <> 'deferred' or v_result ->> 'reason' <> 'no_usable_evidence'
    or v_result -> 'stages' -> 'select' -> 'result' -> 'usage' ->> 'promptTokens' <> '12'
    or v_result::text like '%must not be persisted%' then
    raise exception 'terminal result was not safely persisted immediately';
  end if;
  update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 4 where run_id = v_run;
end $$;
reset role;

do $$
declare
  v_run uuid;
  v_evidence uuid := '00000000-0000-4000-8000-000000000911';
  v_title text := 'validated same-day dry run';
  v_html text := '<p>validated</p>';
  v_hash text;
begin
  update public.community_agent_policy set publishing_enabled = false where singleton;
  v_run := (public.start_community_run(null, true) ->> 'id')::uuid;
  v_hash := encode(public.digest(convert_to(v_title || E'\n' || v_html, 'UTF8'), 'sha256'), 'hex');
  insert into public.community_agent_evidence (
    id, source, external_id, url, title, excerpt, published_at, fetched_at, access, content_hash, official, expires_at
  ) values (
    v_evidence, 'dc', 'promotion-evidence', 'https://gall.dcinside.com/board/view/?id=battlegrounds&no=911',
    'promotion evidence', 'verified body', clock_timestamp(), clock_timestamp(), 'body', repeat('e', 64), false,
    clock_timestamp() + interval '7 days'
  );
  update public.community_agent_runs set status = 'ready', approved_title = v_title,
    approved_html = v_html, approved_category = '자유', approved_hash = v_hash,
    draft = jsonb_build_object('title', v_title, 'paragraphs', jsonb_build_array(jsonb_build_object(
      'text', 'verified body', 'kind', 'observed_opinion', 'evidenceIds', jsonb_build_array(v_evidence::text), 'recentWindow', null
    )), 'question', 'question'),
    validation = jsonb_build_object('passed', true, 'contentHash', v_hash)
  where run_id = v_run;
  if public.publish_community_post(v_run) ->> 'code' <> 'not_ready' then
    raise exception 'direct dry run publish was accepted';
  end if;
  set local role service_role;
  perform public.configure_community_agent_policy('{"publishingEnabled":true}'::jsonb);
  reset role;
  if (select dry_run from public.community_agent_runs where run_id = v_run) then
    raise exception 'validated same-day dry run was not promoted';
  end if;
  if exists (select 1 from public.posts where title = v_title) then
    raise exception 'configure published a post';
  end if;
  update public.community_agent_policy set enabled = false, publishing_enabled = false where singleton;
  if public.publish_community_post(v_run) ->> 'code' <> 'paused' then
    raise exception 'pause after verify did not block publication';
  end if;
  update public.community_agent_policy set enabled = true, publishing_enabled = false where singleton;
  update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 5 where run_id = v_run;
end $$;

do $$
declare
  v_run uuid;
  v_title text := 'hash rejection dry run';
  v_html text := '<p>validated</p>';
  v_hash text;
begin
  v_run := (public.start_community_run(null, true) ->> 'id')::uuid;
  v_hash := encode(public.digest(convert_to(v_title || E'\n' || v_html, 'UTF8'), 'sha256'), 'hex');
  update public.community_agent_runs set status = 'ready', approved_title = v_title,
    approved_html = v_html, approved_category = '자유', approved_hash = v_hash,
    draft = jsonb_build_object('paragraphs', jsonb_build_array(jsonb_build_object(
      'evidenceIds', jsonb_build_array('00000000-0000-4000-8000-000000000911')
    ))), validation = jsonb_build_object('passed', true, 'contentHash', repeat('f', 64))
  where run_id = v_run;
  set local role service_role;
  perform public.configure_community_agent_policy('{"publishingEnabled":true}'::jsonb);
  reset role;
  if not (select dry_run from public.community_agent_runs where run_id = v_run) then
    raise exception 'hash mismatch dry run was promoted';
  end if;
  update public.community_agent_policy set publishing_enabled = false where singleton;
  update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 6 where run_id = v_run;
  set local role service_role;
  perform public.configure_community_agent_policy('{"publishingEnabled":true}'::jsonb);
  reset role;
  if not (select dry_run from public.community_agent_runs where run_id = v_run) then
    raise exception 'prior-day dry run was promoted';
  end if;
  update public.community_agent_policy set publishing_enabled = false where singleton;
end $$;

do $$
declare
  v_run uuid;
  v_title text := 'missing evidence dry run';
  v_html text := '<p>validated</p>';
  v_hash text;
begin
  v_run := (public.start_community_run(null, true) ->> 'id')::uuid;
  v_hash := encode(public.digest(convert_to(v_title || E'\n' || v_html, 'UTF8'), 'sha256'), 'hex');
  update public.community_agent_runs set status = 'ready', approved_title = v_title,
    approved_html = v_html, approved_category = '자유', approved_hash = v_hash,
    draft = jsonb_build_object('paragraphs', jsonb_build_array(jsonb_build_object(
      'evidenceIds', jsonb_build_array('00000000-0000-4000-8000-000000000999')
    ))), validation = jsonb_build_object('passed', true, 'contentHash', v_hash)
  where run_id = v_run;
  set local role service_role;
  perform public.configure_community_agent_policy('{"publishingEnabled":true}'::jsonb);
  reset role;
  if not (select dry_run from public.community_agent_runs where run_id = v_run) then
    raise exception 'missing evidence dry run was promoted';
  end if;
  update public.community_agent_policy set publishing_enabled = false where singleton;
  update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 7 where run_id = v_run;
end $$;

do $$
declare
  v_run uuid;
  v_result jsonb;
  v_hash text := repeat('a', 64);
begin
  v_run := (public.start_community_run(null, false) ->> 'id')::uuid;
  update public.community_agent_policy set publishing_enabled = true where singleton;
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
  v_youtube uuid := '00000000-0000-4000-8000-000000000912';
  v_dc uuid := '00000000-0000-4000-8000-000000000913';
  v_run uuid;
  v_post bigint;
begin
  insert into public.community_agent_evidence (
    id, source, external_id, url, title, excerpt, published_at, fetched_at, access, content_hash, official, expires_at
  ) values
    (v_youtube, 'youtube', 'retention-video', 'https://www.youtube.com/watch?v=retention-video',
      'temporary API title', 'temporary API description', null, clock_timestamp() - interval '31 days',
      'description', repeat('1', 64), true, clock_timestamp() - interval '24 days'),
    (v_dc, 'dc', 'retention-dc', 'https://gall.dcinside.com/board/view/?id=battlegrounds&no=913',
      'retained source title', 'expired excerpt', null, clock_timestamp() - interval '31 days',
      'body', repeat('2', 64), false, clock_timestamp() - interval '24 days');
  select run_id into strict v_run from public.community_agent_runs order by created_at limit 1;
  update public.community_agent_runs
  set reports = jsonb_build_array(jsonb_build_object('evidenceIds', jsonb_build_array(v_youtube::text, v_dc::text)))
  where run_id = v_run;
  insert into public.posts (title, content, category, author, user_id, status)
  values ('retention sentinel post', '<p>published content remains</p>', '자유', 'BGMS AI 비서',
    '00000000-0000-0000-0000-000000000901', 'published')
  returning id into v_post;
  update public.community_agent_sources
  set resolved_channel_id = 'stale-channel', uploads_playlist_id = 'stale-uploads',
      last_success_at = clock_timestamp() - interval '31 days', updated_at = clock_timestamp()
  where id = 'youtube';

  set local role service_role;
  perform public.cleanup_community_agent();
  reset role;
  if exists (select 1 from public.community_agent_evidence where id = v_youtube) then
    raise exception 'referenced youtube API metadata survived 30 days';
  end if;
  if not exists (select 1 from public.community_agent_evidence where id = v_dc and excerpt is null) then
    raise exception 'other evidence metadata did not retain its existing lifecycle';
  end if;
  if not exists (select 1 from public.posts where id = v_post and status = 'published') then
    raise exception 'youtube cleanup removed an existing post';
  end if;
  if exists (select 1 from public.community_agent_sources where id = 'youtube'
    and (resolved_channel_id is not null or uploads_playlist_id is not null)) then
    raise exception 'stale youtube channel cache survived 30 days without success';
  end if;

  update public.community_agent_sources
  set resolved_channel_id = 'current-channel', uploads_playlist_id = 'current-uploads',
      last_success_at = clock_timestamp(), updated_at = clock_timestamp() - interval '31 days'
  where id = 'youtube';
  set local role service_role;
  perform public.cleanup_community_agent();
  reset role;
  if not exists (select 1 from public.community_agent_sources where id = 'youtube'
    and resolved_channel_id = 'current-channel' and uploads_playlist_id = 'current-uploads') then
    raise exception 'youtube channel cache used updated_at instead of last_success_at';
  end if;
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
