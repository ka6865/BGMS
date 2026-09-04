-- Recovery claims are intentionally stricter than ordinary telemetry-cache
-- writes.  A recovery request may only create a previously absent v61 row;
-- an existing ready or pending row is an unknown side effect and must remain
-- untouched for reconciliation.
create or replace function public.claim_telemetry_cache_recovery_write(
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
    or p_mode <> 'lite'
    or p_telemetry_version is null
    or p_storage_path is null
    or p_lease_expires_at is null
    or p_lease_token is null
    or p_updated_at is null
  then
    raise exception 'telemetry-recovery-claim-invalid-input' using errcode = '22023';
  end if;

  insert into public.telemetry_map_cache_entries (
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
  on conflict (match_id, platform, player_id, mode, telemetry_version)
  do nothing
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_telemetry_cache_recovery_write(
  text, text, text, text, numeric, text, timestamptz, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_telemetry_cache_recovery_write(
  text, text, text, text, numeric, text, timestamptz, uuid, timestamptz
) to service_role;
