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

  insert into public.telemetry_map_cache_entries (
    match_id,
    platform,
    player_id,
    mode,
    telemetry_version,
    storage_path,
    status,
    lease_expires_at,
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
    p_cache_updated_at
  )
  on conflict (match_id, platform, player_id, mode, telemetry_version) do update set
    storage_path = excluded.storage_path,
    status = excluded.status,
    lease_expires_at = excluded.lease_expires_at,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.finalize_telemetry_cache_write(
  text, text, text, numeric, text, text, text, text, numeric,
  timestamptz, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.finalize_telemetry_cache_write(
  text, text, text, numeric, text, text, text, text, numeric,
  timestamptz, text, text, jsonb, timestamptz
) to service_role;

create or replace function public.lock_telemetry_cache_match()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  first_match_id text;
  second_match_id text;
begin
  if tg_op = 'DELETE' then
    first_match_id := old.match_id;
  elsif tg_op = 'UPDATE' and old.match_id is distinct from new.match_id then
    first_match_id := least(old.match_id, new.match_id);
    second_match_id := greatest(old.match_id, new.match_id);
  else
    first_match_id := new.match_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(first_match_id, 1952805741));
  if second_match_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(second_match_id, 1952805741));
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.lock_telemetry_cache_match()
  from public, anon, authenticated;
grant execute on function public.lock_telemetry_cache_match()
  to service_role;

drop trigger if exists telemetry_cache_match_lock
  on public.telemetry_map_cache_entries;
create trigger telemetry_cache_match_lock
before insert or update or delete
on public.telemetry_map_cache_entries
for each row
execute function public.lock_telemetry_cache_match();

