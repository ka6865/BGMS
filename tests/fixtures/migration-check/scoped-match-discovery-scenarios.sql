-- Runs only in the verifier's disposable PostgreSQL database.
begin;
do $$
declare jobs text[]; n integer; j public.pubg_player_match_discovery; global_claims integer := 0;
begin
  if to_regprocedure('public.claim_pubg_match_discovery(integer)') is null
    or to_regprocedure('public.claim_scoped_pubg_match_discovery(integer,text,text)') is null
    or to_regprocedure('public.claim_pubg_match_discovery(integer,text,text)') is not null then
    raise exception 'global/scoped RPC names must be unambiguous';
  end if;
  if has_function_privilege('anon','public.claim_scoped_pubg_match_discovery(integer,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.claim_scoped_pubg_match_discovery(integer,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_scoped_pubg_match_discovery(integer,text,text)','EXECUTE')
    or exists(select from pg_proc where oid='public.claim_scoped_pubg_match_discovery(integer,text,text)'::regprocedure and prosecdef) then
    raise exception 'scoped collection must be service-only and security invoker';
  end if;
  update public.pubg_player_match_discovery set next_attempt_at=now()+interval '1 day' where state in ('pending','retry');
  perform public.record_pubg_match_discovery('steam','account.scoped','Scoped',array['old','new1','new2','future','expired']);
  perform public.record_pubg_match_discovery('steam','account.other','Other',array['other']);
  perform public.record_pubg_match_discovery('kakao','account.scoped','Scoped',array['kakao']);
  update public.pubg_player_match_discovery set first_seen_at=now()-interval '10 days',last_seen_at=now()-interval '10 days'
    where platform='steam' and account_id='account.scoped' and match_id='old';
  update public.pubg_player_match_discovery set next_attempt_at=now()+interval '1 day',state='retry'
    where platform='steam' and account_id='account.scoped' and match_id='future';
  update public.pubg_player_match_discovery set state='running',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute',attempts=1
    where platform='steam' and account_id='account.scoped' and match_id='expired';
  select count(*) into n from public.claim_scoped_pubg_match_discovery(0,'steam','account.scoped');
  if n<>0 then raise exception 'zero scoped claim must not lease'; end if;
  select array_agg(match_id order by match_id) into jobs from public.claim_scoped_pubg_match_discovery(999,'steam','account.scoped');
  if cardinality(jobs)<>3 or not ('old'=any(jobs)) then raise exception 'scoped claim must cap at three and include oldest: %',jobs; end if;
  if exists(select from public.pubg_player_match_discovery
    where platform='steam' and account_id='account.scoped' and match_id=any(jobs)
      and abs(extract(epoch from lease_expires_at-now())-30)>1) then
    raise exception 'scoped claims must lease for approximately 30 seconds';
  end if;
  if exists(select from public.pubg_player_match_discovery where state='running' and lease_expires_at>now()
    and (account_id='account.other' or platform='kakao')) then raise exception 'scoped claim crossed identity/platform'; end if;
  -- A global claim on the same table must not claim the still-live scoped jobs.
  for j in select * from public.claim_pubg_match_discovery(3) loop
    global_claims := global_claims + 1;
    if abs(extract(epoch from j.lease_expires_at-now())-900)>1 then
      raise exception 'global claims must retain the 15-minute lease';
    end if;
    if j.account_id='account.scoped' and j.platform='steam' and j.match_id=any(jobs) then
      raise exception 'global collector duplicated a scoped lease';
    end if;
  end loop;
  if global_claims=0 then raise exception 'fixture expected at least one global claim'; end if;
  if not exists(select from public.pubg_player_match_discovery where account_id='account.scoped' and platform='steam'
    and match_id='expired' and attempts=2 and lease_expires_at>now()) then raise exception 'expired scoped/global lease not reclaimed'; end if;
  begin
    perform public.claim_scoped_pubg_match_discovery(3,'console','account.scoped');
    raise exception 'invalid scope accepted';
  exception when raise_exception then
    if sqlerrm <> 'invalid discovery scope' then raise; end if;
  end;
  raise notice 'scoped match discovery scenarios passed';
end $$;
rollback;
