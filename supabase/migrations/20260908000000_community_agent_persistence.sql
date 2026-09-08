-- Community operating assistant: isolated state, bounded model leases, and atomic board publishing.
-- These objects are service-role-only. Existing board and admin-agent access is intentionally unchanged.

create extension if not exists pgcrypto;

create table if not exists public.community_agent_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  publishing_enabled boolean not null default false,
  bot_user_id uuid references public.profiles(id) on delete set null,
  categories text[] not null default array['배그 소식', '자유']::text[],
  daily_post_limit smallint not null default 1 check (daily_post_limit between 0 and 1),
  source_enabled jsonb not null default '{"dc":true,"naver":true,"youtube":false}'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  constraint community_agent_policy_categories_check check (
    cardinality(categories) between 1 and 2
    and array_position(categories, null) is null
    and categories <@ array['배그 소식', '자유']::text[]
    and coalesce(cardinality(array_positions(categories, '배그 소식')), 0) <= 1
    and coalesce(cardinality(array_positions(categories, '자유')), 0) <= 1
  ),
  constraint community_agent_policy_sources_check check (
    jsonb_typeof(source_enabled) = 'object'
    and source_enabled ?& array['dc', 'naver', 'youtube']
    and source_enabled - 'dc' - 'naver' - 'youtube' = '{}'::jsonb
    and jsonb_typeof(source_enabled -> 'dc') = 'boolean'
    and jsonb_typeof(source_enabled -> 'naver') = 'boolean'
    and jsonb_typeof(source_enabled -> 'youtube') = 'boolean'
  ),
  constraint community_agent_policy_publish_requires_enabled check (
    not publishing_enabled or enabled
  )
);

create table if not exists public.community_agent_sources (
  id text primary key check (id in ('dc', 'naver', 'youtube')),
  resolved_channel_id text,
  uploads_playlist_id text,
  state text not null default 'needs_setup' check (state in ('ok', 'partial', 'empty', 'needs_setup', 'blocked', 'failed', 'disabled')),
  reason text,
  last_success_at timestamptz,
  cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.community_agent_evidence (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('dc', 'naver', 'youtube', 'official')),
  external_id text not null check (char_length(external_id) between 1 and 500),
  url text not null check (char_length(url) between 1 and 2000),
  title text not null check (char_length(title) between 1 and 500),
  excerpt text check (excerpt is null or char_length(excerpt) <= 500),
  published_at timestamptz,
  fetched_at timestamptz not null,
  access text not null check (access in ('body', 'snippet', 'description', 'comment')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  official boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (source, external_id)
);

create table if not exists public.community_agent_runs (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  day date not null unique,
  status text not null default 'collecting' check (status in ('collecting', 'selected', 'drafted', 'ready', 'deferred', 'failed', 'published')),
  stages jsonb not null default '{}'::jsonb check (jsonb_typeof(stages) = 'object'),
  reports jsonb not null default '[]'::jsonb check (jsonb_typeof(reports) = 'array'),
  topic jsonb,
  draft jsonb,
  validation jsonb,
  model_calls smallint not null default 0 check (model_calls between 0 and 3),
  dry_run boolean not null default false,
  approved_title text,
  approved_html text,
  approved_category text check (approved_category is null or approved_category in ('배그 소식', '자유')),
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  post_id bigint unique references public.posts(id) on delete set null,
  published_at timestamptz,
  reason text,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists community_agent_evidence_expiry_idx
  on public.community_agent_evidence (expires_at, id) where excerpt is not null;
create index if not exists community_agent_runs_created_idx
  on public.community_agent_runs (created_at, run_id);

create or replace function public.validate_community_agent_policy()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.enabled and not exists (
    select 1 from public.profiles as profile_row
    where profile_row.id = new.bot_user_id
      and profile_row.nickname = 'BGMS AI 비서'
      and profile_row.role = 'user'
  ) then
    raise exception 'community_agent_invalid_bot';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists validate_community_agent_policy_before_write on public.community_agent_policy;
create trigger validate_community_agent_policy_before_write
before insert or update on public.community_agent_policy
for each row execute function public.validate_community_agent_policy();

insert into public.community_agent_policy (singleton) values (true)
on conflict (singleton) do nothing;
insert into public.community_agent_sources (id) values ('dc'), ('naver'), ('youtube')
on conflict (id) do nothing;

alter table public.community_agent_policy enable row level security;
alter table public.community_agent_sources enable row level security;
alter table public.community_agent_evidence enable row level security;
alter table public.community_agent_runs enable row level security;

revoke all on table public.community_agent_policy, public.community_agent_sources,
  public.community_agent_evidence, public.community_agent_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.community_agent_policy,
  public.community_agent_sources, public.community_agent_evidence, public.community_agent_runs to service_role;

create or replace function public.community_run_payload(p_run public.community_agent_runs)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_run.run_id,
    'day', p_run.day::text,
    'status', p_run.status,
    'stages', p_run.stages,
    'modelCalls', p_run.model_calls,
    'reports', p_run.reports,
    'topic', p_run.topic,
    'draft', p_run.draft,
    'validation', p_run.validation,
    'dryRun', p_run.dry_run,
    'postId', p_run.post_id,
    'reason', p_run.reason
  );
$$;

create or replace function public.community_evidence_ids(p_ids jsonb, p_max integer)
returns jsonb
language plpgsql immutable security invoker set search_path = ''
as $$
declare
  v_id text;
  v_result jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_ids) is distinct from 'array' then
    raise exception 'community_invalid_evidence_ids';
  end if;
  for v_id in select jsonb_array_elements_text(p_ids) loop
    begin
      perform v_id::uuid;
    exception when invalid_text_representation then
      raise exception 'community_invalid_evidence_id';
    end;
    if v_result ? v_id then
      raise exception 'community_duplicate_evidence_id';
    end if;
    v_count := v_count + 1;
    if v_count > p_max then
      raise exception 'community_too_many_evidence_ids';
    end if;
    v_result := v_result || jsonb_build_array(v_id);
  end loop;
  return v_result;
