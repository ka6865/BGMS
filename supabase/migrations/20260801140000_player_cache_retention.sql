-- pubg_player_cache 보존 정책이 무력화된 문제를 해결한다.
--
-- 배경: 이 테이블은 자동완성 후보 풀이라 매치 분석 시 참가자 전원(최대 100명)을
-- 껍데기 행으로 저장한다. 그 자체는 의도된 설계다.
--
-- 문제는 정리 정책이다. scripts/cleanup_telemetry.ts 의
-- cleanupInactivePlayerCache 가 "search_count = 0 이고 updated_at 이 14일 이상
-- 지난 행"을 지우는데, persistPlayerCache 가 매 분석마다 참가자의 updated_at 을
-- 현재 시각으로 갱신한다. 스크래퍼가 매일 도는 한 대상 행은 계속 되살아난다.
--
-- 운영 실측 (2026-08-01):
--   전체            429,947행  165.4MB (데이터 77.5MB + 인덱스 87.9MB)
--   실사용(검색됨)      589행
--   현 정책 삭제 대상  5,300행  <- 42만 행 중 1.2%
--   하루 16,340행 upsert, 하루 206매치 분석
--
-- 대응: 자동 수집 시점(updated_at)과 실제 사용자 활동 시점(last_seen_at)을
-- 분리한다. 정리 기준을 last_seen_at 으로 바꾸면 스크래퍼 갱신이 보존 기간을
-- 연장하지 못한다.
--
-- 자동완성 품질은 유지된다. 삭제 대상은 "사용자가 한 번도 조회하지 않았고
-- 최근 수집도 되지 않은" 행이므로, 활동 중인 플레이어는 남는다.

-- 사용자가 실제로 전적을 조회한 시점. 매치 분석의 대량 upsert 는 이 값을 쓰지 않는다.
alter table public.pubg_player_cache
  add column if not exists last_seen_at timestamptz;

-- 기존 행 백필: 이미 검색된 이력이 있는 행은 보존 대상이므로 updated_at 을 승계한다.
-- search_count = 0 인 행은 null 로 남겨 정리 후보가 된다.
update public.pubg_player_cache
set last_seen_at = updated_at
where search_count >= 1
  and last_seen_at is null;

-- 정리 쿼리가 인덱스를 타도록 한다.
-- 부분 인덱스로 대상(search_count = 0)만 담아 인덱스 크기를 억제한다.
create index if not exists pubg_player_cache_retention_idx
  on public.pubg_player_cache (updated_at)
  where search_count = 0 and last_seen_at is null;

-- 보존 대상이 아닌 행을 배치로 삭제한다.
--
-- 보존 조건 (하나라도 만족하면 유지):
--   1. search_count >= 1        사용자가 조회한 적 있음
--   2. last_seen_at 이 있음     사용자 활동 이력이 있음
--   3. season_stats_data 있음   전적 캐시를 보유해 재조회 시 즉시 응답 가능
--   4. updated_at 이 보존 기간 내  최근 매치에서 관측된 활성 플레이어
--
-- p_apply 가 false 면 대상 건수만 세고 삭제하지 않는다.
create or replace function public.compact_pubg_player_cache(
  p_retention_days integer default 14,
  p_apply boolean default false,
  p_batch_limit integer default 5000
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  retention_days integer := coalesce(p_retention_days, 14);
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
    and cache.last_seen_at is null
    and cache.season_stats_data is null
    and cache.updated_at < cutoff;

  if apply_changes and candidate_count > 0 then
    with doomed as (
      select cache.id
      from public.pubg_player_cache as cache
      where cache.search_count = 0
        and cache.last_seen_at is null
        and cache.season_stats_data is null
        and cache.updated_at < cutoff
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
