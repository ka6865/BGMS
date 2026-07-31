-- 20260730203000 의 정책 생성을 재실행 가능하게 만든다.
--
-- 배경: 2026-08-01 에 운영 스키마를 덤프해 빈 DB 재현을 처음으로 검증했다.
-- 그 과정에서 20260730203000 이 재적용 시 실패하는 것을 확인했다.
--
--   ERROR: policy "pubg_player_cache_service_role_write" for table
--          "pubg_player_cache" already exists
--
-- PostgreSQL 의 CREATE POLICY 는 IF NOT EXISTS 를 지원하지 않는다. 해당
-- 마이그레이션은 이전 정책 이름만 drop 하고 새 이름은 drop 하지 않아서,
-- 한 번 적용된 DB 에 다시 적용하면 멈춘다.
--
-- 운영에는 이미 적용되어 동작 중이므로 지금 문제가 되지는 않는다. 다만
-- 재해 복구나 스테이징 구축처럼 migration 을 처음부터 재생하는 상황에서
-- 이 지점에서 막힌다.
--
-- 대응: 새 이름을 먼저 drop 한 뒤 다시 만든다. 정책 내용은 20260730203000 과
-- 동일하므로 운영 동작은 바뀌지 않는다.
--
-- 참고: service_role 은 BYPASSRLS 속성을 가지므로 이 정책이 실제 방어선은
-- 아니다. 실질적인 차단은 anon/authenticated 권한 회수다(20260730203000 참고).
-- 그래도 정책 이름과 조건을 명시해 의도를 남긴다.

-- 1. pubg_player_cache
drop policy if exists "pubg_player_cache_service_role_write" on public.pubg_player_cache;

create policy "pubg_player_cache_service_role_write"
  on public.pubg_player_cache
  for all
  using (auth.role() = 'service_role'::text)
  with check (auth.role() = 'service_role'::text);

-- 2. processed_match_telemetry
drop policy if exists "processed_match_telemetry_service_role_write" on public.processed_match_telemetry;

create policy "processed_match_telemetry_service_role_write"
  on public.processed_match_telemetry
  for all
  using (auth.role() = 'service_role'::text)
  with check (auth.role() = 'service_role'::text);

-- 3. match_stats_raw
drop policy if exists "match_stats_raw_service_role_write" on public.match_stats_raw;

create policy "match_stats_raw_service_role_write"
  on public.match_stats_raw
  for all
  using (auth.role() = 'service_role'::text)
  with check (auth.role() = 'service_role'::text);
