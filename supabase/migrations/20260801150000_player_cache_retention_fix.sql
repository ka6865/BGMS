-- compact_pubg_player_cache 의 보존 조건에서 updated_at 을 제거한다.
--
-- 20260801140000 에서 last_seen_at 을 도입했지만 updated_at 조건을 함께 남겨
-- 실효가 없었다. 운영 실측(2026-08-01)에서 updated_at 분포를 확인한 결과다.
--
--   최근  1일 내 갱신   16,340행
--   최근  5일 내 갱신  321,871행
--   최근 14일 내 갱신  424,499행   <- 전체 429,947행의 98.7%
--
-- 스크래퍼가 며칠 주기로 테이블 전체를 훑으며 upsert 하므로 updated_at 은
-- "최근에 수집 작업이 지나갔다"만 뜻하고, 그 플레이어의 가치와 무관하다.
-- 이 값을 보존 기준에 두면 14일 기준 삭제 대상이 5,300행(1.2%)에 그친다.
--
-- 보존 판단은 사용자 활동 신호만으로 한다.
--   1. search_count >= 1        사용자가 조회한 적 있음
--   2. last_seen_at 이 있음     사용자 활동 이력이 있음
--   3. season_stats_data 있음   전적 캐시 보유
--
-- 위 세 조건 중 어느 것도 만족하지 않는 행은 자동완성 후보로만 존재한다.
-- 자동완성은 이 행들 없이도 동작한다. 사용자가 검색하면 PUBG API 조회 후
-- 캐시에 들어오고, 그때부터 후보에 포함된다. 즉 삭제해도 기능 손실이 없고
-- 최초 1회 조회가 API 를 타는 것뿐이다.
--
-- p_retention_days 는 last_seen_at 이 있는 행의 만료 판단에만 쓴다.
-- 오래 조회되지 않은 유저도 결국 정리 대상이 되도록 유지한다.
create or replace function public.compact_pubg_player_cache(
  p_retention_days integer default 90,
  p_apply boolean default false,
  p_batch_limit integer default 5000
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
  cutoff timestamptz;
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

  cutoff := now() - make_interval(days => retention_days);

  select count(*)
  into candidate_count
  from public.pubg_player_cache as cache
  where cache.search_count = 0
    and cache.season_stats_data is null
    and (cache.last_seen_at is null or cache.last_seen_at < cutoff);

  if apply_changes and candidate_count > 0 then
    with doomed as (
      select cache.id
      from public.pubg_player_cache as cache
      where cache.search_count = 0
        and cache.season_stats_data is null
        and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
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
    'dry_run', not apply_changes
  );
end;
$$;

revoke all on function public.compact_pubg_player_cache(integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.compact_pubg_player_cache(integer, boolean, integer)
  to service_role;

-- 20260801140000 의 부분 인덱스는 updated_at 기준이라 새 조건과 맞지 않는다.
-- 삭제 대상 판별에 쓰는 컬럼으로 다시 만든다.
drop index if exists public.pubg_player_cache_retention_idx;

create index if not exists pubg_player_cache_retention_idx
  on public.pubg_player_cache (updated_at)
  where search_count = 0 and season_stats_data is null;
