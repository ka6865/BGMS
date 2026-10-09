-- 최근 후보 보존과 실제 잔여 개수 계약을 복구한다. 기존 배치 기본값은 유지한다.
create or replace function public.compact_pubg_player_cache(
  p_retention_days integer default 90,
  p_apply boolean default false,
  p_batch_limit integer default 500,
  p_keep_recent integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  retention_days integer := coalesce(p_retention_days, 90);
  apply_changes boolean := coalesce(p_apply, false);
  batch_limit integer := coalesce(p_batch_limit, 500);
  keep_recent integer := p_keep_recent;
  cutoff timestamptz;
  keep_boundary timestamptz;
  keep_boundary_id text;
  candidate_count bigint := 0;
  deleted_count bigint := 0;
  total_count bigint := 0;
begin
  if retention_days < 1 then
    raise exception 'player-cache-compaction-invalid-retention' using errcode = '22023';
  end if;
  if batch_limit < 10 or batch_limit > 20000 then
    raise exception 'player-cache-compaction-invalid-batch-limit' using errcode = '22023';
  end if;
  if keep_recent is not null and keep_recent < 0 then
    raise exception 'player-cache-compaction-invalid-keep-recent' using errcode = '22023';
  end if;

  cutoff := now() - make_interval(days => retention_days);

  -- ID까지 비교해 같은 수집 시각과 NULL 시각에서도 최근 N개를 정확히 보호한다.
  if keep_recent > 0 then
    select cache.updated_at, cache.id
    into keep_boundary, keep_boundary_id
    from public.pubg_player_cache as cache
    order by cache.updated_at desc nulls last, cache.id desc
    offset (keep_recent - 1)
    limit 1;
  end if;

  select count(*) into candidate_count
  from public.pubg_player_cache as cache
  where cache.search_count = 0
    and cache.season_stats_data is null
    and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
    and (
      keep_recent is null or keep_recent = 0
      or (keep_boundary_id is not null and (
        (cache.updated_at, cache.id) < (keep_boundary, keep_boundary_id)
        or (cache.updated_at is null and (keep_boundary is not null or cache.id < keep_boundary_id))
      ))
    );

  if apply_changes and candidate_count > 0 then
    with doomed as (
      select cache.id
      from public.pubg_player_cache as cache
      where cache.search_count = 0
        and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
        and (
          keep_recent is null or keep_recent = 0
          or (keep_boundary_id is not null and (
            (cache.updated_at, cache.id) < (keep_boundary, keep_boundary_id)
            or (cache.updated_at is null and (keep_boundary is not null or cache.id < keep_boundary_id))
          ))
        )
      order by cache.updated_at asc nulls first, cache.id asc
      limit batch_limit
      for update skip locked
    )
    delete from public.pubg_player_cache as cache
    using doomed
    where cache.id = doomed.id;

    get diagnostics deleted_count = row_count;
  end if;

  select count(*) into total_count from public.pubg_player_cache;
  return jsonb_build_object(
    'candidate_count', candidate_count,
    'deleted_count', deleted_count,
    'remaining_count', greatest(candidate_count - deleted_count, 0),
    'total_count', total_count,
    'retention_days', retention_days,
    'keep_recent', keep_recent,
    'dry_run', not apply_changes
  );
end;
$$;

revoke all on function public.compact_pubg_player_cache(integer, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.compact_pubg_player_cache(integer, boolean, integer, integer)
  to service_role;
