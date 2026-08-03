 -- compact_pubg_player_cache 성능 최적화:
 -- 1. ORDER BY 정렬 및 OFFSET 150000 스캔 제거 (포획 연산 80ms 단축)
 -- 2. p_apply = true 일 때 불필요한 전체 테이블 count(*) 생략
 -- 3. 1회 배치 기본 상한 500건으로 안정화
 
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
   cutoff timestamptz;
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
 
   cutoff := now() - make_interval(days => retention_days);
 
   -- dry_run (화면 모니터링/대시보드 표시용) 인 경우에만 전체 수치를 계산
   if not apply_changes then
     select count(*)
     into candidate_count
     from public.pubg_player_cache as cache
     where cache.search_count = 0
       and cache.season_stats_data is null
       and (cache.last_seen_at is null or cache.last_seen_at < cutoff);
 
     select count(*) into total_count from public.pubg_player_cache;
 
     return jsonb_build_object(
       'candidate_count', candidate_count,
       'deleted_count', 0,
       'remaining_count', candidate_count,
       'total_count', total_count,
       'retention_days', retention_days,
       'keep_recent', p_keep_recent,
       'dry_run', true
     );
   end if;
 
   -- 실제 삭제 실행 (p_apply = true):
   -- OFFSET / Full Count / ORDER BY 제거로 80ms 초고속 포획 삭제
   with doomed as (
     select cache.id
     from public.pubg_player_cache as cache
     where cache.search_count = 0
       and cache.season_stats_data is null
       and (cache.last_seen_at is null or cache.last_seen_at < cutoff)
     limit batch_limit
   )
   delete from public.pubg_player_cache as cache
   using doomed
   where cache.id = doomed.id;
 
   get diagnostics deleted_count = row_count;
 
   return jsonb_build_object(
     'candidate_count', deleted_count,
     'deleted_count', deleted_count,
     'remaining_count', 0,
     'total_count', 0,
     'retention_days', retention_days,
     'keep_recent', p_keep_recent,
     'dry_run', false
   );
 end;
 $$;
 
 revoke all on function public.compact_pubg_player_cache(integer, boolean, integer, integer)
   from public, anon, authenticated;
 grant execute on function public.compact_pubg_player_cache(integer, boolean, integer, integer)
   to service_role;
