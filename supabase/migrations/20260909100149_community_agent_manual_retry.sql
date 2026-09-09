-- Explicit administrator retries keep failed attempts and their model usage intact.
-- The day remains unique for every active, ready, or published run.
alter table public.community_agent_runs
  add column if not exists retry_of uuid references public.community_agent_runs(run_id) on delete set null;
create unique index if not exists community_agent_runs_retry_of_idx
  on public.community_agent_runs (retry_of) where retry_of is not null;
create unique index if not exists community_agent_runs_active_day_idx
  on public.community_agent_runs (day)
  where status not in ('deferred', 'failed') or published_at is not null or post_id is not null;
alter table public.community_agent_runs drop constraint if exists community_agent_runs_day_key;

create or replace function public.retry_community_run(p_actor_id uuid, p_previous_run_id uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_previous public.community_agent_runs%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_agent_run_id uuid;
  v_day date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  if p_actor_id is null or not exists (
    select 1 from public.profiles where id = p_actor_id and role = 'admin'
  ) then raise exception 'community_retry_admin_required'; end if;
  select * into strict v_policy from public.community_agent_policy where singleton for update;
  if not v_policy.enabled then raise exception 'community_agent_disabled'; end if;
  if v_policy.publishing_enabled then raise exception 'community_agent_dry_run_requires_publish_paused'; end if;
  select * into v_previous from public.community_agent_runs where run_id = p_previous_run_id for update;
  if not found then raise exception 'community_retry_run_not_found'; end if;
  if v_previous.day <> v_day or v_previous.status not in ('deferred', 'failed')
    or v_previous.post_id is not null or v_previous.published_at is not null then
    raise exception 'community_retry_not_available';
  end if;
  -- Replayed/double-clicked requests refer to the same predecessor and get the same successor.
  select * into v_run from public.community_agent_runs where retry_of = p_previous_run_id for update;
  if found then return public.community_run_payload(v_run); end if;
  if exists (select 1 from public.community_agent_runs where day = v_day
    and (status not in ('deferred', 'failed') or post_id is not null or published_at is not null)) then
    raise exception 'community_retry_not_available';
  end if;
  insert into public.agent_runs (user_id, status, message)
  values (p_actor_id, 'running', 'community-agent manual retry') returning id into v_agent_run_id;
  insert into public.community_agent_runs (run_id, day, status, dry_run, retry_of)
  values (v_agent_run_id, v_day, 'collecting', true, p_previous_run_id) returning * into v_run;
  return public.community_run_payload(v_run);
end;
$$;
revoke all on function public.retry_community_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.retry_community_run(uuid, uuid) to service_role;

create or replace function public.start_community_run(p_actor_id uuid, p_dry_run boolean)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_agent_run_id uuid;
  v_day date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  select * into strict v_policy from public.community_agent_policy where singleton for update;
  if not v_policy.enabled then raise exception 'community_agent_disabled'; end if;
  if p_dry_run and v_policy.publishing_enabled then raise exception 'community_agent_dry_run_requires_publish_paused'; end if;

  select * into v_run from public.community_agent_runs where day = v_day order by created_at desc, run_id desc limit 1 for update;
  if found then return public.community_run_payload(v_run); end if;

  insert into public.agent_runs (user_id, status, message)
  values (p_actor_id, 'running', 'community-agent') returning id into v_agent_run_id;
  insert into public.community_agent_runs (run_id, day, status, dry_run)
  values (v_agent_run_id, v_day, 'collecting', p_dry_run) returning * into v_run;
  return public.community_run_payload(v_run);
end;
$$;

create or replace function public.configure_community_agent_policy(p_patch jsonb)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_enable_publication boolean := false;
  v_evidence_count integer := 0;
  v_valid_evidence_count integer := 0;
  v_render_hash text;
begin
  if jsonb_typeof(p_patch) is distinct from 'object'
    or p_patch = '{}'::jsonb
    or p_patch - 'enabled' - 'publishingEnabled' - 'botUserId' - 'categories' - 'dailyPostLimit' - 'sourceEnabled' <> '{}'::jsonb
    or (p_patch ? 'enabled' and jsonb_typeof(p_patch -> 'enabled') is distinct from 'boolean')
    or (p_patch ? 'publishingEnabled' and jsonb_typeof(p_patch -> 'publishingEnabled') is distinct from 'boolean')
    or (p_patch ? 'botUserId' and jsonb_typeof(p_patch -> 'botUserId') not in ('string', 'null'))
    or (p_patch ? 'categories' and jsonb_typeof(p_patch -> 'categories') is distinct from 'array')
    or (p_patch ? 'dailyPostLimit' and (
      jsonb_typeof(p_patch -> 'dailyPostLimit') is distinct from 'number'
      or coalesce(p_patch ->> 'dailyPostLimit', '') not in ('0', '1')
    ))
    or (p_patch ? 'sourceEnabled' and jsonb_typeof(p_patch -> 'sourceEnabled') is distinct from 'object') then
    raise exception 'community_invalid_policy_patch';
  end if;

  select * into strict v_policy
  from public.community_agent_policy
  where singleton
  for update;
  v_enable_publication := not v_policy.publishing_enabled
    and p_patch ? 'publishingEnabled'
    and (p_patch ->> 'publishingEnabled')::boolean;

  update public.community_agent_policy
  set enabled = case when p_patch ? 'enabled' then (p_patch ->> 'enabled')::boolean else enabled end,
      publishing_enabled = case when p_patch ? 'publishingEnabled' then (p_patch ->> 'publishingEnabled')::boolean else publishing_enabled end,
      bot_user_id = case when p_patch ? 'botUserId' then nullif(p_patch ->> 'botUserId', '')::uuid else bot_user_id end,
      categories = case when p_patch ? 'categories' then array(select jsonb_array_elements_text(p_patch -> 'categories')) else categories end,
      daily_post_limit = case when p_patch ? 'dailyPostLimit' then (p_patch ->> 'dailyPostLimit')::smallint else daily_post_limit end,
      source_enabled = case when p_patch ? 'sourceEnabled' then p_patch -> 'sourceEnabled' else source_enabled end
  where singleton
  returning * into strict v_policy;

  if v_enable_publication and v_policy.enabled and v_policy.publishing_enabled then
    select * into v_run
    from public.community_agent_runs
    where day = (clock_timestamp() at time zone 'Asia/Seoul')::date and status = 'ready'
    for update;

    if found and v_run.dry_run and v_run.status = 'ready'
      and v_run.published_at is null and v_run.post_id is null
      and v_run.approved_title is not null and btrim(v_run.approved_title) <> ''
      and v_run.approved_html is not null and v_run.approved_hash is not null
      and v_run.validation ->> 'passed' = 'true'
      and v_run.validation ->> 'contentHash' = v_run.approved_hash
      and v_run.approved_category = any(v_policy.categories) then
      v_render_hash := pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(v_run.approved_title || E'\n' || v_run.approved_html, 'UTF8')
      ), 'hex');
      select count(*), count(evidence_row.id) filter (
        where evidence_row.excerpt is not null
          and evidence_row.expires_at > clock_timestamp()
      )
      into v_evidence_count, v_valid_evidence_count
      from (
        select distinct jsonb_array_elements_text(coalesce(paragraph.value -> 'evidenceIds', '[]'::jsonb)) as evidence_id
        from jsonb_array_elements(coalesce(v_run.draft -> 'paragraphs', '[]'::jsonb)) as paragraph(value)
      ) as reference_row
      left join public.community_agent_evidence as evidence_row
        on evidence_row.id = reference_row.evidence_id::uuid;

      if v_render_hash = v_run.approved_hash
        and v_evidence_count > 0
        and v_valid_evidence_count = v_evidence_count then
        update public.community_agent_runs
        set dry_run = false
        where run_id = v_run.run_id;
      end if;
    end if;
  end if;

  return to_jsonb(v_policy);
exception when invalid_text_representation then
  raise exception 'community_invalid_policy_patch';
end;
$$;
