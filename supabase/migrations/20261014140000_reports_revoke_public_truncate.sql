-- TRUNCATE 는 RLS 대상이 아니므로 공개 역할에서 회수한다. 기존 조회·관리자 권한은 유지한다.
-- anon/authenticated 는 NOLOGIN 이고 외부 악용은 미확인이다. 예방적으로 권한만 정리한다.
set lock_timeout = '3s';
set statement_timeout = '30s';

revoke truncate on table public.reports from public, anon, authenticated;

reset lock_timeout;
reset statement_timeout;
