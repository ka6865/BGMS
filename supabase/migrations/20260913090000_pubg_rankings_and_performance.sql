-- Additive: existing readers keep working; no jobs run until explicitly enabled.
alter table public.pubg_player_matches add column if not exists account_id text;
alter table public.pubg_player_matches add column if not exists ranking_eligible boolean;
create index if not exists pubg_matches_ranking_date on public.pubg_player_matches(played_at desc, platform);
create index if not exists pubg_discovery_match_identity_idx on public.pubg_player_match_discovery(platform,match_id,account_id);

create table if not exists public.pubg_match_performance (
  platform text not null check(platform in ('steam','kakao')),
  account_id text not null check(account_id ~ '^account\.[A-Za-z0-9_-]+$'),
  match_id text not null,
  player_id text not null,
  calculation_version integer not null,
  result_version integer not null,
  score double precision not null check(score >= 0 and score <= 100),
  tier text not null,
  benchmark jsonb not null,
  ranking_eligible boolean not null,
  calculated_at timestamptz not null default now(),
  primary key(platform,account_id,match_id,calculation_version,result_version)
);
alter table public.pubg_match_performance enable row level security;
revoke all on public.pubg_match_performance from public,anon,authenticated;
grant all on public.pubg_match_performance to service_role;

create table if not exists public.pubg_performance_jobs (
  platform text not null,
  account_id text not null,
  match_id text not null,
  player_id text not null,
  calculation_version integer not null,
  result_version integer not null,
  state text not null default 'pending' check(state in ('pending','running','done','retry','excluded','unavailable')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key(platform,account_id,match_id,calculation_version,result_version)
);
alter table public.pubg_performance_jobs enable row level security;
revoke all on public.pubg_performance_jobs from public,anon,authenticated;
grant all on public.pubg_performance_jobs to service_role;
create index if not exists pubg_performance_due on public.pubg_performance_jobs(next_attempt_at) where state in ('pending','retry','running');
create table if not exists public.pubg_performance_budget (
  day date primary key,
  used integer not null default 0
);
alter table public.pubg_performance_budget enable row level security;
revoke all on public.pubg_performance_budget from public,anon,authenticated;
grant all on public.pubg_performance_budget to service_role;

-- Poll the existing basic-match store. Queue only recently active linked profiles,
-- never every searched nickname. A repeat seed never reopens completed work.
create or replace function public.seed_pubg_performance_jobs(p_calculation integer,p_result integer)
returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  -- Serialize seeding with claims so the backlog cap is a real global bound.
  perform pg_advisory_xact_lock(73130900);

  -- A deploy/version change must not leave old work retrying forever. Expired
  -- leases are safe to terminalize; an active worker keeps its lease intact.
  update public.pubg_performance_jobs j set state='excluded',
    last_error='stale performance job',lease_token=null,lease_expires_at=null,updated_at=now()
  where j.state in ('pending','retry')
    and (j.calculation_version<>p_calculation or j.result_version<>p_result
      or exists(select 1 from public.pubg_player_matches m
        where m.platform=j.platform and m.account_id=j.account_id and m.match_id=j.match_id
          and m.played_at < now()-interval '7 days'));
  update public.pubg_performance_jobs j set state='excluded',
    last_error='stale performance lease',lease_token=null,lease_expires_at=null,updated_at=now()
  where j.state='running' and j.lease_expires_at<=now()
    and (j.calculation_version<>p_calculation or j.result_version<>p_result
      or exists(select 1 from public.pubg_player_matches m
        where m.platform=j.platform and m.account_id=j.account_id and m.match_id=j.match_id
          and m.played_at < now()-interval '7 days'));

  -- Keep pending/retry/running work bounded even if an older runner filled the
  -- table before this guard existed. Preserve rows as excluded audit records.
  with overflow as (
    select ctid from (
      select ctid,row_number() over(order by next_attempt_at,updated_at,match_id) as pos
      from public.pubg_performance_jobs where state in ('pending','retry')
    ) ranked where pos>greatest(0,300-(select count(*) from public.pubg_performance_jobs where state='running'))
  )
  update public.pubg_performance_jobs j set state='excluded',last_error='performance backlog limit',updated_at=now()
  where j.ctid in (select ctid from overflow);

  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version)
  select m.platform,m.account_id,m.match_id,m.player_id,p_calculation,p_result
  from public.pubg_player_matches m
  where m.played_at between now()-interval '7 days' and now()
    and m.account_id ~ '^account\.[A-Za-z0-9_-]+$' and m.ranking_eligible is true
    and exists(select 1 from public.profiles p where lower(trim(p.pubg_nickname))=m.player_id
      and coalesce(p.pubg_platform,'steam')=m.platform and p.last_active_at >= now()-interval '7 days')
    and not exists(select 1 from public.pubg_performance_jobs j where
      (j.platform,j.account_id,j.match_id,j.calculation_version,j.result_version)=
      (m.platform,m.account_id,m.match_id,p_calculation,p_result))
  order by m.played_at desc
  limit least(50,greatest(0,300-(select count(*) from public.pubg_performance_jobs where state in ('pending','retry','running'))))
  on conflict do nothing;
  get diagnostics n=row_count; return n;
