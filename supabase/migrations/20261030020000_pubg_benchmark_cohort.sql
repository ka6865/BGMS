-- 엘리트 벤치마커 전용 명단. 공개 리더보드 상위 플레이어를 계정 단위로 기억해
-- 매일 바뀌는 상위 5명 대신 같은 사람을 돌아가며 수집하고, 명단에서 빠진 사람의
-- 식별 정보를 일정 기간 뒤 정리하는 기준으로 쓴다. 서비스 키 전용이다.
create table if not exists public.pubg_benchmark_cohort (
  platform text not null check (platform in ('steam', 'kakao')),
  account_id text not null check (account_id ~ '^account\.[A-Za-z0-9_-]+$'),
  nickname text not null check (length(btrim(nickname)) > 0),
  -- 분석 행은 정규화한 닉네임(player_id)을 키로 저장되므로, 수집에 실제로 쓴 이름을 모두 남겨
  -- 이름이 바뀐 뒤에도 정리 대상을 찾을 수 있게 한다.
  collected_player_ids text[] not null default '{}',
  source_shard text not null,
  source_season_id text not null,
  source_game_mode text not null,
  last_rank integer check (last_rank is null or last_rank > 0),
  first_ranked_at timestamptz not null default now(),
  last_ranked_at timestamptz not null default now(),
  last_collected_at timestamptz,
  retired_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (platform, account_id)
);

comment on table public.pubg_benchmark_cohort is
  '벤치마크 표본 수집 대상 명단. 리더보드에서 30일 빠지면 retired_at, 그 뒤 90일이 지나면 cleanup_retired_benchmark_cohort가 식별 정보를 정리한다.';

-- 하루 수집 대상: 현역 중 가장 오래 수집하지 않은 사람부터 고른다.
create index if not exists pubg_benchmark_cohort_collect_order_idx
  on public.pubg_benchmark_cohort (platform, last_collected_at asc nulls first, last_ranked_at desc)
  where retired_at is null;
-- 은퇴 표시와 정리 대상 조회
create index if not exists pubg_benchmark_cohort_last_ranked_idx
  on public.pubg_benchmark_cohort (last_ranked_at)
  where retired_at is null;
create index if not exists pubg_benchmark_cohort_retired_idx
  on public.pubg_benchmark_cohort (retired_at)
  where retired_at is not null;

alter table public.pubg_benchmark_cohort enable row level security;
revoke all on table public.pubg_benchmark_cohort from public, anon, authenticated;
grant select, insert, update, delete on table public.pubg_benchmark_cohort to service_role;

