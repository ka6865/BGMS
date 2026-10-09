-- 기존 계산 결과를 보존하고 신규 계산 3과 기본 점수 랭킹을 함께 조회한다. 데이터 UPDATE/재라벨은 없다.
create or replace function public.get_pubg_rankings(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_excluded text[] default '{}')
returns table(platform text,player_id text,account_id text,value double precision,secondary double precision,tier text,game_mode text,map_name text,played_at timestamptz,match_count bigint)
language sql stable security invoker set search_path='' as $$
  with candidates as materialized (
    select m.platform,m.player_id,m.account_id,m.match_id,m.game_mode,m.map_name,m.played_at,m.kills,m.damage,m.ranking_eligible,
      case when m.account_id ~ '^account\.[A-Za-z0-9_-]+$' then m.account_id else 'legacy:'||m.player_id end as identity
    from public.pubg_player_matches m
    where m.played_at>=now()-interval '7 days' and m.played_at<=now()
      and m.platform in ('steam','kakao') and m.game_mode=any(p_modes)
      and m.match_type in ('official','competitive') and (p_match_type='all' or m.match_type=p_match_type)
      and not ((m.platform||':'||m.player_id)=any(p_excluded)
        or (m.account_id is not null and (m.platform||':account:'||m.account_id)=any(p_excluded))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_match_discovery discovery
          where discovery.platform=m.platform and discovery.match_id=m.match_id
            and (discovery.platform||':account:'||discovery.account_id)=any(p_excluded)
        ))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_cache cache
          where cache.platform=m.platform
            and cache.lower_nickname=lower(m.player_id)
            and (cache.platform||':account:'||cache.id)=any(p_excluded)
        )))
      and m.kills>=0 and m.damage>=0
  ), score_sources as (
    select m.platform,m.player_id,m.match_id,b.score,b.tier,b.calculation_version,1 as source_priority
    from candidates m join public.global_benchmarks b
      on b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
    where (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
      and b.filter_version=p_filter and b.population_evidence_version=p_population
      and b.match_type in ('official','competitive') and b.score is not null
    union all
    select m.platform,m.player_id,m.match_id,f.score,f.tier,f.calculation_version,2 as source_priority
    from candidates m join public.pubg_match_performance f
      on f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
    where (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
      and f.result_version=p_result and f.ranking_eligible
  ), scores as (
    select distinct on (platform,player_id,match_id) platform,player_id,match_id,score,tier
    from score_sources order by platform,player_id,match_id,calculation_version desc,source_priority
  ), eligible as (
    select m.*,s.score as performance_score,s.tier as performance_tier
    from candidates m left join scores s using (platform,player_id,match_id)
    where (m.ranking_eligible is true or s.score is not null)
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

revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) to service_role;

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
    -- 이미 저장된 계산 2 자료와 활성 작업을 다시 계산하지 않는다.
    and (p_calculation<>3 or (
      not exists(select 1 from public.pubg_match_performance f
        where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id and f.calculation_version=2)
      and not exists(select 1 from public.pubg_performance_jobs old
        where old.platform=m.platform and old.account_id=m.account_id and old.match_id=m.match_id and old.calculation_version=2
          and (old.state='done' or (old.state='running' and old.lease_expires_at>now())))
      and not exists(select 1 from public.processed_match_telemetry old
        where old.platform=m.platform and old.player_id=m.player_id and old.match_id=m.match_id
          and old.data #> '{fullResult,calculationVersion}' = '2'::jsonb)
      and not exists(select 1 from public.global_benchmarks old
        where old.platform=m.platform and old.player_id=m.player_id and old.match_id=m.match_id and old.calculation_version=2)
    ))
  order by m.played_at desc
  limit least(50,greatest(0,300-(select count(*) from public.pubg_performance_jobs where state in ('pending','retry','running'))))
  on conflict do nothing;
  get diagnostics n=row_count; return n;
end $$;
REVOKE ALL ON FUNCTION public.seed_pubg_performance_jobs(integer,integer) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.seed_pubg_performance_jobs(integer,integer) TO service_role;