end;
$$;

create or replace function public.community_short_text_array(p_values jsonb, p_max integer, p_length integer)
returns jsonb
language plpgsql immutable security invoker set search_path = ''
as $$
declare
  v_value text;
  v_result jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_values) is distinct from 'array' then
    raise exception 'community_invalid_text_array';
  end if;
  for v_value in select jsonb_array_elements_text(p_values) loop
    if char_length(v_value) > p_length then raise exception 'community_text_too_long'; end if;
    v_count := v_count + 1;
    if v_count > p_max then raise exception 'community_too_many_text_values'; end if;
    v_result := v_result || jsonb_build_array(v_value);
  end loop;
  return v_result;
end;
$$;

create or replace function public.community_stage_usage(p_result jsonb)
returns jsonb
language plpgsql immutable security invoker set search_path = ''
as $$
declare
  v_usage jsonb := p_result -> 'usage';
  v_prompt bigint;
  v_completion bigint;
begin
  if v_usage is null then return null; end if;
  if jsonb_typeof(v_usage) is distinct from 'object'
    or v_usage - 'promptTokens' - 'completionTokens' <> '{}'::jsonb
    or jsonb_typeof(v_usage -> 'promptTokens') is distinct from 'number'
    or jsonb_typeof(v_usage -> 'completionTokens') is distinct from 'number'
    or coalesce(v_usage ->> 'promptTokens', '') !~ '^\d{1,8}$'
    or coalesce(v_usage ->> 'completionTokens', '') !~ '^\d{1,8}$' then
    raise exception 'community_invalid_stage_usage';
  end if;
  v_prompt := (v_usage ->> 'promptTokens')::bigint;
  v_completion := (v_usage ->> 'completionTokens')::bigint;
  if v_prompt > 10000000 or v_completion > 10000000 then
    raise exception 'community_invalid_stage_usage';
  end if;
  return jsonb_build_object('promptTokens', v_prompt, 'completionTokens', v_completion);
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
    where day = (clock_timestamp() at time zone 'Asia/Seoul')::date
    for update;

    if found and v_run.dry_run and v_run.status = 'ready'
      and v_run.published_at is null and v_run.post_id is null
      and v_run.approved_title is not null and btrim(v_run.approved_title) <> ''
      and v_run.approved_html is not null and v_run.approved_hash is not null
      and v_run.validation ->> 'passed' = 'true'
      and v_run.validation ->> 'contentHash' = v_run.approved_hash
      and v_run.approved_category = any(v_policy.categories) then
      v_render_hash := encode(public.digest(convert_to(v_run.approved_title || E'\n' || v_run.approved_html, 'UTF8'), 'sha256'), 'hex');
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