end $$;

-- A DB lock and UTC-day quota survive runner restarts and workflow retries.
create or replace function public.claim_pubg_performance_job(p_daily_limit integer default 30)
returns setof public.pubg_performance_jobs language plpgsql security invoker set search_path='' as $$
declare j public.pubg_performance_jobs; v_day date := (now() at time zone 'UTC')::date; v_used integer;
begin
  perform pg_advisory_xact_lock(73130900);
  if exists(select 1 from public.pubg_performance_jobs where state='running' and lease_expires_at>now()) then return; end if;
  insert into public.pubg_performance_budget(day) values(v_day) on conflict do nothing;
  select used into v_used from public.pubg_performance_budget where day=v_day for update;
  if v_used >= greatest(0,least(coalesce(p_daily_limit,30),100)) then return; end if;
  select * into j from public.pubg_performance_jobs
    where ((state in ('pending','retry') and next_attempt_at<=now()) or (state='running' and lease_expires_at<=now()))
    order by next_attempt_at,match_id for update skip locked limit 1;
  if not found then return; end if;
  update public.pubg_performance_budget set used=used+1 where day=v_day;
  return query update public.pubg_performance_jobs set state='running',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
    where (platform,account_id,match_id,calculation_version,result_version)=
      (j.platform,j.account_id,j.match_id,j.calculation_version,j.result_version) returning *;
end $$;

-- Atomically publish only while holding the lease. A killed/late worker cannot
-- overwrite a newer result or mark another worker's job completed.
create or replace function public.finish_pubg_performance_job(p_token uuid,p_state text,p_result jsonb default null,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare j public.pubg_performance_jobs;
begin
  if p_state not in ('done','retry','excluded','unavailable') then raise exception 'invalid state'; end if;
  select * into j from public.pubg_performance_jobs where lease_token=p_token and state='running' and lease_expires_at>now() for update;
  if not found then return false; end if;
  if p_state='done' then
    if p_result is null or jsonb_typeof(p_result->'benchmark')<>'object' then raise exception 'result required'; end if;
    insert into public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,score,tier,benchmark,ranking_eligible)
    values(j.platform,j.account_id,j.match_id,j.player_id,j.calculation_version,j.result_version,
      (p_result->'benchmark'->>'score')::double precision,p_result->'benchmark'->>'tier',p_result->'benchmark',
      coalesce((p_result->>'rankingEligible')::boolean,false))
    on conflict(platform,account_id,match_id,calculation_version,result_version) do update set
      score=excluded.score,tier=excluded.tier,benchmark=excluded.benchmark,ranking_eligible=excluded.ranking_eligible,calculated_at=now();
  end if;
  update public.pubg_performance_jobs set state=case when p_state='retry' and attempts>=3 then 'unavailable' else p_state end,
    next_attempt_at=now()+interval '1 hour',last_error=left(p_error,200),lease_token=null,lease_expires_at=null,updated_at=now()
    where lease_token=p_token;
  return true;
end $$;