create or replace function public.cleanup_expired_telemetry_matches(
  p_match_ids text[],
  p_cutoff timestamptz,
  p_target_version numeric,
  p_now timestamptz
)
returns table(match_id text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  requested_match_ids text[];
  advisory_locked_match_ids text[] := array[]::text[];
  locked_cache_ids bigint[];
  locked_master_match_ids text[];
  eligible_match_ids text[];
  candidate_match_id text;
begin
  if p_match_ids is null
    or p_cutoff is null
    or p_target_version is null
    or p_now is null
    or cardinality(p_match_ids) > 50
  then
    raise exception 'telemetry-cleanup-invalid-rpc-input' using errcode = '22023';
  end if;

  select coalesce(
    array_agg(distinct input.match_id order by input.match_id),
    array[]::text[]
  )
  into requested_match_ids
  from unnest(p_match_ids) as input(match_id)
  where input.match_id is not null;

  foreach candidate_match_id in array requested_match_ids
  loop
    if pg_try_advisory_xact_lock(
      hashtextextended(candidate_match_id, 1952805741)
    ) then
      advisory_locked_match_ids := array_append(
        advisory_locked_match_ids,
        candidate_match_id
      );
    end if;
  end loop;

  if cardinality(advisory_locked_match_ids) = 0 then
    return;
  end if;

  with requested as (
    select input.match_id
    from unnest(advisory_locked_match_ids) as input(match_id)
    order by input.match_id
  ), locked_cache as (
    select cache.id, cache.match_id
    from public.telemetry_map_cache_entries as cache
    join requested on requested.match_id = cache.match_id
    order by cache.match_id, cache.id
    for update of cache skip locked
  )
  select coalesce(
    array_agg(locked_cache.id order by locked_cache.match_id, locked_cache.id),
    array[]::bigint[]
  )
  into locked_cache_ids
  from locked_cache;

  select coalesce(
    array_agg(candidate.match_id order by candidate.match_id),
    array[]::text[]
  )
  into eligible_match_ids
  from (
    select input.match_id
    from unnest(advisory_locked_match_ids) as input(match_id)
  ) as candidate
  where not exists (
    select 1
    from public.telemetry_map_cache_entries as cache
    where cache.match_id = candidate.match_id
      and not (cache.id = any(locked_cache_ids))
  );

  if cardinality(eligible_match_ids) = 0 then
    return;
  end if;

  with requested as (
    select input.match_id
    from unnest(eligible_match_ids) as input(match_id)
    order by input.match_id
  ), locked_master as (
    select master.match_id
    from public.match_master_telemetry as master
    join requested on requested.match_id = master.match_id
    order by master.match_id
    for update skip locked
  )
  select coalesce(
    array_agg(locked_master.match_id order by locked_master.match_id),
    array[]::text[]
  )
  into locked_master_match_ids
  from locked_master;

  select coalesce(
    array_agg(candidate.match_id order by candidate.match_id),
    array[]::text[]
  )
  into eligible_match_ids
  from unnest(eligible_match_ids) as candidate(match_id)
  where not exists (
    select 1
    from public.match_master_telemetry as master
    where master.match_id = candidate.match_id
  )
    or candidate.match_id = any(locked_master_match_ids);

  select coalesce(
    array_agg(requested.match_id order by requested.match_id),
    array[]::text[]
  )
  into eligible_match_ids
  from unnest(eligible_match_ids) as requested(match_id)
  left join public.match_master_telemetry as master
    on master.match_id = requested.match_id
  where (
      (
        master.match_id is not null
        and (
          master.telemetry_version < p_target_version
          or master.created_at < p_cutoff
        )
      )
      or (
        master.match_id is null
        and exists (
          select 1
          from public.telemetry_map_cache_entries as orphan_cache
          where orphan_cache.match_id = requested.match_id
            and (
              (
                orphan_cache.status = 'ready'
                and orphan_cache.updated_at < p_cutoff
              )
              or (
                orphan_cache.status = 'pending'
                and (
                  orphan_cache.lease_expires_at is null
                  or orphan_cache.lease_expires_at < p_now
                )
              )
            )
        )
      )
    )
    and not exists (
      select 1
      from public.telemetry_map_cache_entries as cache
      where cache.match_id = requested.match_id
        and (
          (cache.status = 'ready' and cache.updated_at >= p_cutoff)
          or (
            cache.status = 'pending'
            and cache.lease_expires_at >= p_now
          )
        )
    );

  if cardinality(eligible_match_ids) = 0 then
    return;
  end if;

  delete from public.match_stats_raw as stats
  where stats.match_id = any(eligible_match_ids);

  delete from public.processed_match_telemetry as processed
  where processed.match_id = any(eligible_match_ids);

  delete from public.telemetry_map_cache_entries as cache
  where cache.match_id = any(eligible_match_ids)
    and (
      (cache.status = 'ready' and cache.updated_at < p_cutoff)
      or (
        cache.status = 'pending'
        and (
          cache.lease_expires_at is null
          or cache.lease_expires_at < p_now
        )
      )
    );

  delete from public.match_master_telemetry as master
  where master.match_id = any(eligible_match_ids)
    and (
      master.telemetry_version < p_target_version
      or master.created_at < p_cutoff
    )
    and not exists (
      select 1
      from public.telemetry_map_cache_entries as cache
      where cache.match_id = master.match_id
    );

  if exists (
    select 1
    from public.telemetry_map_cache_entries as cache
    where cache.match_id = any(eligible_match_ids)
  ) or exists (
    select 1
    from public.match_master_telemetry as master
    where master.match_id = any(eligible_match_ids)
  ) then
    raise exception 'telemetry-cleanup-postcondition-failed' using errcode = '40001';
  end if;

  return query
  select eligible.match_id
  from unnest(eligible_match_ids) as eligible(match_id)
  order by eligible.match_id;
end;
$$;

revoke all on function public.cleanup_expired_telemetry_matches(text[], timestamptz, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_telemetry_matches(text[], timestamptz, numeric, timestamptz)
  to service_role;

create or replace function public.reserve_pubg_api_alert_delivery(
  p_alert_key text,
  p_window_started_at timestamptz
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with inserted as (
    insert into public.pubg_api_alert_deliveries (
      alert_key,
      window_started_at
    )
    values (
      p_alert_key,
      p_window_started_at
    )
    on conflict do nothing
    returning true as reserved
  )
  select coalesce(
    (select inserted.reserved from inserted),
    false
  );
$$;

revoke all on function public.reserve_pubg_api_alert_delivery(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_pubg_api_alert_delivery(text, timestamptz)
  to service_role;
