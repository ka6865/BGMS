alter table public.telemetry_map_cache_entries
  add column if not exists lease_token uuid;

drop function if exists public.finalize_telemetry_cache_write(
  text, text, text, numeric, text, text, text, text, numeric,
  timestamptz, text, text, jsonb, timestamptz
);

create or replace function public.claim_telemetry_cache_write(
  p_match_id text,
  p_platform text,
  p_player_id text,
  p_mode text,
  p_telemetry_version numeric,
  p_storage_path text,
  p_lease_expires_at timestamptz,
  p_lease_token uuid,
  p_updated_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed boolean;
begin
  if p_match_id is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_mode not in ('lite', 'full')
    or p_telemetry_version is null
    or p_storage_path is null
    or p_lease_expires_at is null
    or p_lease_token is null
    or p_updated_at is null
  then
    raise exception 'telemetry-claim-invalid-input' using errcode = '22023';
  end if;

  insert into public.telemetry_map_cache_entries as cache (
    match_id,
    platform,
    player_id,
    mode,
    telemetry_version,
    storage_path,
    status,
    lease_expires_at,
    lease_token,
    updated_at
  ) values (
    p_match_id,
    p_platform,
    p_player_id,
    p_mode,
    p_telemetry_version,
    p_storage_path,
    'pending',
    p_lease_expires_at,
    p_lease_token,
    p_updated_at
  )
  on conflict (match_id, platform, player_id, mode, telemetry_version) do update set
    storage_path = excluded.storage_path,
    status = 'pending',
    lease_expires_at = excluded.lease_expires_at,
    lease_token = excluded.lease_token,
    updated_at = excluded.updated_at
  where cache.status = 'ready'
    or (
      cache.status = 'pending'
      and (cache.lease_expires_at is null or cache.lease_expires_at <= now())
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_telemetry_cache_write(
  p_match_id text,
  p_platform text,
  p_player_id text,
  p_mode text,
  p_telemetry_version numeric,
  p_lease_token uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_match_id is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_mode not in ('lite', 'full')
    or p_telemetry_version is null
    or p_lease_token is null
  then
    raise exception 'telemetry-release-invalid-input' using errcode = '22023';
  end if;

  delete from public.telemetry_map_cache_entries as cache
  where cache.match_id = p_match_id
    and cache.platform = p_platform
    and cache.player_id = p_player_id
    and cache.mode = p_mode
    and cache.telemetry_version = p_telemetry_version
    and cache.status = 'pending'
    and cache.lease_token = p_lease_token;
end;
$$;

create or replace function public.finalize_telemetry_cache_write(
  p_match_id text,
  p_map_name text,
  p_game_mode text,
  p_master_version numeric,
  p_storage_path text,
  p_platform text,
  p_player_id text,
  p_mode text,
  p_cache_version numeric,
  p_cache_updated_at timestamptz,
  p_cache_lease_token uuid,
  p_processed_player_id text,
  p_processed_platform text,
  p_processed_data jsonb,
  p_processed_updated_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_match_id is null
    or p_map_name is null
    or p_game_mode is null
    or p_master_version is null
    or p_storage_path is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_mode not in ('lite', 'full')
    or p_cache_version is null
    or p_cache_updated_at is null
    or not (
      (
        p_processed_player_id is null
        and p_processed_platform is null
        and p_processed_data is null
        and p_processed_updated_at is null
      )
      or (
        p_processed_player_id is not null
        and p_processed_platform is not null
        and p_processed_data is not null
        and p_processed_updated_at is not null
      )
    )
  then
    raise exception 'telemetry-finalize-invalid-input' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_match_id, 1952805741));

  if p_cache_lease_token is not null and not exists (
    select 1
    from public.telemetry_map_cache_entries as cache
    where cache.match_id = p_match_id
      and cache.platform = p_platform
      and cache.player_id = p_player_id
      and cache.mode = p_mode
      and cache.telemetry_version = p_cache_version
      and cache.status = 'pending'
      and cache.lease_token = p_cache_lease_token
    for update
  ) then
    raise exception 'telemetry-finalize-lease-lost' using errcode = '40001';
  end if;

  insert into public.match_master_telemetry (
    match_id,
    map_name,
    game_mode,
    telemetry_version,
    storage_path
  ) values (
    p_match_id,
    p_map_name,
    p_game_mode,
    p_master_version,
    p_storage_path
  )
  on conflict (match_id) do update set
    map_name = excluded.map_name,
    game_mode = excluded.game_mode,
    telemetry_version = excluded.telemetry_version,
    storage_path = excluded.storage_path;

  if p_processed_data is not null then
    insert into public.processed_match_telemetry (
      match_id,
      platform,
      player_id,
      data,
      updated_at
    ) values (
      p_match_id,
      p_processed_platform,
      p_processed_player_id,
      p_processed_data,
      p_processed_updated_at
    )
    on conflict (match_id, platform, player_id) do update set
      data = excluded.data,
      updated_at = excluded.updated_at;
  end if;

  insert into public.telemetry_map_cache_entries as cache (
    match_id,
    platform,
    player_id,
    mode,
    telemetry_version,
    storage_path,
    status,
    lease_expires_at,
    lease_token,
    updated_at
  ) values (
    p_match_id,
    p_platform,
    p_player_id,
    p_mode,
    p_cache_version,
    p_storage_path,
    'ready',
    null,
    null,
    p_cache_updated_at
  )
  on conflict (match_id, platform, player_id, mode, telemetry_version) do update set
    storage_path = excluded.storage_path,
    status = excluded.status,
    lease_expires_at = excluded.lease_expires_at,
    lease_token = excluded.lease_token,
    updated_at = excluded.updated_at
  where p_cache_lease_token is null or cache.lease_token = p_cache_lease_token;

  if not found then
    raise exception 'telemetry-finalize-lease-lost' using errcode = '40001';
  end if;
end;
$$;

revoke all on function public.claim_telemetry_cache_write(
  text, text, text, text, numeric, text, timestamptz, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.release_telemetry_cache_write(
  text, text, text, text, numeric, uuid
) from public, anon, authenticated;
revoke all on function public.finalize_telemetry_cache_write(
  text, text, text, numeric, text, text, text, text, numeric,
  timestamptz, uuid, text, text, jsonb, timestamptz
) from public, anon, authenticated;

grant execute on function public.claim_telemetry_cache_write(
  text, text, text, text, numeric, text, timestamptz, uuid, timestamptz
) to service_role;
grant execute on function public.release_telemetry_cache_write(
  text, text, text, text, numeric, uuid
) to service_role;
grant execute on function public.finalize_telemetry_cache_write(
  text, text, text, numeric, text, text, text, text, numeric,
  timestamptz, uuid, text, text, jsonb, timestamptz
) to service_role;
