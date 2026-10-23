-- Reuse the dedicated LoL contract fixture; extend it with full table ACL and
-- global permit boundary checks for the common migration verifier.
\i tests/fixtures/lol-persistence-verification.sql

do $$
declare
  v_table text;
  v_role text;
  v_privilege text;
begin
  foreach v_table in array array[
    'lol_accounts','lol_ranked_entries','lol_matches','lol_match_participants',
    'lol_api_cache','lol_rate_limit_state','lol_collection_leases'
  ] loop
    if not (select relrowsecurity from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.'||v_table)) then
      raise exception 'RLS is disabled on %',v_table;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if pg_catalog.has_table_privilege(v_role,'public.'||v_table,v_privilege) then
          raise exception '% has % on public.%',v_role,v_privilege,v_table;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

set role service_role;
do $$
declare v_first record; v_second record; v_third record; v_budget record;
begin
  update public.lol_rate_limit_state
  set next_permit_at=pg_catalog.clock_timestamp(),min_interval_ms=1500,last_started_at=null,
      blocked_until='-infinity',budget_day=(pg_catalog.timezone('UTC',pg_catalog.clock_timestamp()))::date,used_count=0
  where host in ('global','asia','kr');
  select * into v_first from public.reserve_lol_riot_request('asia');
  select * into v_second from public.reserve_lol_riot_request('asia');
  select * into v_third from public.reserve_lol_riot_request('asia');
  if not v_first.granted or not v_second.granted then raise exception 'first two permits were not granted'; end if;
  if v_third.granted or v_third.reason<>'concurrency' then raise exception 'third permit exceeded concurrency limit'; end if;
  if v_second.permit_at-v_first.permit_at < interval '1.5 seconds' then
    raise exception 'global request interval was below 1.5 seconds';
  end if;
  update public.lol_rate_limit_state set used_count=40 where host in ('global','asia','kr');
  select * into v_budget from public.reserve_lol_riot_request('asia');
  if v_budget.reason='daily_budget' then raise exception 'removed daily budget is still enforced'; end if;
end $$;
reset role;
