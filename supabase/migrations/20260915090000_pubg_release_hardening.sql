-- A failed telemetry download must not hold the one-at-a-time global slot.
-- The failed row keeps a short cooldown so retries cannot hammer the source.
alter table public.pubg_encounter_cache
  add column if not exists retry_after timestamptz;

create or replace function public.claim_pubg_encounter(p_platform text,p_subject text,p_match text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare token uuid;
begin
  perform pg_advisory_xact_lock(73131000);
  if exists(select 1 from public.pubg_encounter_cache where lease_expires_at>now()) then return null; end if;
  insert into public.pubg_encounter_cache(platform,subject_account_id,match_id)
  values(p_platform,p_subject,p_match) on conflict do nothing;
  update public.pubg_encounter_cache
  set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes'
  where platform=p_platform and subject_account_id=p_subject and match_id=p_match
    and (result is null or extractor_version<>2)
    and (retry_after is null or retry_after<=now())
    and (lease_expires_at is null or lease_expires_at<=now())
  returning lease_token into token;
  return token;
end $$;

create or replace function public.fail_pubg_encounter(p_token uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare affected integer;
begin
  update public.pubg_encounter_cache
  set lease_token=null,lease_expires_at=null,retry_after=now()+interval '2 minutes',updated_at=now()
  where lease_token=p_token and lease_expires_at>now();
  get diagnostics affected=row_count;
  return affected=1;
end $$;

revoke all on function public.fail_pubg_encounter(uuid) from public,anon,authenticated;
grant execute on function public.fail_pubg_encounter(uuid) to service_role;

-- Keep operational history bounded. Active/retryable work and recent personal
-- evidence are preserved; each invocation deletes at most 500 rows per table.
create or replace function public.cleanup_pubg_tracking_retention()
returns table(discovery_rows bigint,watch_rows bigint,event_rows bigint)
language plpgsql security invoker set search_path='' as $$
begin
  delete from public.pubg_player_match_discovery where ctid in (
    select ctid from public.pubg_player_match_discovery
    where state in ('saved','unavailable') and coalesce(saved_at,last_seen_at)<now()-interval '180 days'
    order by coalesce(saved_at,last_seen_at) limit 500
  );
  get diagnostics discovery_rows=row_count;
  delete from public.pubg_ban_watch_items where ctid in (
    select ctid from public.pubg_ban_watch_items
    where active_until<now()-interval '180 days' order by active_until limit 500
  );
  get diagnostics watch_rows=row_count;
  delete from public.pubg_ban_status_events where ctid in (
    select ctid from public.pubg_ban_status_events
    where observed_at<now()-interval '365 days' order by observed_at limit 500
  );
  get diagnostics event_rows=row_count;
  return next;
end $$;

revoke all on function public.cleanup_pubg_tracking_retention() from public,anon,authenticated;
grant execute on function public.cleanup_pubg_tracking_retention() to service_role;