-- Bound service-role operational tables. Only terminal jobs are removable;
-- pending/running/retry rows remain available for the worker and audit.
create or replace function public.cleanup_pubg_performance_retention(p_keep_days integer default 90)
returns table(performance_rows bigint,job_rows bigint,budget_rows bigint)
language plpgsql security invoker set search_path='' as $$
declare cutoff timestamptz; day_cutoff date;
begin
  if p_keep_days is null or p_keep_days < 1 or p_keep_days > 3650 then raise exception 'invalid retention days'; end if;
  cutoff := now() - make_interval(days => p_keep_days);
  day_cutoff := ((now() at time zone 'UTC')::date - p_keep_days);
  delete from public.pubg_match_performance where ctid in (select ctid from public.pubg_match_performance where calculated_at < cutoff order by calculated_at limit 500);
  get diagnostics performance_rows = row_count;
  delete from public.pubg_performance_jobs where ctid in (select ctid from public.pubg_performance_jobs where updated_at < cutoff and state in ('done','excluded','unavailable') order by updated_at limit 500);
  get diagnostics job_rows = row_count;
  delete from public.pubg_performance_budget where day < day_cutoff;
  get diagnostics budget_rows = row_count;
  return next;
end $$;

-- Aggregate before LIMIT: one account cannot crowd other players out of the
-- candidate window. Unknown legacy accounts are kept separate by platform/name.
create or replace function public.get_pubg_rankings(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_excluded text[] default '{}')
returns table(platform text,player_id text,account_id text,value double precision,secondary double precision,tier text,game_mode text,map_name text,played_at timestamptz,match_count bigint)
language sql stable security invoker set search_path='' as $$
  with eligible as (
    select m.*,case when m.account_id ~ '^account\.[A-Za-z0-9_-]+$' then m.account_id else 'legacy:'||m.player_id end as identity,
      s.score as performance_score,s.tier as performance_tier
    from public.pubg_player_matches m
    left join lateral (
      select source.score,source.tier from (
        select b.score,b.tier,1 as source_priority from public.global_benchmarks b
        where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
          and b.calculation_version=p_calculation and b.filter_version=p_filter and b.population_evidence_version=p_population
          and b.match_type in ('official','competitive') and b.score is not null
        union all
        select f.score,f.tier,2 as source_priority from public.pubg_match_performance f
        where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
          and f.calculation_version=p_calculation and f.result_version=p_result and f.ranking_eligible
      ) source order by source.source_priority limit 1
    ) s on true
    where m.played_at>=now()-interval '7 days' and m.played_at<=now()
      and m.platform in ('steam','kakao') and m.game_mode=any(p_modes)
      and m.match_type in ('official','competitive') and (p_match_type='all' or m.match_type=p_match_type)
      and not ((m.platform||':'||m.player_id)=any(p_excluded)
        or (m.account_id is not null and (m.platform||':account:'||m.account_id)=any(p_excluded))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_match_discovery discovery
          where discovery.platform=m.platform and discovery.match_id=m.match_id
            and (m.platform||':account:'||discovery.account_id)=any(p_excluded)
        )))
      and (m.ranking_eligible is true or s.score is not null)
      and m.kills>=0 and m.damage>=0
  ), ranked as (
    select e.*,case p_tab when 'damage' then e.damage::double precision when 'kills' then e.kills::double precision else e.performance_score end as metric,
      case p_tab when 'damage' then e.kills::double precision else e.damage::double precision end as extra
    from eligible e where p_tab in ('damage','kills','tier') and (p_tab<>'tier' or e.performance_score is not null)
  ), best as (
    select r.*,row_number() over(partition by r.platform,r.identity order by r.metric desc,r.extra desc,r.played_at desc,r.match_id) as pos,
      count(*) over(partition by r.platform,r.identity) as n
    from ranked r
  )
  select b.platform,b.player_id,b.account_id,b.metric,b.extra,b.performance_tier,b.game_mode,b.map_name,b.played_at,b.n
  from best b where pos=1 order by metric desc,extra desc,played_at desc,b.platform,b.identity limit 30;
$$;
revoke all on function public.seed_pubg_performance_jobs(integer,integer),public.claim_pubg_performance_job(integer),public.finish_pubg_performance_job(uuid,text,jsonb,text),public.cleanup_pubg_performance_retention(integer),public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) from public,anon,authenticated;
grant execute on function public.seed_pubg_performance_jobs(integer,integer),public.claim_pubg_performance_job(integer),public.finish_pubg_performance_job(uuid,text,jsonb,text),public.cleanup_pubg_performance_retention(integer),public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) to service_role;
