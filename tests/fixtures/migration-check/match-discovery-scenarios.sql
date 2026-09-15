-- All checks run only inside the verifier's disposable PostgreSQL database.
do $$
declare j public.pubg_player_match_discovery; n integer; ok boolean; progress jsonb;
begin
  if has_table_privilege('anon','public.pubg_player_match_discovery','SELECT')
    or has_function_privilege('authenticated','public.claim_pubg_match_discovery(integer)','EXECUTE') then
    raise exception 'discovery must be server-only';
  end if;
  perform public.record_pubg_match_discovery('steam','account.discovery','Tester',array(select 'm-'||s from generate_series(1,130) s));
  select count(*) into n from public.pubg_player_match_discovery where account_id='account.discovery';
  if n<>130 then raise exception 'discovery must retain more than 20/100'; end if;
  select * into j from public.claim_pubg_match_discovery(1);
  if j.lease_token is null or j.attempts<>1 then raise exception 'claim requires a fresh lease'; end if;
  ok:=public.settle_pubg_match_discovery(j.platform,j.account_id,j.match_id,gen_random_uuid(),'saved');
  if ok then raise exception 'stale token must not settle'; end if;
  ok:=public.settle_pubg_match_discovery(j.platform,j.account_id,j.match_id,j.lease_token,'saved');
  if not ok then raise exception 'owner must settle'; end if;
  perform public.record_pubg_match_discovery('steam','account.discovery','Tester',array[j.match_id,j.match_id]);
  if not exists(select from public.pubg_player_match_discovery where match_id=j.match_id and account_id=j.account_id and state='saved') then
    raise exception 'rediscovery reset a completed job';
  end if;
  progress:=public.pubg_match_discovery_progress('steam','account.discovery');
  if (progress->>'pendingCount')::int<>129 then raise exception 'wrong progress'; end if;
  -- A nickname rename must not reset the account-scoped backlog.
  update public.pubg_player_match_discovery set nickname_at_discovery='Renamed'
    where ctid in (select ctid from public.pubg_player_match_discovery
      where platform='steam' and account_id='account.discovery' and state='pending' limit 1);
  progress:=public.pubg_match_discovery_progress('steam','account.discovery');
  if (progress->>'pendingCount')::int<>129 then raise exception 'account-scoped progress lost after rename'; end if;
  select * into j from public.claim_pubg_match_discovery(1);
  update public.pubg_player_match_discovery set lease_expires_at=now()-interval '1 minute' where (platform,account_id,match_id)=(j.platform,j.account_id,j.match_id);
  if public.settle_pubg_match_discovery(j.platform,j.account_id,j.match_id,j.lease_token,'saved') then raise exception 'expired lease accepted'; end if;
  -- Remaining entries temporarily moved out of eligibility to verify exact reclaim.
  update public.pubg_player_match_discovery set next_attempt_at=now()+interval '1 day' where state='pending';
  select * into j from public.claim_pubg_match_discovery(1);
  if j.attempts<>2 then raise exception 'expired work not reclaimed'; end if;
  perform public.settle_pubg_match_discovery(j.platform,j.account_id,j.match_id,j.lease_token,'retry',now()+interval '6 hours','not_found');
  if not exists(select from public.pubg_player_match_discovery where match_id=j.match_id and account_id=j.account_id and not_found_count=1 and state='retry') then raise exception '404 retry not persisted'; end if;
  perform public.record_pubg_match_discovery('kakao','account.discovery','Tester',array['m-1']);
  if (select count(*) from public.pubg_player_match_discovery where account_id='account.discovery')<>131 then raise exception 'platform isolation failed'; end if;
  raise notice 'match discovery scenarios passed';
end $$;
