begin;
set local lock_timeout = '2s';

-- Riot 호출 제한을 "모든 호출 사이 1.5초" 고정 간격에서 Riot이 알려 준 앱 한도(예: 1초 20회, 2분 100회) 안의
-- 이동 구간 방식으로 바꾼다. 한도 안에서는 바로 보내고, 구간이 차면 가장 오래된 호출이 구간을 벗어나는 시각까지 기다린다.
-- Riot 앱 한도는 지역(asia, kr)마다 따로 세므로 호스트별로 센다. 백그라운드 수집은 한도의 절반까지만 쓴다.
create table public.lol_riot_request_log (
  id bigint generated always as identity primary key,
  host text not null check (host in ('asia','kr')),
  priority text not null check (priority in ('interactive','background')),
  started_at timestamptz not null
);
create index lol_riot_request_log_host_started on public.lol_riot_request_log (host, started_at);
alter table public.lol_riot_request_log enable row level security;
revoke all on public.lol_riot_request_log from public, anon, authenticated;
grant select, insert, update, delete on public.lol_riot_request_log to service_role;

alter table public.lol_rate_limit_state add column max_concurrency integer not null default 8
  check (max_concurrency between 1 and 32);

-- 헤더 문자열 '20:1,100:120'을 (한도, 초) 목록으로 바꾼다. 형식이 맞지 않는 항목은 버린다.
create or replace function public.lol_riot_limit_windows(p_header text)
returns table(max_count integer, window_seconds integer)
language sql immutable security invoker set search_path = '' as $$
  select parts[1]::integer, parts[2]::integer
  from unnest(pg_catalog.string_to_array(coalesce(nullif(p_header,''),'20:1,100:120'),',')) item,
    lateral (select pg_catalog.string_to_array(pg_catalog.btrim(item),':') parts) p
  where pg_catalog.array_length(parts,1)=2 and parts[1] ~ '^[0-9]{1,9}$' and parts[2] ~ '^[0-9]{1,5}$'
    and parts[1]::integer>0 and parts[2]::integer between 1 and 86400;
$$;

