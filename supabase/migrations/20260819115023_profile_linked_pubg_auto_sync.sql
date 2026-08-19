-- The 2026-04-28 Supabase Data API exposure change makes grants explicit for
-- new public-schema objects. This state table is intentionally service-role only.

create table public.pubg_linked_player_sync_state (
  platform text not null check (platform in ('steam', 'kakao')),
  normalized_nickname text not null check (btrim(normalized_nickname) <> ''),
  display_nickname text not null check (btrim(display_nickname) <> ''),
  status text not null default 'idle' check (
    status in ('idle', 'running', 'success', 'failed', 'invalid_nickname', 'rate_limited')
  ),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_eligible_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (platform, normalized_nickname)
);

alter table public.pubg_linked_player_sync_state enable row level security;

revoke all on table public.pubg_linked_player_sync_state from public;
revoke all on table public.pubg_linked_player_sync_state from anon, authenticated;
grant all on table public.pubg_linked_player_sync_state to service_role;

create or replace function public.list_pubg_linked_sync_candidates(
  p_limit integer,
  p_active_since timestamptz
)
returns table (
  platform text,
  normalized_nickname text,
  display_nickname text,
  last_active_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with linked_profiles as (
    select
      lower(btrim(profile.pubg_platform)) as platform,
      lower(btrim(profile.pubg_nickname)) as normalized_nickname,
      (
        array_agg(
          btrim(profile.pubg_nickname)
          order by profile.last_active_at desc nulls last,
            profile.updated_at desc nulls last,
            profile.id
        )
      )[1] as display_nickname,
      max(profile.last_active_at) as last_active_at
    from public.profiles as profile
    where profile.pubg_nickname is not null
      and btrim(profile.pubg_nickname) <> ''
      and lower(btrim(coalesce(profile.pubg_platform, ''))) in ('steam', 'kakao')
      and profile.last_active_at >= p_active_since
    group by lower(btrim(profile.pubg_platform)), lower(btrim(profile.pubg_nickname))
  )
  select
    linked.platform,
    linked.normalized_nickname,
    linked.display_nickname,
    linked.last_active_at,
    state.last_success_at,
    coalesce(state.consecutive_failures, 0) as consecutive_failures
  from linked_profiles as linked
  left join public.pubg_linked_player_sync_state as state
    on state.platform = linked.platform
    and state.normalized_nickname = linked.normalized_nickname
  where (state.next_eligible_at is null or state.next_eligible_at <= now())
    and (
      state.status is distinct from 'running'
      or state.lease_token is null
      or state.lease_expires_at is null
      or state.lease_expires_at <= now()
    )
  order by state.last_success_at nulls first,
    state.last_success_at asc,
    linked.last_active_at desc
  limit least(greatest(coalesce(p_limit, 15), 0), 15);
$function$;

create or replace function public.claim_pubg_linked_sync(
  p_platform text,
  p_normalized_nickname text,
  p_display_nickname text,
  p_lease_token uuid,
  p_lease_expires_at timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_platform text := lower(btrim(coalesce(p_platform, '')));
  v_normalized_nickname text := lower(btrim(coalesce(p_normalized_nickname, '')));
  v_display_nickname text := nullif(btrim(coalesce(p_display_nickname, '')), '');
  v_updated_rows integer;
begin
  if v_platform not in ('steam', 'kakao')
    or v_normalized_nickname = ''
    or p_lease_token is null
    or p_lease_expires_at is null
    or p_lease_expires_at <= now() then
    return false;
  end if;

  if not exists (
    select 1
    from public.profiles as profile
    where lower(btrim(coalesce(profile.pubg_platform, ''))) = v_platform
      and lower(btrim(coalesce(profile.pubg_nickname, ''))) = v_normalized_nickname
      and profile.pubg_nickname is not null
      and btrim(profile.pubg_nickname) <> ''
  ) then
    return false;
  end if;

  insert into public.pubg_linked_player_sync_state (
    platform,
    normalized_nickname,
    display_nickname,
    status
  ) values (
    v_platform,
    v_normalized_nickname,
    coalesce(v_display_nickname, v_normalized_nickname),
    'idle'
  )
  on conflict (platform, normalized_nickname) do nothing;

  update public.pubg_linked_player_sync_state as state
  set display_nickname = coalesce(v_display_nickname, state.display_nickname, v_normalized_nickname),
      status = 'running',
      last_attempt_at = now(),
      lease_token = p_lease_token,
      lease_expires_at = p_lease_expires_at,
      updated_at = now()
  where state.platform = v_platform
    and state.normalized_nickname = v_normalized_nickname
    and (
      state.status is distinct from 'running'
      or state.lease_token is null
      or state.lease_expires_at is null
      or state.lease_expires_at <= now()
    )
    and (state.next_eligible_at is null or state.next_eligible_at <= now())
    and exists (
      select 1
      from public.profiles as profile
      where lower(btrim(coalesce(profile.pubg_platform, ''))) = v_platform
        and lower(btrim(coalesce(profile.pubg_nickname, ''))) = v_normalized_nickname
        and profile.pubg_nickname is not null
        and btrim(profile.pubg_nickname) <> ''
    );

  get diagnostics v_updated_rows = row_count;
  return v_updated_rows = 1;
end;
$function$;

create or replace function public.complete_pubg_linked_sync(
  p_platform text,
  p_normalized_nickname text,
  p_lease_token uuid,
  p_status text,
  p_last_success_at timestamptz,
  p_next_eligible_at timestamptz,
  p_consecutive_failures integer,
  p_last_error_code text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_updated_rows integer;
begin
  if p_status is null
    or p_status not in ('idle', 'running', 'success', 'failed', 'invalid_nickname', 'rate_limited')
    or p_consecutive_failures is null
    or p_consecutive_failures < 0 then
    return false;
  end if;

  update public.pubg_linked_player_sync_state as state
  set status = p_status,
      last_success_at = p_last_success_at,
      next_eligible_at = p_next_eligible_at,
      consecutive_failures = p_consecutive_failures,
      last_error_code = p_last_error_code,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where state.platform = lower(btrim(coalesce(p_platform, '')))
    and state.normalized_nickname = lower(btrim(coalesce(p_normalized_nickname, '')))
    and state.lease_token = p_lease_token;

  get diagnostics v_updated_rows = row_count;
  return v_updated_rows = 1;
end;
$function$;

revoke all on function public.list_pubg_linked_sync_candidates(integer, timestamptz) from public;
revoke all on function public.list_pubg_linked_sync_candidates(integer, timestamptz) from anon, authenticated;
grant execute on function public.list_pubg_linked_sync_candidates(integer, timestamptz) to service_role;

revoke all on function public.claim_pubg_linked_sync(text, text, text, uuid, timestamptz) from public;
revoke all on function public.claim_pubg_linked_sync(text, text, text, uuid, timestamptz) from anon, authenticated;
grant execute on function public.claim_pubg_linked_sync(text, text, text, uuid, timestamptz) to service_role;

revoke all on function public.complete_pubg_linked_sync(text, text, uuid, text, timestamptz, timestamptz, integer, text) from public;
revoke all on function public.complete_pubg_linked_sync(text, text, uuid, text, timestamptz, timestamptz, integer, text) from anon, authenticated;
grant execute on function public.complete_pubg_linked_sync(text, text, uuid, text, timestamptz, timestamptz, integer, text) to service_role;
