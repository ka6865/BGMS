-- Durable discovery is separate from the 20-match presentation cache.
create table if not exists public.pubg_player_match_discovery (
  platform text not null check (platform in ('steam','kakao')),
  account_id text not null check (account_id ~ '^account\.[A-Za-z0-9_-]+$'),
  match_id text not null check (length(match_id) between 1 and 128),
  nickname_at_discovery text not null check (length(nickname_at_discovery) between 1 and 64),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  state text not null default 'pending' check (state in ('pending','running','saved','unavailable','retry')),
  attempts integer not null default 0,
  not_found_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid, lease_expires_at timestamptz,
  last_error_code text, saved_at timestamptz,
  primary key (platform, account_id, match_id)
);
create index if not exists pubg_discovery_pending_idx on public.pubg_player_match_discovery (next_attempt_at,first_seen_at) where state in ('pending','retry','running');
create index if not exists pubg_discovery_nickname_idx on public.pubg_player_match_discovery (platform,lower(nickname_at_discovery));
alter table public.pubg_player_match_discovery enable row level security;
revoke all on public.pubg_player_match_discovery from public,anon,authenticated;
grant select,insert,update on public.pubg_player_match_discovery to service_role;

create or replace function public.record_pubg_match_discovery(p_platform text,p_account_id text,p_nickname text,p_match_ids text[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_platform not in ('steam','kakao') or p_account_id !~ '^account\.[A-Za-z0-9_-]+$'
    or coalesce(length(trim(p_nickname)),0) not between 1 and 64 or coalesce(cardinality(p_match_ids),0)>250 then
    raise exception 'invalid discovery input';
  end if;
  insert into public.pubg_player_match_discovery(platform,account_id,match_id,nickname_at_discovery)
  select p_platform,p_account_id,id,p_nickname from (select distinct unnest(p_match_ids) as id) ids
  where id is not null and length(trim(id)) between 1 and 128
  on conflict(platform,account_id,match_id) do update set last_seen_at=now();
end $$;
create or replace function public.claim_pubg_match_discovery(p_limit integer default 3)
returns setof public.pubg_player_match_discovery language sql security invoker set search_path = '' as $$
  with candidates as (
    select platform,account_id,match_id from public.pubg_player_match_discovery
    where (state in ('pending','retry') and next_attempt_at <= now())
       or (state='running' and lease_expires_at <= now())
    order by first_seen_at, match_id
    for update skip locked limit greatest(0,least(coalesce(p_limit,3),3))
  )
  update public.pubg_player_match_discovery d set state='running',lease_token=gen_random_uuid(),
    lease_expires_at=now()+interval '15 minutes',attempts=d.attempts+1
  from candidates c where (d.platform,d.account_id,d.match_id)=(c.platform,c.account_id,c.match_id)
  returning d.*;
$$;
create or replace function public.settle_pubg_match_discovery(p_platform text,p_account_id text,p_match_id text,p_lease_token uuid,p_state text,p_next_attempt_at timestamptz default null,p_error_code text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if p_state not in ('saved','retry','unavailable') then raise exception 'invalid settlement'; end if;
  update public.pubg_player_match_discovery set state=p_state,next_attempt_at=coalesce(p_next_attempt_at,now()),
    lease_token=null,lease_expires_at=null,last_error_code=p_error_code,
    not_found_count=not_found_count+case when p_error_code='not_found' then 1 else 0 end,
    saved_at=case when p_state='saved' then now() else saved_at end
  where platform=p_platform and account_id=p_account_id and match_id=p_match_id
    and state='running' and lease_token=p_lease_token and lease_expires_at>now();
  get diagnostics affected=row_count;
  return affected=1;
end $$;
create or replace function public.pubg_match_discovery_progress(p_platform text,p_account_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('pendingCount',count(*) filter(where state in ('pending','running','retry')),
    'unavailableCount',count(*) filter(where state='unavailable'),'lastSavedAt',max(saved_at))
  from public.pubg_player_match_discovery where platform=p_platform and account_id=p_account_id;
$$;
revoke all on function public.record_pubg_match_discovery(text,text,text,text[]) from public,anon,authenticated;
revoke all on function public.claim_pubg_match_discovery(integer) from public,anon,authenticated;
revoke all on function public.settle_pubg_match_discovery(text,text,text,uuid,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.pubg_match_discovery_progress(text,text) from public,anon,authenticated;
grant execute on function public.record_pubg_match_discovery(text,text,text,text[]) to service_role;
grant execute on function public.claim_pubg_match_discovery(integer) to service_role;
grant execute on function public.settle_pubg_match_discovery(text,text,text,uuid,text,timestamptz,text) to service_role;
grant execute on function public.pubg_match_discovery_progress(text,text) to service_role;