create or replace function public.expire_community_stages(p_run_id uuid)
returns public.community_agent_runs
language plpgsql security invoker set search_path = ''
as $$
declare
  v_run public.community_agent_runs%rowtype;
  v_stage text;
  v_state jsonb;
  v_started_at timestamptz;
  v_changed boolean := false;
begin
  select * into strict v_run from public.community_agent_runs
  where run_id = p_run_id for update;
  for v_stage, v_state in select key, value from jsonb_each(v_run.stages) loop
    if v_state ->> 'status' <> 'running' then continue; end if;
    begin
      v_started_at := coalesce((v_state ->> 'startedAt')::timestamptz, v_run.created_at);
    exception when others then
      v_started_at := v_run.created_at;
    end;
    if v_started_at <= clock_timestamp() - interval '2 minutes' then
      v_run.stages := jsonb_set(v_run.stages, array[v_stage], jsonb_build_object(
        'status', 'failed',
        'lease', coalesce(v_state ->> 'lease', ''),
        'result', jsonb_build_object('reason', 'lease_expired')
      ), true);
      v_changed := true;
    end if;
  end loop;
  if v_changed then
    update public.community_agent_runs
    set stages = v_run.stages, status = 'deferred', reason = 'stage_lease_expired'
    where run_id = v_run.run_id
    returning * into v_run;
    update public.agent_runs set status = 'completed', completed_at = clock_timestamp()
    where id = v_run.run_id and status = 'running';
  end if;
  return v_run;
end;
$$;

