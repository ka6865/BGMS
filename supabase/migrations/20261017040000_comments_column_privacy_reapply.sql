-- 게시판 목록이 comments(count) 집계를 쓰지 않게 된 뒤(앱 배포 후) comments 공개 칸을 다시 줄인다.
-- 20261017030000에서 임시로 되돌린 표 단위 SELECT를 회수하고 ip_address·password_hash를 뺀 칸만 다시 준다.
begin;

do $$
declare cols text;
begin
  revoke select on table public.comments from anon, authenticated;
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'comments' and column_name <> all (array['ip_address', 'password_hash']);
  execute format('grant select (%s) on table public.comments to anon, authenticated', cols);
end $$;

commit;
