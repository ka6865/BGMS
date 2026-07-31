-- 자동완성 후보 풀에 상한을 둔다.
--
-- 20260801150000 의 정책은 사용자 활동 신호가 없는 행을 전부 삭제 대상으로
-- 본다. 실측에서 삭제 대상이 429,358행이고 유지가 589행이었다.
--
-- 그런데 자동완성 품질 측정 결과, 후보 풀을 589행으로 줄이면 접두사 15종에
-- 대한 제안 건수가 114건에서 32건으로 떨어졌다. 검색 당사자는 항상 나오지만
-- 다른 플레이어 이름 제안은 크게 줄어든다.
--
-- 용량과 품질을 함께 잡기 위해 "최근 관측 순 상위 N개는 남긴다"를 더한다.
-- 자동완성은 최근 갱신 순으로 정렬해 8건만 반환하므로, 오래된 행을 잘라도
-- 실제 제안 품질에 미치는 영향이 작다.
--
-- 행당 약 0.394KB(인덱스 포함) 기준 용량 예상:
--     50,000행 유지 ->  19MB (146MB 회수)
--    150,000행 유지 ->  58MB (108MB 회수)
--
-- p_keep_recent 가 null 이면 상한 없이 20260801150000 과 동일하게 동작한다.
create or replace function public.compact_pubg_player_cache(
  p_retention_days integer default 90,
  p_apply boolean default false,
  p_batch_limit integer default 5000,
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
  batch_limit integer := coalesce(p_batch_limit, 5000);
  keep_recent integer := p_keep_recent;
  cutoff timestamptz;
  keep_boundary timestamptz;
  candidate_count bigint := 0;
  deleted_count bigint := 0;
  remaining_count bigint := 0;
  total_count bigint := 0;
begin
  if retention_days < 1 then
    raise exception 'player-cache-compaction-invalid-retention' using errcode = '22023';
  end if;
  if batch_limit < 100 or batch_limit > 20000 then
    raise exception 'player-cache-compaction-invalid-batch-limit' using errcode = '22023';
  end if;
  if keep_recent is not null and keep_recent < 0 then
    raise exception 'player-cache-compaction-invalid-keep-recent' using errcode = '22023';
  end if;

  cutoff := now() - make_interval(days => retention_days);

  -- 상한이 있으면 "최근 관측 순 keep_recent 번째" 행의 updated_at 을 경계로 쓴다.
  -- 그보다 오래된 행만 삭제 후보가 된다. 경계를 못 구하면(행이 상한보다 적음)
  -- 삭제할 것이 없다.
  if keep_recent is not null then
    select boundary.updated_at
    into keep_boundary
    from (
      select cache.updated_at
      from public.pubg_player_cache as cache
      order by cache.updated_at desc
      offset keep_recent
      limit 1
    ) as boundary;

    if keep_boundary is null then
      select count(*) into total_count from public.pubg_player_cache;
      return jsonb_build_object(
        'candidate_count', 0,
        'deleted_count', 0,
        'remaining_count', 0,
        'total_count', total_count,
        'retention_days', retention_days,
        'keep_recent', keep_recent,
        'dry_run', not apply_changes
      );
    end if;
  end if;

  select count(*)
  into candidate_count
  from public.pubg_player_cache as cache
  where cache.search_count = 0
    and cache.season_stats_data is null
    and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
    and (keep_boundary is null or cache.updated_at <= keep_boundary);

  if apply_changes and candidate_count > 0 then
    with doomed as (
      select cache.id
      from public.pubg_player_cache as cache
      where cache.search_count = 0
        and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
        and (keep_boundary is null or cache.updated_at <= keep_boundary)
      order by cache.updated_at
      limit batch_limit
    )
    delete from public.pubg_player_cache as cache
    using doomed
    where cache.id = doomed.id;

    get diagnostics deleted_count = row_count;
  end if;

  remaining_count := greatest(candidate_count - deleted_count, 0);
  select count(*) into total_count from public.pubg_player_cache;

  return jsonb_build_object(
    'candidate_count', candidate_count,
    'deleted_count', deleted_count,
    'remaining_count', remaining_count,
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

-- 인자 4개 버전으로 대체되었으므로 3개 버전은 제거해 호출 모호성을 없앤다.
drop function if exists public.compact_pubg_player_cache(integer, boolean, integer);
