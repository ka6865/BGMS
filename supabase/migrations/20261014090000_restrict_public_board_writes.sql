-- 게시판 신고와 추천의 공개 쓰기 경로를 닫는다.
--
-- 신고는 app/api/board/report 가 Turnstile·중복 신고·IP 기록을 확인한 뒤
-- service role 로만 저장한다. 남아 있던 public INSERT 정책(with check true)은
-- PostgREST 직접 호출로 이 검사를 모두 건너뛰고 reporter_ip·status 를 임의로
-- 채울 수 있게 했다.
--
-- 추천은 웹과 모바일 모두 recommend_mobile_board_post 원자 RPC(service role 전용)를
-- 거친다. increment_likes 는 사용자 확인 없이 likes + 1 만 수행하므로 anon 과
-- authenticated 실행 권한을 회수한다.
--
-- 배포 순서: 웹 추천을 API route 로 옮긴 앱 배포가 먼저 끝난 뒤 적용한다.
-- 재실행해도 결과가 같다.

set lock_timeout = '3s';
set statement_timeout = '30s';

do $$
begin
  if to_regclass('public.reports') is not null then
    drop policy if exists "Allow public insert reports" on public.reports;
    revoke insert on table public.reports from public, anon, authenticated;
  end if;

  if to_regprocedure('public.increment_likes(integer)') is not null then
    revoke execute on function public.increment_likes(integer) from public, anon, authenticated;
    grant execute on function public.increment_likes(integer) to service_role;
  end if;
end;
$$;

reset lock_timeout;
reset statement_timeout;
