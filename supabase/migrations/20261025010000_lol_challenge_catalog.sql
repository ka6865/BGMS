-- 도전과제 한국어 설정·분포만 보관하는 단일 일일 캐시이며 플레이어 식별자를 담지 않는다.
create table public.lol_challenge_catalog_cache (
  cache_key text primary key check (cache_key = 'kr:ko_KR:v1'),
  payload jsonb not null check (jsonb_typeof(payload) = 'array' and octet_length(payload::text) <= 1048576),
  fetched_at timestamptz not null,
  expires_at timestamptz not null check (expires_at = fetched_at + interval '1 day')
);
alter table public.lol_challenge_catalog_cache enable row level security;
revoke all on public.lol_challenge_catalog_cache from public, anon, authenticated;
grant select, insert, update on public.lol_challenge_catalog_cache to service_role;

create function public.get_lol_challenge_catalog_cache()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select payload from public.lol_challenge_catalog_cache
  where cache_key = 'kr:ko_KR:v1' and expires_at > pg_catalog.statement_timestamp();
$$;

create function public.put_lol_challenge_catalog_cache(p_payload jsonb, p_lease_key text, p_token uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'array' or octet_length(p_payload::text) > 1048576
    or jsonb_array_length(p_payload) > 2000 then
    raise exception 'invalid challenge catalog' using errcode = '22023';
  end if;
  if p_lease_key is distinct from 'challenge-catalog:kr:ko_KR:v1' or not exists (
    select 1 from public.lol_collection_leases
    where lease_key = p_lease_key and lease_token = p_token and lease_type = 'collection' and lease_until > v_now for update
  ) then raise exception 'challenge catalog lease expired' using errcode = '40001'; end if;
  insert into public.lol_challenge_catalog_cache(cache_key,payload,fetched_at,expires_at)
  values ('kr:ko_KR:v1',p_payload,v_now,v_now+interval '1 day')
  on conflict(cache_key) do update set payload=excluded.payload,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at;
end;
$$;
revoke all on function public.get_lol_challenge_catalog_cache(), public.put_lol_challenge_catalog_cache(jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.get_lol_challenge_catalog_cache(), public.put_lol_challenge_catalog_cache(jsonb,text,uuid) to service_role;
