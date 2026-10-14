-- 정리 대상 조건의 OR(updated_at 이 있는 행의 행 비교 / updated_at 이 null 인 행)을 두 질의로 나눈다.
-- OR 형태에서는 플래너가 테이블 본문을 읽는 계획을 골라 대상 수 계산이 3~5초 걸렸고,
-- 나누면 pubg_player_cache_compaction_candidates_idx 만으로 센다(운영 실측 4.9초 → 2.4초, 캐시 적중 시 0.1초).
-- 반환 계약·삭제 순서(updated_at null 먼저, 그다음 updated_at·id 오름차순)는 그대로다.
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
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  retention_days integer := coalesce(p_retention_days, 90);
  apply_changes boolean := coalesce(p_apply, false);
  batch_limit integer := coalesce(p_batch_limit, 500);
  keep_recent integer := p_keep_recent;
  use_boundary boolean := coalesce(p_keep_recent, 0) > 0;
  cutoff timestamptz;
  keep_boundary timestamptz;
  keep_boundary_id text;
  candidate_count bigint := 0;
  deleted_count bigint := 0;
  dated_deleted bigint := 0;
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
  if use_boundary then
    select cache.updated_at, cache.id
    into keep_boundary, keep_boundary_id
    from public.pubg_player_cache as cache
    order by cache.updated_at desc nulls last, cache.id desc
    offset (keep_recent - 1)
    limit 1;
  end if;

  -- 경계 행이 없으면(보존 수보다 행이 적으면) 두 조건 모두 null 이 되어 대상이 없다.
  select
    (select count(*) from public.pubg_player_cache as cache
      where cache.search_count = 0 and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
        and cache.updated_at is null
        and (not use_boundary or keep_boundary is not null or cache.id < keep_boundary_id))
    + (select count(*) from public.pubg_player_cache as cache
      where cache.search_count = 0 and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
        and cache.updated_at is not null
        and (not use_boundary or (cache.updated_at, cache.id) < (keep_boundary, keep_boundary_id)))
  into candidate_count;

  if apply_changes and candidate_count > 0 then
    with doomed as (
      select cache.id
      from public.pubg_player_cache as cache
      where cache.search_count = 0 and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
        and cache.updated_at is null
        and (not use_boundary or keep_boundary is not null or cache.id < keep_boundary_id)
      order by cache.id asc
      limit batch_limit
      for update skip locked
    )
    delete from public.pubg_player_cache as cache
    using doomed
    where cache.id = doomed.id;
    get diagnostics deleted_count = row_count;

    if deleted_count < batch_limit then
      with doomed as (
        select cache.id
        from public.pubg_player_cache as cache
        where cache.search_count = 0 and cache.season_stats_data is null
          and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
          and cache.updated_at is not null
          and (not use_boundary or (cache.updated_at, cache.id) < (keep_boundary, keep_boundary_id))
        order by cache.updated_at asc, cache.id asc
        limit batch_limit - deleted_count
        for update skip locked
      )
      delete from public.pubg_player_cache as cache
      using doomed
      where cache.id = doomed.id;
      get diagnostics dated_deleted = row_count;
      deleted_count := deleted_count + dated_deleted;
    end if;
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
