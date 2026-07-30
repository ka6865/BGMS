-- 서버 전용 데이터 테이블의 쓰기 정책 강화
--
-- 배경: 2026-07-30 운영 pg_policies 조회 결과 다음 정책이 확인됐다.
--
--   pubg_player_cache         | "Service Role Write"            | ALL    | {public} | using true / check true
--   processed_match_telemetry | "Allow authenticated insert"     | INSERT | {public} | check auth.role() = 'authenticated'
--   processed_match_telemetry | "Allow authenticated update"     | UPDATE | {public} | using  auth.role() = 'authenticated'
--   match_stats_raw           | "Allow authenticated insert only"| INSERT | {public} | check auth.role() = 'authenticated'
--
-- pubg_player_cache 는 정책 이름과 달리 조건이 true 여서 anon 키만으로 전체 플레이어
-- 캐시를 INSERT / UPDATE / DELETE 할 수 있었다. anon 키는 브라우저에 공개되므로
-- 실질적인 무인증 쓰기 경로였다.
-- processed_match_telemetry 와 match_stats_raw 는 로그인한 사용자가 PostgREST 로
-- 직접 분석 캐시를 위조할 수 있었다.
--
-- 이 세 테이블의 쓰기는 모두 서버에서 SUPABASE_SERVICE_ROLE_KEY 로만 수행된다.
--   app/api/pubg/match/route.ts        : createClient(..., SUPABASE_SERVICE_ROLE_KEY)
--   lib/pubg-analysis/persistMatchAnalysis.ts : 위 라우트가 주입한 클라이언트를 사용
-- 브라우저 코드에서 이 테이블에 쓰는 경로는 없다(읽기 전용 조회만 존재).
--
-- 읽기(SELECT) 정책은 건드리지 않는다. 무기도감·전적·랭킹이 anon 읽기에 의존한다.
--
-- 범위에서 제외한 항목:
--   pending_markers 의 authenticated INSERT/UPDATE 는 components/map/ReportForm.tsx 가
--   브라우저에서 직접 사용한다. 정책을 좁히면 제보 기능이 즉시 깨지므로
--   별도 작업(제보 쓰기를 API 라우트로 이전)으로 분리한다.

-- 1. pubg_player_cache
drop policy if exists "Service Role Write" on public.pubg_player_cache;

create policy "pubg_player_cache_service_role_write"
  on public.pubg_player_cache
  for all
  using (auth.role() = 'service_role'::text)
  with check (auth.role() = 'service_role'::text);

-- 2. processed_match_telemetry
drop policy if exists "Allow authenticated insert" on public.processed_match_telemetry;
drop policy if exists "Allow authenticated update" on public.processed_match_telemetry;

create policy "processed_match_telemetry_service_role_write"
  on public.processed_match_telemetry
  for all
  using (auth.role() = 'service_role'::text)
  with check (auth.role() = 'service_role'::text);

-- 3. match_stats_raw
drop policy if exists "Allow authenticated insert only" on public.match_stats_raw;

create policy "match_stats_raw_service_role_write"
  on public.match_stats_raw
  for all
  using (auth.role() = 'service_role'::text)
  with check (auth.role() = 'service_role'::text);

-- 4. 테이블 권한 자체를 회수해 이중으로 막는다.
--    20260719000000_create_published_post_comment.sql 이 comments 에 적용한 방식과 같다.
revoke insert, update, delete on table public.pubg_player_cache from anon, authenticated;
revoke insert, update, delete on table public.processed_match_telemetry from anon, authenticated;
revoke insert, update, delete on table public.match_stats_raw from anon, authenticated;
revoke insert, update, delete on table public.match_master_telemetry from anon, authenticated;
revoke insert, update, delete on table public.global_benchmarks from anon, authenticated;
revoke insert, update, delete on table public.sync_history from anon, authenticated;

grant select on table public.pubg_player_cache to anon, authenticated;
grant select on table public.processed_match_telemetry to anon, authenticated;
grant select on table public.match_stats_raw to anon, authenticated;
grant select on table public.match_master_telemetry to anon, authenticated;
grant select on table public.global_benchmarks to anon, authenticated;

grant all on table public.pubg_player_cache to service_role;
grant all on table public.processed_match_telemetry to service_role;
grant all on table public.match_stats_raw to service_role;
grant all on table public.match_master_telemetry to service_role;
grant all on table public.global_benchmarks to service_role;
grant all on table public.sync_history to service_role;