-- 명단에서 빠진 뒤(retired_at) 기준일이 지난 벤치마커의 식별 정보를 정리한다.
-- 검색된 플레이어(사용자 조회 흔적 또는 사용자 분석 표본이 있는 경우)는 방침상 별도 보관
-- 대상이므로 데이터는 두고 명단 행만 지운다. 기본은 dry-run이며 p_apply=true일 때만 쓴다.
--   - processed_match_telemetry, pubg_match_performance, 상세 범위 pubg_player_matches,
--     자동완성 캐시(pubg_player_cache): 개인 단위 데이터라 삭제한다. 같은 이름을 나중에 쓴
--     다른 계정의 행을 지우지 않도록 계정 ID가 있으면 계정 ID까지 맞는 행만 지운다.
--   - global_benchmarks, weapon_meta_match_samples, match_stats_raw: 통계 표본이라 남기되
--     player_id를 대응표 없는 임의 값으로 바꿔 식별자를 제거한다.
create or replace function public.cleanup_retired_benchmark_cohort(
  p_retired_before timestamptz,
  p_apply boolean default false,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  member record;
  player_ids text[];
  searched boolean;
  affected integer;
  candidate_count integer := 0;
  searched_kept integer := 0;
  processed_count bigint := 0;
  performance_count bigint := 0;
  player_match_count bigint := 0;
  player_cache_count bigint := 0;
  benchmark_count bigint := 0;
  weapon_count bigint := 0;
  raw_count bigint := 0;
  cohort_count integer := 0;
  remaining integer;
begin
  if p_retired_before is null or p_retired_before > now() - interval '30 days' then
    raise exception 'benchmark-cohort-cleanup-cutoff-too-recent' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'benchmark-cohort-cleanup-invalid-limit' using errcode = '22023';
  end if;

  for member in
    select c.platform, c.account_id, c.nickname, c.collected_player_ids
    from public.pubg_benchmark_cohort c
    where c.retired_at is not null and c.retired_at < p_retired_before
    order by c.retired_at, c.platform, c.account_id
    limit p_limit
    for update skip locked
  loop
    candidate_count := candidate_count + 1;
    select coalesce(array_agg(distinct lower(btrim(v))), '{}')
      into player_ids
      from unnest(member.collected_player_ids || array[member.nickname]) as v
      where length(btrim(v)) > 0;

    searched := exists (
        select 1 from public.pubg_player_cache pc
        where pc.platform = member.platform
          and (pc.id = member.account_id or pc.lower_nickname = any(player_ids))
          and (coalesce(pc.search_count, 0) > 0 or pc.last_seen_at is not null)
      ) or exists (
        select 1 from public.global_benchmarks gb
        where gb.platform = member.platform and gb.player_id = any(player_ids)
          and gb.source is distinct from 'scraper'
      );

    if searched then
      searched_kept := searched_kept + 1;
    else
      -- 같은 경기의 표본 행끼리만 같은 임의 값을 공유하고, 다른 경기와는 연결되지 않게 한다.
      create temporary table if not exists pg_temp.benchmark_cohort_pseudonyms (
        match_id text primary key, pseudonym text not null
      ) on commit drop;
      truncate pg_temp.benchmark_cohort_pseudonyms;
      insert into pg_temp.benchmark_cohort_pseudonyms (match_id, pseudonym)
      select m.match_id, 'retired:' || md5(gen_random_uuid()::text)
      from (
        select gb.match_id from public.global_benchmarks gb
          where gb.platform = member.platform and gb.player_id = any(player_ids)
        union select w.match_id from public.weapon_meta_match_samples w
          where w.platform = member.platform and w.player_id = any(player_ids)
        union select r.match_id from public.match_stats_raw r
          where r.platform = member.platform and r.player_id = any(player_ids)
      ) m;

      if p_apply then
        delete from public.processed_match_telemetry p
          where p.platform = member.platform and p.player_id = any(player_ids)
            and coalesce(p.data->'fullResult'->'stats'->>'playerId', member.account_id) = member.account_id;
        get diagnostics affected = row_count; processed_count := processed_count + affected;
        delete from public.pubg_match_performance f
          where f.platform = member.platform and f.account_id = member.account_id;
        get diagnostics affected = row_count; performance_count := performance_count + affected;
        delete from public.pubg_player_matches m
          where m.platform = member.platform and m.retention_scope = 'detail'
            and (m.account_id = member.account_id or (m.account_id is null and m.player_id = any(player_ids)));
        get diagnostics affected = row_count; player_match_count := player_match_count + affected;
        delete from public.pubg_player_cache pc
          where pc.platform = member.platform and pc.id = member.account_id;
        get diagnostics affected = row_count; player_cache_count := player_cache_count + affected;
        update public.global_benchmarks gb set player_id = ps.pseudonym
          from pg_temp.benchmark_cohort_pseudonyms ps
          where gb.platform = member.platform and gb.player_id = any(player_ids) and gb.match_id = ps.match_id;
        get diagnostics affected = row_count; benchmark_count := benchmark_count + affected;
        update public.weapon_meta_match_samples w set player_id = ps.pseudonym
          from pg_temp.benchmark_cohort_pseudonyms ps
          where w.platform = member.platform and w.player_id = any(player_ids) and w.match_id = ps.match_id;
        get diagnostics affected = row_count; weapon_count := weapon_count + affected;
        update public.match_stats_raw r set player_id = ps.pseudonym
          from pg_temp.benchmark_cohort_pseudonyms ps
          where r.platform = member.platform and r.player_id = any(player_ids) and r.match_id = ps.match_id;
        get diagnostics affected = row_count; raw_count := raw_count + affected;
      else
        processed_count := processed_count + (select count(*) from public.processed_match_telemetry p
          where p.platform = member.platform and p.player_id = any(player_ids)
            and coalesce(p.data->'fullResult'->'stats'->>'playerId', member.account_id) = member.account_id);
        performance_count := performance_count + (select count(*) from public.pubg_match_performance f
          where f.platform = member.platform and f.account_id = member.account_id);
        player_match_count := player_match_count + (select count(*) from public.pubg_player_matches m
          where m.platform = member.platform and m.retention_scope = 'detail'
            and (m.account_id = member.account_id or (m.account_id is null and m.player_id = any(player_ids))));
        player_cache_count := player_cache_count + (select count(*) from public.pubg_player_cache pc
          where pc.platform = member.platform and pc.id = member.account_id);
        benchmark_count := benchmark_count + (select count(*) from public.global_benchmarks gb
          where gb.platform = member.platform and gb.player_id = any(player_ids));
        weapon_count := weapon_count + (select count(*) from public.weapon_meta_match_samples w
          where w.platform = member.platform and w.player_id = any(player_ids));
        raw_count := raw_count + (select count(*) from public.match_stats_raw r
          where r.platform = member.platform and r.player_id = any(player_ids));
      end if;
    end if;

    if p_apply then
      delete from public.pubg_benchmark_cohort c
        where c.platform = member.platform and c.account_id = member.account_id;
      cohort_count := cohort_count + 1;
    end if;
  end loop;

  select count(*) into remaining from public.pubg_benchmark_cohort c
    where c.retired_at is not null and c.retired_at < p_retired_before;

  return jsonb_build_object(
    'dry_run', not p_apply,
    'candidate_players', candidate_count,
    'searched_players_kept', searched_kept,
    'processed_match_telemetry', processed_count,
    'pubg_match_performance', performance_count,
    'pubg_player_matches', player_match_count,
    'pubg_player_cache', player_cache_count,
    'global_benchmarks_pseudonymized', benchmark_count,
    'weapon_meta_match_samples_pseudonymized', weapon_count,
    'match_stats_raw_pseudonymized', raw_count,
    'cohort_rows_deleted', cohort_count,
    'remaining_candidates', remaining
  );
end;
$$;

revoke all on function public.cleanup_retired_benchmark_cohort(timestamptz, boolean, integer) from public, anon, authenticated;
grant execute on function public.cleanup_retired_benchmark_cohort(timestamptz, boolean, integer) to service_role;
