-- 긴급 복구: 게시판 목록의 comments(count) 집계는 표 단위 SELECT 권한이 필요해 20261017020000 적용 후 목록 조회가 실패했다.
-- 댓글 ip_address 보유 0건, password_hash는 제약으로 항상 비어 있음을 확인하고 comments 표 단위 SELECT만 되돌린다.
-- 집계를 쓰지 않도록 코드를 바꾼 뒤 20261017040000에서 다시 칸 단위로 줄인다.
begin;
grant select on table public.comments to anon, authenticated;
commit;