create or replace function public.get_community_run(p_run_id uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare v_run public.community_agent_runs%rowtype;
begin
  select * into strict v_run from public.expire_community_stages(p_run_id);
  return public.community_run_payload(v_run);
end;
$$;

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

  select * into v_run from public.community_agent_runs where day = v_day for update;
  if found then return public.community_run_payload(v_run); end if;

  insert into public.agent_runs (user_id, status, message)
  values (p_actor_id, 'running', 'community-agent') returning id into v_agent_run_id;
  insert into public.community_agent_runs (run_id, day, status, dry_run)
  values (v_agent_run_id, v_day, 'collecting', p_dry_run) returning * into v_run;
  return public.community_run_payload(v_run);
end;
$$;

create or replace function public.claim_community_stage(p_run_id uuid, p_stage text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_stage_state jsonb;
  v_lease uuid;
  v_is_model boolean := p_stage in ('select', 'draft', 'verify');
  v_collect_source text;
begin
  if p_stage not in ('dc', 'naver', 'youtube', 'select', 'draft', 'verify') then
    raise exception 'community_invalid_stage';
  end if;
  select * into strict v_policy from public.community_agent_policy where singleton for update;
  if not v_policy.enabled then raise exception 'community_agent_disabled'; end if;
  select * into strict v_run from public.community_agent_runs where run_id = p_run_id for update;
  select * into v_run from public.expire_community_stages(p_run_id);

  if v_run.day <> (clock_timestamp() at time zone 'Asia/Seoul')::date
    or v_run.status in ('ready', 'deferred', 'failed', 'published') then
    return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
  end if;
  v_stage_state := v_run.stages -> p_stage;
  if v_stage_state is not null then
    return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
  end if;

  if p_stage in ('dc', 'naver', 'youtube') then
    if coalesce((v_policy.source_enabled ->> p_stage)::boolean, false) is false then
      return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
    end if;
  elsif p_stage = 'select' then
    for v_collect_source in select unnest(array['dc', 'naver', 'youtube']) loop
      if coalesce((v_policy.source_enabled ->> v_collect_source)::boolean, false)
        and v_run.stages -> v_collect_source ->> 'status' is distinct from 'completed' then
        return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
      end if;
    end loop;
  elsif p_stage = 'draft' and v_run.stages -> 'select' ->> 'status' is distinct from 'completed' then
    return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
  elsif p_stage = 'verify' and v_run.stages -> 'draft' ->> 'status' is distinct from 'completed' then
    return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
  end if;

  if v_is_model and v_run.model_calls >= 3 then
    update public.community_agent_runs set status = 'deferred', reason = 'model_call_limit'
    where run_id = v_run.run_id returning * into v_run;
    update public.agent_runs set status = 'completed', completed_at = clock_timestamp()
    where id = v_run.run_id and status = 'running';
    return jsonb_build_object('claimed', false, 'lease', null, 'run', public.community_run_payload(v_run));
  end if;

  v_lease := gen_random_uuid();
  update public.community_agent_runs
  set model_calls = model_calls + case when v_is_model then 1 else 0 end,
      stages = jsonb_set(stages, array[p_stage], jsonb_build_object(
        'status', 'running', 'lease', v_lease::text, 'result', '{}'::jsonb, 'startedAt', clock_timestamp()
      ), true)
  where run_id = v_run.run_id returning * into v_run;
  return jsonb_build_object('claimed', true, 'lease', v_lease::text, 'run', public.community_run_payload(v_run));
end;
$$;

create or replace function public.finish_community_stage(
  p_run_id uuid, p_stage text, p_lease uuid, p_result jsonb
)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_stage_state jsonb;
  v_payload jsonb;
  v_safe_result jsonb;
  v_evidence_ids jsonb;
  v_state text;
  v_reason text;
  v_fetched_count integer;
  v_retained_count integer;
  v_channel_id text;
  v_uploads_id text;
  v_kind text;
  v_title text;
  v_topic_key text;
  v_official_update boolean;
  v_question text;
  v_paragraph jsonb;
  v_paragraphs jsonb := '[]'::jsonb;
  v_paragraph_count integer := 0;
  v_text text;
  v_claim_kind text;
  v_recent_window text;
  v_validation jsonb;
  v_reasons jsonb;
  v_passed boolean;
  v_html text;
  v_category text;
  v_hash text;
  v_usage jsonb;
  v_terminal jsonb;
  v_terminal_status text;
begin
  if p_stage not in ('dc', 'naver', 'youtube', 'select', 'draft', 'verify')
    or jsonb_typeof(p_result) is distinct from 'object' then
    raise exception 'community_invalid_stage_result';
  end if;
  select * into strict v_policy from public.community_agent_policy where singleton for update;
  if not v_policy.enabled then raise exception 'community_agent_disabled'; end if;
  select * into strict v_run from public.community_agent_runs where run_id = p_run_id for update;
  v_stage_state := v_run.stages -> p_stage;
  if v_stage_state ->> 'status' is distinct from 'running'
    or v_stage_state ->> 'lease' is distinct from p_lease::text then
    raise exception 'community_stage_lease_mismatch';
  end if;

  v_usage := public.community_stage_usage(p_result);
  v_terminal := p_result -> 'terminal';
  if v_terminal is not null then
    if jsonb_typeof(v_terminal) is distinct from 'object'
      or v_terminal - 'status' - 'reason' <> '{}'::jsonb then
      raise exception 'community_invalid_terminal_result';
    end if;
    v_terminal_status := v_terminal ->> 'status';
    v_reason := v_terminal ->> 'reason';
    if v_terminal_status not in ('deferred', 'failed')
      or v_reason is null or v_reason !~ '^[a-z][a-z0-9_]{0,99}$' then
      raise exception 'community_invalid_terminal_result';
    end if;
    v_safe_result := jsonb_build_object('terminal', jsonb_build_object(
      'status', v_terminal_status, 'reason', v_reason
    )) || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object(
          'status', 'failed', 'lease', p_lease::text, 'result', v_safe_result
        ), true),
        status = v_terminal_status,
        reason = v_reason
    where run_id = v_run.run_id returning * into v_run;
    update public.agent_runs
    set status = case when v_terminal_status = 'failed' then 'failed' else 'completed' end,
        error = case when v_terminal_status = 'failed' then v_reason else null end,
        completed_at = clock_timestamp()
    where id = v_run.run_id and status = 'running';
    return public.community_run_payload(v_run);
  end if;

  if p_stage in ('dc', 'naver', 'youtube') then
    v_payload := coalesce(p_result -> 'report', p_result);
    v_evidence_ids := public.community_evidence_ids(coalesce(v_payload -> 'evidenceIds', '[]'::jsonb), 100);
    v_state := coalesce(v_payload ->> 'state', 'failed');
    if v_state not in ('ok', 'partial', 'empty', 'needs_setup', 'blocked', 'failed', 'disabled') then
      raise exception 'community_invalid_source_state';
    end if;
    v_reason := nullif(left(coalesce(v_payload ->> 'reason', ''), 300), '');
    v_fetched_count := case when jsonb_typeof(v_payload -> 'fetchedCount') = 'number'
      then greatest(0, least((v_payload ->> 'fetchedCount')::integer, 1000)) else 0 end;
    v_retained_count := case when jsonb_typeof(v_payload -> 'retainedCount') = 'number'
      then greatest(0, least((v_payload ->> 'retainedCount')::integer, v_fetched_count)) else 0 end;
    if jsonb_typeof(v_payload -> 'channel') = 'object' then
      v_channel_id := nullif(left(coalesce(v_payload -> 'channel' ->> 'id', ''), 200), '');
      v_uploads_id := nullif(left(coalesce(v_payload -> 'channel' ->> 'uploads', ''), 200), '');
    end if;
    if p_stage <> 'youtube' and (v_channel_id is not null or v_uploads_id is not null) then
      raise exception 'community_channel_only_for_youtube';
    end if;
    v_safe_result := jsonb_build_object(
      'evidenceIds', v_evidence_ids, 'state', v_state,
      'reason', v_reason, 'fetchedCount', v_fetched_count, 'retainedCount', v_retained_count
    );
    if v_channel_id is not null and v_uploads_id is not null then
      v_safe_result := v_safe_result || jsonb_build_object('channel', jsonb_build_object('id', v_channel_id, 'uploads', v_uploads_id));
    end if;
    update public.community_agent_sources
    set resolved_channel_id = case when p_stage = 'youtube' and v_channel_id is not null then v_channel_id else resolved_channel_id end,
        uploads_playlist_id = case when p_stage = 'youtube' and v_uploads_id is not null then v_uploads_id else uploads_playlist_id end,
        state = v_state, reason = v_reason,
        last_success_at = case when v_state in ('ok', 'partial', 'empty') then clock_timestamp() else last_success_at end,
        updated_at = clock_timestamp()
    where id = p_stage;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        reports = reports || jsonb_build_array(v_safe_result || jsonb_build_object('source', p_stage))
    where run_id = v_run.run_id returning * into v_run;

  elsif p_stage = 'select' then
    v_payload := coalesce(p_result -> 'topic', p_result);
    v_kind := v_payload ->> 'kind';
    v_title := v_payload ->> 'title';
    v_topic_key := v_payload ->> 'topicKey';
    v_evidence_ids := public.community_evidence_ids(coalesce(v_payload -> 'evidenceIds', '[]'::jsonb), 10);
    v_reason := nullif(left(coalesce(v_payload ->> 'reason', ''), 500), '');
    v_official_update := coalesce((v_payload ->> 'officialUpdate')::boolean, false);
    if v_kind not in ('news', 'tip', 'question') or v_title is null or char_length(v_title) not between 1 and 120
      or v_topic_key is null or char_length(v_topic_key) not between 1 and 200
      or v_reason is null or jsonb_array_length(v_evidence_ids) = 0 then
      raise exception 'community_invalid_topic';
    end if;
    v_safe_result := jsonb_build_object('kind', v_kind, 'title', v_title, 'topicKey', v_topic_key,
      'evidenceIds', v_evidence_ids, 'reason', v_reason, 'officialUpdate', v_official_update)
      || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        topic = v_safe_result, status = 'selected'
    where run_id = v_run.run_id returning * into v_run;

  elsif p_stage = 'draft' then
    v_payload := coalesce(p_result -> 'draft', p_result);
    v_title := v_payload ->> 'title';
    v_question := v_payload ->> 'question';
    if v_title is null or char_length(v_title) not between 1 and 120 or v_question is null or char_length(v_question) > 200
      or jsonb_typeof(v_payload -> 'paragraphs') is distinct from 'array' then
      raise exception 'community_invalid_draft';
    end if;
    for v_paragraph in select value from jsonb_array_elements(v_payload -> 'paragraphs') loop
      v_paragraph_count := v_paragraph_count + 1;
      if v_paragraph_count > 8 or jsonb_typeof(v_paragraph) is distinct from 'object' then raise exception 'community_invalid_draft'; end if;
      v_text := v_paragraph ->> 'text';
      v_claim_kind := v_paragraph ->> 'kind';
      v_recent_window := v_paragraph ->> 'recentWindow';
      if v_text is null or char_length(v_text) not between 1 and 500
        or v_claim_kind not in ('official_fact', 'observed_opinion', 'suggestion')
        or (v_recent_window is not null and v_recent_window not in ('24h', '7d')) then
        raise exception 'community_invalid_draft';
      end if;
      v_paragraphs := v_paragraphs || jsonb_build_array(jsonb_build_object(
        'text', v_text, 'kind', v_claim_kind,
        'evidenceIds', public.community_evidence_ids(coalesce(v_paragraph -> 'evidenceIds', '[]'::jsonb), 10),
        'recentWindow', v_recent_window
      ));
    end loop;
    if v_paragraph_count = 0 then raise exception 'community_invalid_draft'; end if;
    v_safe_result := jsonb_build_object('title', v_title, 'paragraphs', v_paragraphs, 'question', v_question)
      || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        draft = v_safe_result, validation = null, approved_title = null, approved_html = null,
        approved_category = null, approved_hash = null, status = 'drafted'
    where run_id = v_run.run_id returning * into v_run;

  else
    v_validation := coalesce(p_result -> 'validation', p_result);
    v_passed := v_validation ->> 'passed' = 'true';
    v_reasons := public.community_short_text_array(coalesce(v_validation -> 'reasons', '[]'::jsonb), 20, 300);
    v_hash := coalesce(v_validation ->> 'contentHash', p_result ->> 'contentHash', p_result ->> 'hash');
    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then raise exception 'community_invalid_validation'; end if;
    v_safe_result := jsonb_build_object('passed', v_passed, 'reasons', v_reasons, 'contentHash', v_hash)
      || case when v_usage is null then '{}'::jsonb else jsonb_build_object('usage', v_usage) end;
    v_title := coalesce(p_result ->> 'title', p_result -> 'rendered' ->> 'title');
    v_html := coalesce(p_result ->> 'html', p_result -> 'rendered' ->> 'html');
    v_category := coalesce(p_result ->> 'category', p_result -> 'rendered' ->> 'category');
    if v_passed and (v_title is null or char_length(v_title) not between 1 and 120
      or v_html is null or char_length(v_html) not between 1 and 20000
      or v_category not in ('배그 소식', '자유')) then
      raise exception 'community_invalid_approved_draft';
    end if;
    update public.community_agent_runs
    set stages = jsonb_set(stages, array[p_stage], jsonb_build_object('status', 'completed', 'lease', p_lease::text, 'result', v_safe_result), true),
        validation = v_safe_result,
        approved_title = case when v_passed then v_title else null end,
        approved_html = case when v_passed then v_html else null end,
        approved_category = case when v_passed then v_category else null end,
        approved_hash = case when v_passed then v_hash else null end,
        status = case when v_passed then 'ready' else 'deferred' end,
        reason = case when v_passed then null else 'validation_failed' end
    where run_id = v_run.run_id returning * into v_run;
    if v_run.status in ('ready', 'deferred') then
      update public.agent_runs set status = 'completed', completed_at = clock_timestamp()
      where id = v_run.run_id and status = 'running';
    end if;
  end if;
  return public.community_run_payload(v_run);
end;
$$;

create or replace function public.publish_community_post(p_run_id uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_policy public.community_agent_policy%rowtype;
  v_run public.community_agent_runs%rowtype;
  v_write record;
begin
  select * into strict v_policy from public.community_agent_policy where singleton for update;
  select * into strict v_run from public.community_agent_runs where run_id = p_run_id for update;
  if v_run.published_at is not null then
    return jsonb_build_object('code', 'already_published', 'postId', v_run.post_id);
  end if;
  if v_run.dry_run then
    return jsonb_build_object('code', 'not_ready', 'postId', null);
  end if;
  if not v_policy.enabled or not v_policy.publishing_enabled then
    return jsonb_build_object('code', 'paused', 'postId', null);
  end if;
  if v_run.day <> (clock_timestamp() at time zone 'Asia/Seoul')::date then
    return jsonb_build_object('code', 'expired', 'postId', null);
  end if;
  if v_policy.daily_post_limit = 0 then
    return jsonb_build_object('code', 'limit', 'postId', null);
  end if;
  if v_run.status <> 'ready' or v_run.approved_title is null or btrim(v_run.approved_title) = ''
    or v_run.approved_html is null or v_run.approved_hash is null
    or v_run.validation ->> 'passed' is distinct from 'true'
    or v_run.validation ->> 'contentHash' is distinct from v_run.approved_hash
    or not (v_run.approved_category = any(v_policy.categories)) then
    return jsonb_build_object('code', 'not_ready', 'postId', null);
  end if;
  if not exists (
    select 1 from public.profiles where id = v_policy.bot_user_id
      and nickname = 'BGMS AI 비서' and role = 'user'
  ) then
    return jsonb_build_object('code', 'invalid_bot', 'postId', null);
  end if;
  select * into strict v_write from public.write_board_post_with_images(
    null, v_policy.bot_user_id, null, v_run.approved_title, v_run.approved_html,
    v_run.approved_category, null, false, 'BGMS AI 비서', v_policy.bot_user_id,
    null, null, '', null, null, array[]::uuid[], null
  );
  if v_write.result_code <> 'ok' then raise exception 'community_write_failed'; end if;
  update public.posts set status = 'published' where id = v_write.post_id;
  update public.community_agent_runs set status = 'published', post_id = v_write.post_id,
    published_at = clock_timestamp() where run_id = p_run_id;
  update public.agent_runs set status = 'completed', completed_at = clock_timestamp()
  where id = p_run_id and status = 'running';
  return jsonb_build_object('code', 'published', 'postId', v_write.post_id);
end;
$$;

create or replace function public.cleanup_community_agent()
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_excerpts integer := 0;
  v_drafts integer := 0;
  v_runs integer := 0;
  v_youtube_evidence integer := 0;
  v_youtube_cache integer := 0;
begin
  update public.community_agent_evidence set excerpt = null
  where excerpt is not null and expires_at <= clock_timestamp();
  get diagnostics v_excerpts = row_count;

  update public.community_agent_runs
  set draft = null, validation = null, approved_title = null, approved_html = null,
      approved_category = null, approved_hash = null, status = 'deferred', reason = 'draft_expired'
  where published_at is null and post_id is null and draft is not null
    and created_at < clock_timestamp() - interval '30 days';
  get diagnostics v_drafts = row_count;

  delete from public.community_agent_evidence
  where source = 'youtube'
    and fetched_at <= clock_timestamp() - interval '30 days';
  get diagnostics v_youtube_evidence = row_count;

  update public.community_agent_sources
  set resolved_channel_id = null, uploads_playlist_id = null
  where id = 'youtube'
    and (resolved_channel_id is not null or uploads_playlist_id is not null)
    and last_success_at <= clock_timestamp() - interval '30 days';
  get diagnostics v_youtube_cache = row_count;

  delete from public.agent_runs as agent_run
  using public.community_agent_runs as community_run
  where community_run.run_id = agent_run.id
    and community_run.created_at < clock_timestamp() - interval '90 days';
  get diagnostics v_runs = row_count;

  delete from public.community_agent_evidence as evidence_row
  where evidence_row.fetched_at < clock_timestamp() - interval '90 days'
    and not exists (
      select 1 from public.community_agent_runs as run_row
      where run_row.reports @> jsonb_build_array(jsonb_build_object('evidenceIds', jsonb_build_array(evidence_row.id::text)))
        or run_row.topic @> jsonb_build_object('evidenceIds', jsonb_build_array(evidence_row.id::text))
    );
  return jsonb_build_object(
    'excerpts', v_excerpts,
    'drafts', v_drafts,
    'runs', v_runs,
    'youtubeEvidence', v_youtube_evidence,
    'youtubeCache', v_youtube_cache
  );
end;
$$;

revoke all on function public.validate_community_agent_policy(),
  public.community_run_payload(public.community_agent_runs),
  public.community_evidence_ids(jsonb, integer), public.community_short_text_array(jsonb, integer, integer),
  public.community_stage_usage(jsonb),
  public.configure_community_agent_policy(jsonb),
  public.expire_community_stages(uuid), public.get_community_run(uuid), public.start_community_run(uuid, boolean),
  public.claim_community_stage(uuid, text), public.finish_community_stage(uuid, text, uuid, jsonb),
  public.publish_community_post(uuid), public.cleanup_community_agent() from public, anon, authenticated;
grant execute on function public.community_run_payload(public.community_agent_runs),
  public.community_evidence_ids(jsonb, integer), public.community_short_text_array(jsonb, integer, integer),
  public.community_stage_usage(jsonb),
  public.configure_community_agent_policy(jsonb),
  public.expire_community_stages(uuid), public.get_community_run(uuid), public.start_community_run(uuid, boolean),
  public.claim_community_stage(uuid, text), public.finish_community_stage(uuid, text, uuid, jsonb),
  public.publish_community_post(uuid), public.cleanup_community_agent() to service_role;
