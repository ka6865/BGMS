-- 플레이어 단위 전적·분석 테이블을 공개 키(anon)와 일반 로그인 사용자가 직접 읽지 못하게 한다.
-- 앱은 이 테이블을 서버(service role)에서만 읽고, 비공개 플레이어 차단도 서버가 맡는다.
-- 직접 읽기가 열려 있으면 비공개 요청 플레이어 차단을 우회하거나 전체를 대량으로 내려받을 수 있었다.
-- 선행: 플레이어 조회·검색 추천·무기 숙련도·스쿼드 분석이 service role로 읽도록 바뀐 앱 배포.
-- 집계 공개 데이터(hotdrop_heatmap, pubg_team_benchmarks)와 게임 정보 테이블은 그대로 공개한다.
-- RLS를 켜고 정책을 두지 않은 서버 전용 표(docs/operations/service-role-only-tables.md)는 행이 막혀 있어도
-- 권한이 남아 있었다. RLS 하나에만 기대지 않도록 이 표들의 anon·authenticated 권한도 함께 회수한다.
begin;

do $$
declare
  t text;
begin
  foreach t in array array[
    'pubg_player_matches',
    'pubg_player_cache',
    'processed_match_telemetry',
    'match_stats_raw',
    'global_benchmarks',
    'match_master_telemetry',
    'benchmark_stats_by_tier',
    'benchmark_stats_by_tier_v2'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;

  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
  loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

commit;
