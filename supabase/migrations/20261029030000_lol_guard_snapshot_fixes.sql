begin;
set local lock_timeout = '2s';

-- 20261029010000(이동 구간 호출 제한)과 20261029020000(검색 결과 보관본) 보완.
-- 1) 보내기 전에 취소한 예약이 한도를 계속 차지하지 않게 예약 기록을 허가 token과 묶고, 최대 대기를 넘는 예약은 기록하지 않는다.
-- 2) 보관본은 저장한 계정(owner_puuid)이 지금도 그 Riot ID의 유일한 저장 계정일 때만 돌려준다.
-- 3) 보관본 저장은 계정 행을 잠근 뒤 확인해 계정 삭제와 순서를 맞춘다.

alter table public.lol_riot_request_log add column lease_token uuid;
create index lol_riot_request_log_token on public.lol_riot_request_log (lease_token) where lease_token is not null;

drop function public.reserve_lol_riot_request(text,text);
create function public.reserve_lol_riot_request(p_host text, p_priority text default 'interactive', p_max_wait_ms integer default null)
returns table (granted boolean, lease_token uuid, permit_at timestamptz, retry_after_seconds integer, reason text, started boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz; v_global public.lol_rate_limit_state%rowtype; v_host public.lol_rate_limit_state%rowtype;
  v_live integer; v_permit timestamptz; v_token uuid := gen_random_uuid(); v_retry integer;
  v_window record; v_budget integer; v_count integer; v_edge timestamptz;
begin
  if p_host not in ('asia','kr') then raise exception 'invalid Riot host' using errcode = '22023'; end if;
  if p_priority not in ('interactive','background') then raise exception 'invalid Riot priority' using errcode = '22023'; end if;
  if p_max_wait_ms is not null and p_max_wait_ms not between 0 and 60000 then
    raise exception 'invalid Riot max wait' using errcode = '22023';
  end if;
  select * into v_global from public.lol_rate_limit_state where host = 'global';
  select * into v_host from public.lol_rate_limit_state where host = p_host for update;
  if v_global.host is null or v_host.host is null then raise exception 'rate limit state missing' using errcode = '55000'; end if;
  v_now := pg_catalog.clock_timestamp();
  delete from public.lol_collection_leases where lease_type = 'request' and lease_until <= v_now;
  delete from public.lol_riot_request_log where host = p_host and started_at < v_now - interval '1 day';
  if greatest(v_global.blocked_until, v_host.blocked_until) > v_now then
    v_retry := greatest(1, ceil(extract(epoch from greatest(v_global.blocked_until, v_host.blocked_until) - v_now))::integer);
    return query select false, null::uuid, null::timestamptz, v_retry, 'cooldown', false; return;
  end if;
  select count(*)::integer into v_live from public.lol_collection_leases where lease_type = 'request' and request_host = p_host;
  if v_live >= v_host.max_concurrency then
    return query select false, null::uuid, null::timestamptz, 1, 'concurrency', false; return;
  end if;
  v_permit := v_now;
  for v_window in select * from public.lol_riot_limit_windows(v_host.app_rate_limit) loop
    -- 사용자 검색은 한도의 90%, 백그라운드 수집은 50%까지 쓴다. 나머지는 다른 프로세스와 오차를 위한 여유다.
    v_budget := greatest(1, floor(v_window.max_count * case when p_priority = 'interactive' then 0.9 else 0.5 end)::integer);
    select count(*)::integer into v_count from public.lol_riot_request_log
      where host = p_host and started_at > v_now - pg_catalog.make_interval(secs => v_window.window_seconds);
    if v_count >= v_budget then
      select started_at into v_edge from public.lol_riot_request_log
        where host = p_host and started_at > v_now - pg_catalog.make_interval(secs => v_window.window_seconds)
        order by started_at desc offset v_budget - 1 limit 1;
      v_permit := greatest(v_permit, v_edge + pg_catalog.make_interval(secs => v_window.window_seconds) + interval '50 milliseconds');
    end if;
  end loop;
  -- 호출자가 기다리지 않을 예약은 기록·허가를 만들지 않고 거절한다. 거절한 예약이 다음 구간을 차지하지 않게 하기 위해서다.
  if p_max_wait_ms is not null and v_permit > v_now + pg_catalog.make_interval(secs => p_max_wait_ms::double precision / 1000) then
    v_retry := greatest(1, ceil(extract(epoch from v_permit - v_now))::integer);
    return query select false, null::uuid, null::timestamptz, v_retry, 'window', false; return;
  end if;
  insert into public.lol_riot_request_log (host, priority, started_at, lease_token) values (p_host, p_priority, v_permit, v_token);
  update public.lol_rate_limit_state set used_count = used_count + 1, last_started_at = greatest(coalesce(last_started_at, v_permit), v_permit)
    where host = p_host;
  insert into public.lol_collection_leases (lease_key, lease_type, lease_token, lease_until, request_host, permit_at)
    values ('request:' || v_token::text, 'request', v_token, v_permit + interval '12 seconds', p_host, v_permit);
  return query select true, v_token, v_permit, 0, 'granted', v_permit <= v_now;
end $$;

-- 시작을 거절한 요청은 Riot에 보내지 않았으므로 예약 기록도 지운다.
create or replace function public.start_lol_riot_request(p_token uuid)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql security invoker set search_path = '' as $$
declare v_host text; v_permit timestamptz; v_lease_until timestamptz; v_now timestamptz; v_blocked timestamptz;
begin
  select request_host,permit_at,lease_until into v_host,v_permit,v_lease_until from public.lol_collection_leases
    where lease_key = 'request:' || p_token::text and lease_token = p_token and lease_type = 'request';
  v_now := pg_catalog.clock_timestamp();
  if v_host is null or v_lease_until <= v_now then
    delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text and lease_token = p_token;
    delete from public.lol_riot_request_log where lease_token = p_token;
    return query select false, 1; return;
  end if;
  select greatest(h.blocked_until, g.blocked_until) into v_blocked
    from public.lol_rate_limit_state h, public.lol_rate_limit_state g where h.host = v_host and g.host = 'global';
  if v_blocked > v_now or v_permit > v_now + interval '200 milliseconds' then
    delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text and lease_token = p_token;
    delete from public.lol_riot_request_log where lease_token = p_token;
    return query select false, greatest(1, ceil(extract(epoch from greatest(v_blocked, v_permit) - v_now))::integer); return;
  end if;
  return query select true, 0;
end $$;

-- 보내기 전에 포기한 예약(대기 초과, 키 없음 등)의 허가와 기록을 함께 지운다. 보낸 요청에는 쓰지 않는다.
create or replace function public.cancel_lol_riot_request(p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_found boolean;
begin
  delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text and lease_type = 'request' and lease_token = p_token;
  v_found := found;
  delete from public.lol_riot_request_log where lease_token = p_token;
  return v_found or found;
end $$;

alter table public.lol_api_cache add column owner_puuid text check (owner_puuid is null or length(owner_puuid) between 1 and 128);

-- 계정 행을 잠근 뒤 확인한다. 진행 중인 계정 삭제가 있으면 그 커밋을 기다리고, 삭제됐으면 저장하지 않는다.
create or replace function public.put_lol_search_snapshot(
  p_cache_key text, p_platform text, p_route text, p_version text, p_puuid text, p_payload jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz;
begin
  if p_cache_key is null or length(p_cache_key) not between 1 and 512 or p_cache_key not like 'search-snapshot:%'
    or p_version is null or length(p_version) not between 1 and 32
    or p_puuid is null or length(p_puuid) not between 1 and 128
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 1048576 then
    raise exception 'invalid LoL search snapshot' using errcode = '22023';
  end if;
  perform 1 from public.lol_accounts where puuid = p_puuid and platform_id = p_platform and regional_route = p_route for key share;
  if not found then return false; end if;
  v_now := pg_catalog.clock_timestamp();
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at,owner_puuid)
  values (p_cache_key,'search_snapshot',p_platform,p_route,p_version,p_payload,v_now,v_now + interval '7 days',p_puuid)
  on conflict (cache_key) do update set platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,
    owner_puuid=excluded.owner_puuid
    where public.lol_api_cache.kind = 'search_snapshot';
  return found;
end $$;

-- 보관본은 저장 계정이 지금도 이 Riot ID의 유일한 저장 계정일 때만 돌려준다.
-- 이름이 바뀐 것이 이미 저장됐거나 같은 이름의 계정이 둘 이상이면 돌려주지 않는다. Riot을 다시 부르지 않는 검사다.
create or replace function public.get_lol_search_snapshot(
  p_key text, p_platform text, p_route text, p_version text, p_game_name text, p_tag_line text
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select c.payload from public.lol_api_cache c
  where c.cache_key = p_key and c.kind = 'search_snapshot' and c.platform_id = p_platform and c.regional_route = p_route
    and c.data_version = p_version and c.expires_at > pg_catalog.clock_timestamp() and c.owner_puuid is not null
    and (select pg_catalog.count(*) from public.lol_accounts a
         where a.platform_id = p_platform and a.regional_route = p_route
           and pg_catalog.lower(a.game_name) = pg_catalog.lower(p_game_name) and pg_catalog.lower(a.tag_line) = pg_catalog.lower(p_tag_line)) = 1
    and exists (select 1 from public.lol_accounts a
         where a.puuid = c.owner_puuid and a.platform_id = p_platform and a.regional_route = p_route
           and pg_catalog.lower(a.game_name) = pg_catalog.lower(p_game_name) and pg_catalog.lower(a.tag_line) = pg_catalog.lower(p_tag_line))
$$;

-- 한 Riot ID의 검색 캐시(2분)와 보관본을 모든 Data Dragon 버전에서 지운다. 이름 변경을 확인했거나 계정 조회가 404일 때 쓴다.
-- p_name_suffix는 캐시 키 끝의 ':{이름}:{태그}'(URI 인코딩된 소문자)다. 인코딩된 이름에는 ':'가 없어 구간 경계가 정확히 맞는다.
create or replace function public.delete_lol_search_cache_for_name(p_platform text, p_route text, p_name_suffix text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_deleted integer;
begin
  if p_name_suffix is null or length(p_name_suffix) not between 4 and 400 or p_name_suffix not like ':%:%'
    or pg_catalog.length(pg_catalog.replace(p_name_suffix, ':', '')) <> length(p_name_suffix) - 2 then
    raise exception 'invalid LoL name suffix' using errcode = '22023';
  end if;
  delete from public.lol_api_cache
    where kind in ('search','search_snapshot') and platform_id = p_platform and regional_route = p_route
      and (cache_key like 'search:%' or cache_key like 'search-snapshot:%')
      and pg_catalog.right(cache_key, length(p_name_suffix)) = p_name_suffix;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.reserve_lol_riot_request(text,text,integer), public.cancel_lol_riot_request(uuid),
  public.get_lol_search_snapshot(text,text,text,text,text,text), public.delete_lol_search_cache_for_name(text,text,text)
  from public, anon, authenticated;
grant execute on function public.reserve_lol_riot_request(text,text,integer), public.cancel_lol_riot_request(uuid),
  public.get_lol_search_snapshot(text,text,text,text,text,text), public.delete_lol_search_cache_for_name(text,text,text)
  to service_role;

commit;