drop function public.reserve_lol_riot_request(text);
create function public.reserve_lol_riot_request(p_host text, p_priority text default 'interactive')
returns table (granted boolean, lease_token uuid, permit_at timestamptz, retry_after_seconds integer, reason text, started boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz; v_global public.lol_rate_limit_state%rowtype; v_host public.lol_rate_limit_state%rowtype;
  v_live integer; v_permit timestamptz; v_token uuid := gen_random_uuid(); v_retry integer;
  v_window record; v_budget integer; v_count integer; v_edge timestamptz;
begin
  if p_host not in ('asia','kr') then raise exception 'invalid Riot host' using errcode = '22023'; end if;
  if p_priority not in ('interactive','background') then raise exception 'invalid Riot priority' using errcode = '22023'; end if;
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
  insert into public.lol_riot_request_log (host, priority, started_at) values (p_host, p_priority, v_permit);
  update public.lol_rate_limit_state set used_count = used_count + 1, last_started_at = greatest(coalesce(last_started_at, v_permit), v_permit)
    where host = p_host;
  insert into public.lol_collection_leases (lease_key, lease_type, lease_token, lease_until, request_host, permit_at)
    values ('request:' || v_token::text, 'request', v_token, v_permit + interval '12 seconds', p_host, v_permit);
  return query select true, v_token, v_permit, 0, 'granted', v_permit <= v_now;
end $$;

-- 예약 시각이 미래였던 요청만 시작 직전에 다시 확인한다. 차단과 lease 만료만 검사한다.
create or replace function public.start_lol_riot_request(p_token uuid)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql security invoker set search_path = '' as $$
declare v_host text; v_permit timestamptz; v_lease_until timestamptz; v_now timestamptz; v_blocked timestamptz;
begin
  select request_host,permit_at,lease_until into v_host,v_permit,v_lease_until from public.lol_collection_leases
    where lease_key = 'request:' || p_token::text and lease_token = p_token and lease_type = 'request';
  v_now := pg_catalog.clock_timestamp();
  if v_host is null or v_lease_until <= v_now then return query select false, 1; return; end if;
  select greatest(h.blocked_until, g.blocked_until) into v_blocked
    from public.lol_rate_limit_state h, public.lol_rate_limit_state g where h.host = v_host and g.host = 'global';
  if v_blocked > v_now or v_permit > v_now + interval '200 milliseconds' then
    delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text and lease_token = p_token;
    return query select false, greatest(1, ceil(extract(epoch from greatest(v_blocked, v_permit) - v_now))::integer); return;
  end if;
  return query select true, 0;
end $$;

-- 응답 헤더를 기록한다. 한도를 다 쓴 구간이 보이면 해당 호스트만 그 구간이 끝날 때까지(최대 10초) 멈춘다.
-- 형식이 맞지 않는 헤더는 기존처럼 10분 동안 모든 호출을 막는다.
create or replace function public.record_lol_riot_rate_headers(
  p_host text, p_app_limit text, p_app_count text, p_method_limit text, p_method_count text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_app_limits text[] := case when coalesce(p_app_limit,'')='' then array[]::text[] else pg_catalog.string_to_array(p_app_limit,',') end;
  v_method_limits text[] := case when coalesce(p_method_limit,'')='' then array[]::text[] else pg_catalog.string_to_array(p_method_limit,',') end;
  v_app_counts text[] := case when coalesce(p_app_count,'')='' then array[]::text[] else pg_catalog.string_to_array(p_app_count,',') end;
  v_method_counts text[] := case when coalesce(p_method_count,'')='' then array[]::text[] else pg_catalog.string_to_array(p_method_count,',') end;
  v_parts text[]; v_item text; v_limit_item text; v_limit integer; v_window integer; v_observed integer; v_scope text;
  v_limits text[]; v_counts text[];
  v_cooldown_until timestamptz := '-infinity'; v_fail_closed_until timestamptz;
begin
  if p_host not in ('asia','kr') then raise exception 'invalid Riot host' using errcode = '22023'; end if;
  begin
    if octet_length(coalesce(p_app_limit,''))>256 or octet_length(coalesce(p_app_count,''))>256
      or octet_length(coalesce(p_method_limit,''))>256 or octet_length(coalesce(p_method_count,''))>256 then
      raise exception 'unsupported Riot rate header size' using errcode='22023'; end if;
    foreach v_item in array v_app_limits || v_method_limits loop
      v_parts := pg_catalog.string_to_array(pg_catalog.btrim(v_item),':');
      if pg_catalog.array_length(v_parts,1) is distinct from 2 or v_parts[1] !~ '^[0-9]+$' or v_parts[2] !~ '^[0-9]+$'
        or pg_catalog.length(v_parts[1])>10 or pg_catalog.length(v_parts[2])>5
        or v_parts[1]::numeric<1 or v_parts[1]::numeric>2147483647 or v_parts[2]::integer<1 or v_parts[2]::integer>86400 then
        raise exception 'unsupported Riot rate limit header' using errcode='22023'; end if;
    end loop;
    foreach v_scope in array array['app','method'] loop
      v_limits := case when v_scope='app' then v_app_limits else v_method_limits end;
      v_counts := case when v_scope='app' then v_app_counts else v_method_counts end;
      foreach v_item in array v_counts loop
        v_parts := pg_catalog.string_to_array(pg_catalog.btrim(v_item),':');
        if pg_catalog.array_length(v_parts,1) is distinct from 2 or v_parts[1] !~ '^[0-9]+$' or v_parts[2] !~ '^[0-9]+$'
          or pg_catalog.length(v_parts[1])>10 or pg_catalog.length(v_parts[2])>5
          or v_parts[1]::numeric>2147483647 or v_parts[2]::integer<1 or v_parts[2]::integer>86400 then
          raise exception 'unsupported Riot rate count header' using errcode='22023'; end if;
        v_observed := v_parts[1]::integer; v_window := v_parts[2]::integer; v_limit := null;
        foreach v_limit_item in array v_limits loop
          v_parts := pg_catalog.string_to_array(pg_catalog.btrim(v_limit_item),':');
          if pg_catalog.array_length(v_parts,1)=2 and v_parts[2] ~ '^[0-9]+$' and v_parts[2]::integer=v_window then
            v_limit := case when v_limit is null then v_parts[1]::integer else least(v_limit,v_parts[1]::integer) end;
          end if;
        end loop;
        if v_limit is null then raise exception 'Riot rate count has no matching window' using errcode='22023'; end if;
        if v_observed >= v_limit then
          v_cooldown_until := greatest(v_cooldown_until, v_now + pg_catalog.make_interval(secs => least(v_window, 10)));
        end if;
      end loop;
    end loop;
  exception when sqlstate '22023' or numeric_value_out_of_range then
    v_fail_closed_until := v_now + interval '10 minutes';
    update public.lol_rate_limit_state set blocked_until=greatest(blocked_until,v_fail_closed_until) where host='global';
    update public.lol_rate_limit_state set blocked_until=greatest(blocked_until,v_fail_closed_until) where host=p_host;
    delete from public.lol_collection_leases where lease_type='request';
    return false;
  end;
  update public.lol_rate_limit_state set app_rate_limit = coalesce(left(p_app_limit,256),app_rate_limit),
    app_rate_count = coalesce(left(p_app_count,256),app_rate_count), method_rate_limit = coalesce(left(p_method_limit,256),method_rate_limit),
    method_rate_count = coalesce(left(p_method_count,256),method_rate_count), headers_observed_at = v_now,
    blocked_until = greatest(blocked_until, v_cooldown_until)
    where host = p_host;
  if not found then raise exception 'rate limit state missing' using errcode = '55000'; end if;
  return true;
end $$;

-- 응답을 받은 뒤 헤더 기록과 허가 해제를 한 번의 왕복으로 처리한다.
create or replace function public.finish_lol_riot_request(
  p_token uuid, p_host text, p_app_limit text, p_app_count text, p_method_limit text, p_method_count text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_accepted boolean;
begin
  v_accepted := public.record_lol_riot_rate_headers(p_host,p_app_limit,p_app_count,p_method_limit,p_method_count);
  perform public.release_lol_riot_request(p_token);
  return v_accepted;
end $$;

-- 고정 간격 계산을 더 쓰지 않으므로 기존 값을 기본값으로 되돌린다.
update public.lol_rate_limit_state set min_interval_ms = 1500, next_permit_at = pg_catalog.clock_timestamp();

revoke all on function public.lol_riot_limit_windows(text), public.reserve_lol_riot_request(text,text),
  public.finish_lol_riot_request(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.lol_riot_limit_windows(text), public.reserve_lol_riot_request(text,text),
  public.finish_lol_riot_request(uuid,text,text,text,text,text) to service_role;
commit;
