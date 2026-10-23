-- LoL 개발용 하루 40회 자체 예산 제거
-- 관리자 혼자 테스트하는 단계라 일일 상한은 두지 않는다. Riot 응답 헤더 기반 감속, 429 쿨다운,
-- 요청 lease 2개, 최소 1.5초 간격은 그대로 유지한다. used_count는 관측용으로 계속 센다.
create or replace function public.reserve_lol_riot_request(p_host text)
returns table (granted boolean, lease_token uuid, permit_at timestamptz, retry_after_seconds integer, reason text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz; v_day date;
  v_global public.lol_rate_limit_state%rowtype; v_host public.lol_rate_limit_state%rowtype;
  v_live integer; v_permit timestamptz; v_token uuid := gen_random_uuid(); v_retry integer;
begin
  if p_host not in ('asia','kr') then raise exception 'invalid Riot host' using errcode = '22023'; end if;
  select * into v_global from public.lol_rate_limit_state where host = 'global' for update;
  select * into v_host from public.lol_rate_limit_state where host = p_host for update;
  if v_global.host is null or v_host.host is null then raise exception 'rate limit state missing' using errcode = '55000'; end if;
  v_now := pg_catalog.clock_timestamp(); v_day := (pg_catalog.timezone('UTC',v_now))::date;
  delete from public.lol_collection_leases where lease_type = 'request' and lease_until <= v_now;
  if v_global.budget_day <> v_day then
    update public.lol_rate_limit_state set budget_day = v_day, used_count = 0 where host = 'global' returning * into v_global;
  end if;
  if greatest(v_global.blocked_until, v_host.blocked_until) > v_now then
    v_retry := greatest(1, ceil(extract(epoch from greatest(v_global.blocked_until, v_host.blocked_until) - v_now))::integer);
    return query select false, null::uuid, null::timestamptz, v_retry, 'cooldown'; return;
  end if;
  select count(*)::integer into v_live from public.lol_collection_leases where lease_type = 'request';
  if v_live >= 2 then return query select false, null::uuid, null::timestamptz, 1, 'concurrency'; return; end if;
  v_permit := greatest(v_now, v_global.next_permit_at);
  update public.lol_rate_limit_state set next_permit_at = v_permit + pg_catalog.make_interval(secs=>v_global.min_interval_ms::double precision/1000), used_count = used_count + 1 where host = 'global';
  insert into public.lol_collection_leases (lease_key, lease_type, lease_token, lease_until, request_host, permit_at)
    values ('request:' || v_token::text, 'request', v_token, v_permit + interval '12 seconds', p_host, v_permit);
  return query select true, v_token, v_permit, 0, 'granted';
end $$;

