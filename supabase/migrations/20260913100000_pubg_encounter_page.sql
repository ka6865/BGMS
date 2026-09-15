create table if not exists public.pubg_encounter_cache (
  platform text not null check(platform in ('steam','kakao')),
  subject_account_id text not null,
  match_id text not null,
  extractor_version integer not null default 2,
  result jsonb,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(platform,subject_account_id,match_id)
);
alter table public.pubg_encounter_cache enable row level security;
revoke all on public.pubg_encounter_cache from public,anon,authenticated;
grant all on public.pubg_encounter_cache to service_role;
create table if not exists public.pubg_encounter_profiles (
  platform text not null check(platform in ('steam','kakao')),
  account_id text not null,
  season_id text not null,
  match_type text not null check(match_type in ('official','competitive')),
  stats jsonb,
  checked_at timestamptz,
  retry_at timestamptz not null default now(),
  primary key(platform,account_id,season_id,match_type)
);
alter table public.pubg_encounter_profiles enable row level security;
revoke all on public.pubg_encounter_profiles from public,anon,authenticated;
grant all on public.pubg_encounter_profiles to service_role;
create table if not exists public.pubg_encounter_api_budget (
  bucket timestamptz primary key,
  used integer not null default 0
);
alter table public.pubg_encounter_api_budget enable row level security;
revoke all on public.pubg_encounter_api_budget from public,anon,authenticated;
grant all on public.pubg_encounter_api_budget to service_role;
create or replace function public.claim_pubg_encounter(p_platform text,p_subject text,p_match text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare token uuid;
begin
  perform pg_advisory_xact_lock(73131000);
  if exists(select 1 from public.pubg_encounter_cache where lease_expires_at>now()) then return null; end if;
  insert into public.pubg_encounter_cache(platform,subject_account_id,match_id) values(p_platform,p_subject,p_match) on conflict do nothing;
  update public.pubg_encounter_cache set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes'
  where platform=p_platform and subject_account_id=p_subject and match_id=p_match
    and (result is null or extractor_version<>2) and (lease_expires_at is null or lease_expires_at<=now())
  returning lease_token into token;
  return token;
end $$;
create or replace function public.finish_pubg_encounter(p_token uuid,p_result jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  if p_result is null or jsonb_typeof(p_result->'encounters') is distinct from 'array'
    or jsonb_array_length(p_result->'encounters')>400 or pg_column_size(p_result)>524288 then raise exception 'invalid encounter result'; end if;
  update public.pubg_encounter_cache set result=p_result,extractor_version=2,lease_token=null,lease_expires_at=null,updated_at=now()
  where lease_token=p_token and lease_expires_at>now()
    and p_result#>>'{source,platform}'=platform
    and p_result#>>'{source,matchId}'=match_id
    and p_result#>>'{source,verifiedSubjectAccountId}'=subject_account_id;get diagnostics n=row_count;return n=1;
end $$;
create or replace function public.claim_pubg_encounter_profile_request()
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer; b timestamptz:=date_trunc('minute',now());
begin
  insert into public.pubg_encounter_api_budget(bucket,used) values(b,1)
  on conflict(bucket) do update set used=public.pubg_encounter_api_budget.used+1 where public.pubg_encounter_api_budget.used<2;
  get diagnostics n=row_count;return n=1;
end $$;
revoke all on function public.claim_pubg_encounter(text,text,text),public.finish_pubg_encounter(uuid,jsonb),public.claim_pubg_encounter_profile_request() from public,anon,authenticated;
grant execute on function public.claim_pubg_encounter(text,text,text),public.finish_pubg_encounter(uuid,jsonb),public.claim_pubg_encounter_profile_request() to service_role;
create table if not exists public.pubg_encounter_seasons (
  platform text primary key check(platform in ('steam','kakao')),
  season_id text not null,
  checked_at timestamptz not null default now()
);
alter table public.pubg_encounter_seasons enable row level security;
revoke all on public.pubg_encounter_seasons from public,anon,authenticated;
grant all on public.pubg_encounter_seasons to service_role;
-- Read-time retention is not cleanup. A bounded service-only cleanup removes
-- unused caches; independent watch-item evidence is never removed here.
create or replace function public.cleanup_pubg_encounter_cache()
returns integer language plpgsql security invoker set search_path='' as $$
declare n integer; total integer:=0;
begin
  delete from public.pubg_encounter_cache where (platform,subject_account_id,match_id) in
    (select platform,subject_account_id,match_id from public.pubg_encounter_cache where updated_at<now()-interval '90 days' and (lease_expires_at is null or lease_expires_at<now()) limit 500);
  get diagnostics n=row_count;total=total+n;
  delete from public.pubg_encounter_profiles where (platform,account_id,season_id,match_type) in
    (select platform,account_id,season_id,match_type from public.pubg_encounter_profiles where greatest(coalesce(checked_at,'epoch'),retry_at)<now()-interval '30 days' limit 500);
  get diagnostics n=row_count;total=total+n;
  delete from public.pubg_encounter_api_budget where bucket<now()-interval '2 days';
  return total;
end $$;
revoke all on function public.cleanup_pubg_encounter_cache() from public,anon,authenticated;
grant execute on function public.cleanup_pubg_encounter_cache() to service_role;
