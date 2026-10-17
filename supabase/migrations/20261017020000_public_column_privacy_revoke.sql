-- 공개 키(anon)와 일반 로그인 사용자가 읽을 수 있는 칸을 화면에 필요한 것으로 줄인다.
-- 게시판은 작성자 IP 원문을 내보내고 있었고, profiles는 연동한 배그 닉네임과 접속 시각을 누구나 읽을 수 있었다.
-- 표 단위 SELECT 권한이 있으면 칸 단위 회수가 듣지 않으므로 표 권한을 회수하고 공개할 칸만 다시 준다.
-- 이후 이 세 표에 칸을 추가하면 공개 여부를 정해 직접 grant 해야 한다(기본은 비공개).
-- 선행: 20261017010000_public_column_privacy_prepare 적용과 ip_masked·get_my_profile을 쓰는 앱 배포.
begin;

do $$
declare
  r record;
  cols text;
begin
  for r in
    select * from (values
      ('posts', array['ip_address', 'password_hash']),
      ('comments', array['ip_address', 'password_hash']),
      ('profiles', array['pubg_nickname', 'pubg_platform', 'last_active_at', 'updated_at'])
    ) as v(table_name, hidden)
  loop
    execute format('revoke select on table public.%I from anon, authenticated', r.table_name);
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
    where table_schema = 'public' and table_name = r.table_name and column_name <> all (r.hidden);
    execute format('grant select (%s) on table public.%I to anon, authenticated', cols, r.table_name);
  end loop;
end $$;

-- profiles 쓰기는 본인 행 수정만 쓰인다. 비로그인 쓰기 권한과 id·role 수정 권한을 없앤다.
-- (role은 트리거도 막지만 권한에서도 닫는다.)
revoke insert, update, delete, truncate, references, trigger on table public.profiles from anon, authenticated;
grant update (nickname, avatar_url, pubg_nickname, pubg_platform, updated_at, last_active_at) on table public.profiles to authenticated;

commit;
