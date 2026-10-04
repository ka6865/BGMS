set lock_timeout = '3s';
set statement_timeout = '30s';

-- The one-argument global worker keeps its existing recent/oldest policy.
-- This overload has no defaults: PostgREST can resolve each named call uniquely.
create or replace function public.claim_pubg_match_discovery(
  p_limit integer, p_platform text, p_account_id text
) returns setof public.pubg_player_match_discovery
language plpgsql security invoker set search_path = '' as $$
begin
  if p_platform is null or p_account_id is null
    or p_platform not in ('steam','kakao')
    or p_account_id !~ '^account\.[A-Za-z0-9_-]+$' then
    raise exception 'invalid discovery scope';
  end if;
  return query
  with recent as (
    select d.platform,d.account_id,d.match_id from public.pubg_player_match_discovery d
    where d.platform=p_platform and d.account_id=p_account_id
      and d.state in ('pending','retry','running')
      and ((d.state in ('pending','retry') and d.next_attempt_at <= now())
       or (d.state='running' and d.lease_expires_at <= now()))
    order by d.last_seen_at desc,d.first_seen_at,d.match_id
    for update skip locked limit greatest(0,least(coalesce(p_limit,3),3)-1)
  ), oldest as (
    select d.platform,d.account_id,d.match_id from public.pubg_player_match_discovery d
    where d.platform=p_platform and d.account_id=p_account_id
      and d.state in ('pending','retry','running')
      and ((d.state in ('pending','retry') and d.next_attempt_at <= now())
       or (d.state='running' and d.lease_expires_at <= now()))
      and not exists(select 1 from recent r where (r.platform,r.account_id,r.match_id)=(d.platform,d.account_id,d.match_id))
    order by d.first_seen_at,d.match_id
    for update of d skip locked limit greatest(0,least(coalesce(p_limit,3),3)-(select count(*) from recent))
  ), candidates as (
    select * from recent union all select * from oldest
  )
  update public.pubg_player_match_discovery d set state='running',lease_token=gen_random_uuid(),
    lease_expires_at=now()+interval '15 minutes',attempts=d.attempts+1
  from candidates c where (d.platform,d.account_id,d.match_id)=(c.platform,c.account_id,c.match_id)
  returning d.*;
end $$;
revoke all on function public.claim_pubg_match_discovery(integer,text,text) from public,anon,authenticated;
grant execute on function public.claim_pubg_match_discovery(integer,text,text) to service_role;
reset lock_timeout;
reset statement_timeout;
