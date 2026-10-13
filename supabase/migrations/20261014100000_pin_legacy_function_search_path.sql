-- baseline 시절 함수의 search_path 를 고정하고, 앱이 쓰지 않는 공개 실행 권한을 회수한다.
--
-- Supabase security advisor 의 function_search_path_mutable 7건과
-- anon/authenticated 에게 열린 SECURITY DEFINER 실행 경로를 정리한다.
--
-- - suggest_similar_players: 전적 검색 SSR 클라이언트(anon 키)가 호출하므로 실행 권한은 유지한다.
-- - get_db_size: 관리자 대시보드·Admin Agent·운영 스크립트가 service role 로만 호출한다.
-- - handle_new_user: auth.users 트리거 전용이다. 트리거 실행은 EXECUTE 권한과 무관하다.
-- - delete_orphaned_stats, delete_orphaned_stats_limited, get_orphaned_match_ids,
--   increment_player_search_count: 저장소에 호출부가 없다. service role 만 남긴다.
--
-- 함수 본문은 바꾸지 않는다. 재실행해도 결과가 같다.

set lock_timeout = '3s';
set statement_timeout = '30s';

do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('public.suggest_similar_players(text,text,integer)', false),
      ('public.get_db_size()', true),
      ('public.handle_new_user()', true),
      ('public.delete_orphaned_stats()', true),
      ('public.delete_orphaned_stats_limited(integer)', true),
      ('public.get_orphaned_match_ids()', true),
      ('public.increment_player_search_count(text,text,text)', true)
    ) as t(signature, service_only)
  loop
    if to_regprocedure(target.signature) is null then
      continue;
    end if;
    execute format('alter function %s set search_path = public', target.signature);
    if target.service_only then
      execute format('revoke execute on function %s from public, anon, authenticated', target.signature);
      execute format('grant execute on function %s to service_role', target.signature);
    end if;
  end loop;
end;
$$;

reset lock_timeout;
reset statement_timeout;
