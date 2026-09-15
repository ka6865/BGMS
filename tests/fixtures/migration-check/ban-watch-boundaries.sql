-- Additional integration checks against the real PostgreSQL functions.
\set ON_ERROR_STOP on
insert into auth.users(id) values ('88888888-8888-4888-8888-888888888888') on conflict do nothing;
do $$
declare result jsonb; event_count integer; previous text; changed boolean; token uuid := gen_random_uuid();
begin
  result := public.record_pubg_ban_observation('steam','account.boundary-observation','None','none',now()-interval '3 hours',now()+interval '1 day');
  if result->>'code' <> 'recorded' then raise exception 'FAIL: first observation'; end if;
  select previous_status into previous from public.pubg_ban_status_events where account_id='account.boundary-observation';
  if previous is not null then raise exception 'FAIL: initial observation must have no previous known status'; end if;
  perform public.record_pubg_ban_observation('steam','account.boundary-observation','None','none',now()-interval '2 hours',now()+interval '1 day');
  select count(*) into event_count from public.pubg_ban_status_events where account_id='account.boundary-observation';
  if event_count <> 1 then raise exception 'FAIL: same status created duplicate events (%)', event_count; end if;
  perform public.record_pubg_ban_observation('steam','account.boundary-observation','TemporaryBan','temporary',now()-interval '1 hour',now()+interval '6 hours');
  perform public.record_pubg_ban_observation('steam','account.boundary-observation','None','none',now(),now()+interval '1 day');
  select count(*) into event_count from public.pubg_ban_status_events where account_id='account.boundary-observation';
  if event_count <> 3 then raise exception 'FAIL: state transitions were lost (%)', event_count; end if;
  update public.pubg_ban_status set lease_token=token,lease_expires_at=now()-interval '1 minute' where account_id='account.boundary-observation';
  changed := public.record_pubg_ban_error('steam','account.boundary-observation','network_error',now()+interval '1 hour',token);
  if changed then raise exception 'FAIL: expired error lease mutated status'; end if;
  if (select last_error from public.pubg_ban_status where account_id='account.boundary-observation') is not null then raise exception 'FAIL: expired lease changed last_error'; end if;
  raise notice 'PASS: first observation, transition-only history and expired error lease';
end $$;

do $$
declare result jsonb; expired_id uuid; user_id uuid := '88888888-8888-4888-8888-888888888888'; i integer;
begin
  for i in 1..10 loop
    result := public.create_pubg_ban_watch_item(user_id,'steam','account.boundary-subject','account.boundary-target','boundary-match-'||i,now(),'killer','Boundary Target');
    if result->>'code' <> 'created' then raise exception 'FAIL: setup 10 active matches'; end if;
  end loop;
  insert into public.pubg_ban_watch_items(user_id,platform,subject_account_id,target_account_id,match_id,event_at,role,nickname_at_match,active_until)
  values(user_id,'steam','account.boundary-subject','account.boundary-target','boundary-expired',now(),'killer','Boundary Target',now()-interval '1 day') returning id into expired_id;
  result := public.extend_pubg_ban_watch_item(user_id,expired_id,now()+interval '30 days');
  if result->>'code' <> 'target_match_limit' then raise exception 'FAIL: extension bypassed 10 active matches (%)',result; end if;
  for i in 2..50 loop
    result := public.create_pubg_ban_watch_item(user_id,'steam','account.boundary-subject','account.boundary-target-'||i,'boundary-match-1',now(),'killer','Boundary Target');
    if result->>'code' <> 'created' then raise exception 'FAIL: setup 50 targets (%)',i; end if;
  end loop;
  result := public.create_pubg_ban_watch_item(user_id,'kakao','account.boundary-subject','account.boundary-target','boundary-match-1',now(),'killer','Boundary Target');
  if result->>'code' <> 'user_target_limit' then raise exception 'FAIL: cross-platform target bypassed 50-target limit (%)',result; end if;
  result := public.create_pubg_ban_watch_item(user_id,'steam','account.boundary-subject','account.boundary-target-2','boundary-match-2',now(),'killer','Boundary Target');
  if result->>'code' <> 'created' then raise exception 'FAIL: existing target cannot add a match at 50 targets (%)',result; end if;
  raise notice 'PASS: extension match cap, platform target cap and existing target at cap';
end $$;
