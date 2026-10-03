set lock_timeout = '3s';
set statement_timeout = '30s';

create index if not exists idx_pubg_discovery_recent_claim
  on public.pubg_player_match_discovery(last_seen_at desc, first_seen_at, match_id)
  where state in ('pending','retry','running');

create or replace function public.claim_pubg_match_discovery(p_limit integer default 3)
returns setof public.pubg_player_match_discovery language sql security invoker set search_path = '' as $$
  -- ponytail: fixed two recent/one oldest split; add account fairness only if one account dominates.
  with recent as (
    select platform,account_id,match_id from public.pubg_player_match_discovery
    where (state in ('pending','retry') and next_attempt_at <= now())
       or (state='running' and lease_expires_at <= now())
    order by last_seen_at desc,first_seen_at,match_id
    for update skip locked limit greatest(0,least(coalesce(p_limit,3),3)-1)
  ), oldest as (
    select d.platform,d.account_id,d.match_id from public.pubg_player_match_discovery d
    where ((state in ('pending','retry') and next_attempt_at <= now())
       or (state='running' and lease_expires_at <= now()))
      and not exists(select 1 from recent r where (r.platform,r.account_id,r.match_id)=(d.platform,d.account_id,d.match_id))
    order by first_seen_at,match_id
    for update of d skip locked
    limit greatest(0,least(coalesce(p_limit,3),3)-(select count(*) from recent))
  ), candidates as (
    select * from recent union all select * from oldest
  )
  update public.pubg_player_match_discovery d set state='running',lease_token=gen_random_uuid(),
    lease_expires_at=now()+interval '15 minutes',attempts=d.attempts+1
  from candidates c where (d.platform,d.account_id,d.match_id)=(c.platform,c.account_id,c.match_id)
  returning d.*;
$$;

revoke all on function public.claim_pubg_match_discovery(integer) from public,anon,authenticated;
grant execute on function public.claim_pubg_match_discovery(integer) to service_role;

reset lock_timeout;
reset statement_timeout;
