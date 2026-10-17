-- 공개 칸 축소(20261017020000)를 위한 준비 단계. 기존 코드와 함께 동작하도록 칸과 함수만 추가한다.
-- 게시판 화면용 가린 IP 칸과 본인 프로필 조회 함수를 먼저 만들고, 앱을 배포한 뒤 권한을 회수한다.
begin;

-- 게시판 IP는 화면에 앞 두 자리만 보이므로 그 값만 따로 계산해 공개한다.
alter table public.posts add column if not exists ip_masked text generated always as (
  case
    when ip_address is null then null
    when position('.' in ip_address) > 0 then split_part(ip_address, '.', 1) || '.' || split_part(ip_address, '.', 2)
    when position(':' in ip_address) > 0 then split_part(ip_address, ':', 1) || ':' || split_part(ip_address, ':', 2)
    else null
  end
) stored;
alter table public.comments add column if not exists ip_masked text generated always as (
  case
    when ip_address is null then null
    when position('.' in ip_address) > 0 then split_part(ip_address, '.', 1) || '.' || split_part(ip_address, '.', 2)
    when position(':' in ip_address) > 0 then split_part(ip_address, ':', 1) || ':' || split_part(ip_address, ':', 2)
    else null
  end
) stored;

-- 본인 프로필 전체(비공개 칸 포함)는 이 함수로만 읽는다.
create or replace function public.get_my_profile()
returns setof public.profiles
language sql
stable
security definer
set search_path to ''
as $function$
  select p.* from public.profiles p where p.id = auth.uid();
$function$;

revoke all on function public.get_my_profile() from public, anon;
grant execute on function public.get_my_profile() to authenticated, service_role;

commit;
