begin;
set local lock_timeout = '2s';

-- 2분 검색 캐시가 끝난 계정도 저장된 전적을 먼저 보여 주도록, 마지막 성공 검색 결과를 7일 보관한다.
-- 기존 'search'(2분) 행과 조회 함수는 그대로 두고 'search_snapshot' 종류를 따로 쓴다.
-- 만료 상한 검사는 search 외 종류를 7일까지 허용하므로 바꾸지 않는다.
alter table public.lol_api_cache drop constraint lol_api_cache_kind_check;
alter table public.lol_api_cache add constraint lol_api_cache_kind_check
  check (kind in ('search','search_snapshot','match_details'));
alter table public.lol_api_cache drop constraint lol_api_cache_payload_check;
alter table public.lol_api_cache add constraint lol_api_cache_payload_check
  check (octet_length(payload::text) <= case when kind in ('search','search_snapshot') then 1048576 else 262144 end);

-- 저장된 계정의 마지막 검색 결과를 덮어쓴다. 계정 삭제 뒤 늦게 도착한 저장은 받지 않는다.
create or replace function public.put_lol_search_snapshot(
  p_cache_key text, p_platform text, p_route text, p_version text, p_puuid text, p_payload jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_cache_key is null or length(p_cache_key) not between 1 and 512 or p_cache_key not like 'search-snapshot:%'
    or p_version is null or length(p_version) not between 1 and 32
    or p_puuid is null or length(p_puuid) not between 1 and 128
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 1048576 then
    raise exception 'invalid LoL search snapshot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.lol_accounts where puuid = p_puuid and platform_id = p_platform and regional_route = p_route) then
    return false;
  end if;
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
  values (p_cache_key,'search_snapshot',p_platform,p_route,p_version,p_payload,v_now,v_now + interval '7 days')
  on conflict (cache_key) do update set platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at
    where public.lol_api_cache.kind = 'search_snapshot';
  return found;
end $$;

revoke all on function public.put_lol_search_snapshot(text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.put_lol_search_snapshot(text,text,text,text,text,jsonb) to service_role;

commit;
