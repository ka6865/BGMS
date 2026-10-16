-- 게시판 IP 원문과 profiles 비공개 칸은 공개 키·일반 사용자에게 보이지 않고, 화면에 필요한 칸과 본인 프로필은 읽힌다.
begin;
insert into public.profiles(id, nickname, role, pubg_nickname, pubg_platform, last_active_at)
values ('00000000-0000-0000-0000-00000000c001', 'privacy-owner', 'user', 'OwnerPubg', 'steam', now()),
       ('00000000-0000-0000-0000-00000000c002', 'privacy-other', 'user', 'OtherPubg', 'kakao', now());
insert into public.posts(id, title, content, status, author, ip_address) values (99992001, 'privacy', 'body', 'published', 'guest', '203.0.113.77');
insert into public.comments(id, post_id, author, content, ip_address) values (99992001, 99992001, 'guest', 'c', '2001:db8:1::5');

do $$
declare v text; n integer;
begin
  select ip_masked into v from public.posts where id = 99992001;
  if v is distinct from '203.0' then raise exception 'post ip_masked wrong: %', v; end if;
  select c.ip_masked into v from public.comments c join public.posts p on p.id = c.post_id where p.id = 99992001;
  if v is distinct from '2001:db8' then raise exception 'comment ip_masked wrong: %', v; end if;

  if has_column_privilege('anon', 'public.posts', 'ip_address', 'SELECT')
    or has_column_privilege('authenticated', 'public.posts', 'ip_address', 'SELECT')
    or has_column_privilege('anon', 'public.comments', 'ip_address', 'SELECT')
    or has_column_privilege('anon', 'public.posts', 'password_hash', 'SELECT')
    or has_column_privilege('anon', 'public.comments', 'password_hash', 'SELECT') then
    raise exception 'board private columns still readable';
  end if;
  if not has_column_privilege('anon', 'public.posts', 'ip_masked', 'SELECT')
    or not has_column_privilege('anon', 'public.posts', 'title', 'SELECT')
    or not has_column_privilege('anon', 'public.comments', 'ip_masked', 'SELECT') then
    raise exception 'board public columns not readable';
  end if;

  if has_column_privilege('anon', 'public.profiles', 'pubg_nickname', 'SELECT')
    or has_column_privilege('authenticated', 'public.profiles', 'pubg_nickname', 'SELECT')
    or has_column_privilege('anon', 'public.profiles', 'last_active_at', 'SELECT')
    or has_column_privilege('authenticated', 'public.profiles', 'pubg_platform', 'SELECT')
    or has_column_privilege('anon', 'public.profiles', 'updated_at', 'SELECT') then
    raise exception 'profile private columns still readable';
  end if;
  if not has_column_privilege('anon', 'public.profiles', 'nickname', 'SELECT')
    or not has_column_privilege('anon', 'public.profiles', 'role', 'SELECT') then
    raise exception 'profile public columns not readable';
  end if;

  if has_table_privilege('anon', 'public.profiles', 'UPDATE')
    or has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
    or has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
    or not has_column_privilege('authenticated', 'public.profiles', 'pubg_nickname', 'UPDATE')
    or has_table_privilege('authenticated', 'public.profiles', 'INSERT') then
    raise exception 'profile write privileges wrong';
  end if;

  if has_function_privilege('anon', 'public.get_my_profile()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.get_my_profile()', 'EXECUTE') then
    raise exception 'get_my_profile ACL wrong';
  end if;
end;
$$;

-- 일반 사용자로 실제 조회해 본다.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
do $$
declare v text; n integer;
begin
  select pubg_nickname into v from public.get_my_profile();
  if v is distinct from 'OwnerPubg' then raise exception 'own profile not returned: %', v; end if;
  select count(*) into n from public.get_my_profile();
  if n <> 1 then raise exception 'get_my_profile returned % rows', n; end if;
  select nickname into v from public.profiles where id = '00000000-0000-0000-0000-00000000c002';
  if v is distinct from 'privacy-other' then raise exception 'public nickname not readable'; end if;
  begin
    perform pubg_nickname from public.profiles where id = '00000000-0000-0000-0000-00000000c002';
    raise exception 'other pubg_nickname readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform ip_address from public.posts where id = 99992001;
    raise exception 'post ip_address readable';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare n integer;
begin
  begin
    perform 1 from public.get_my_profile();
    raise exception 'anon can call get_my_profile';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
rollback;
