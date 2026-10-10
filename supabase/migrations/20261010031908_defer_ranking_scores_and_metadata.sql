-- 피해량·킬의 적격 기본 경기는 점수 조회를 건너뛰고, 표시 정보는 최종 30명만 조회한다.
-- 기존·신규 점수 우선순위, 비공개 제외, 참가 경기 수와 동점 순서는 유지한다.
create or replace function public.get_pubg_rankings(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_excluded text[] default '{}')
returns table(platform text,player_id text,account_id text,value double precision,secondary double precision,tier text,game_mode text,map_name text,played_at timestamptz,match_count bigint)
language sql stable security invoker set search_path='' as $$
with tier_match_keys as materialized (
    select b.platform,b.player_id,b.match_id from public.global_benchmarks b
    where p_tab='tier'
      and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
      and b.filter_version=p_filter and b.population_evidence_version=p_population
      and b.match_type in ('official','competitive') and b.score is not null
    union
    select m.platform,m.player_id,m.match_id from public.pubg_match_performance f
    join public.pubg_player_matches m on m.platform=f.platform and m.account_id=f.account_id and m.match_id=f.match_id
    where p_tab='tier'
      and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
      and f.result_version=p_result and f.ranking_eligible
      and m.played_at>=now()-interval '7 days' and m.played_at<=now()
  ), candidate_matches as (
    select m.* from tier_match_keys k join public.pubg_player_matches m using (platform,player_id,match_id) where p_tab='tier'
    union all
    select m.* from public.pubg_player_matches m where p_tab<>'tier'
  ), candidates as (
    select m.platform,m.player_id,m.account_id,m.match_id,m.played_at,m.kills,m.damage,m.ranking_eligible,
      case when m.account_id ~ '^account\.[A-Za-z0-9_-]+$' then m.account_id else 'legacy:'||m.player_id end as identity
    from candidate_matches m
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
  ), eligible as (
    select m.*,
      case when p_tab='tier' or m.ranking_eligible is not true then (
        select source.score from (
          select b.score,b.calculation_version,1 as source_priority
          from public.global_benchmarks b
          where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
            and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
            and b.filter_version=p_filter and b.population_evidence_version=p_population
            and b.match_type in ('official','competitive') and b.score is not null
          union all
          select f.score,f.calculation_version,2 as source_priority
          from public.pubg_match_performance f
          where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
            and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
            and f.result_version=p_result and f.ranking_eligible
        ) source order by source.calculation_version desc,source.source_priority limit 1
      ) end as performance_score
    from candidates m
  ), ranked as (
    select e.platform,e.player_id,e.match_id,e.identity,e.played_at,
      case p_tab when 'damage' then e.damage::double precision when 'kills' then e.kills::double precision else e.performance_score end as metric,
      case p_tab when 'damage' then e.kills::double precision else e.damage::double precision end as extra
    from eligible e where p_tab in ('damage','kills','tier')
      and (e.ranking_eligible is true or e.performance_score is not null)
      and (p_tab<>'tier' or e.performance_score is not null)
  ), best as (
    select r.*,row_number() over player_matches as pos,count(*) over player_matches as n
    from ranked r
    -- 전체 경기 수를 세되, 최고 경기 선택과 같은 정렬을 한 번만 수행한다.
    window player_matches as (partition by r.platform,r.identity
      order by r.metric desc,r.extra desc,r.played_at desc,r.match_id
      rows between unbounded preceding and unbounded following)
  ), winners as (
    select b.* from best b where pos=1
    order by metric desc,extra desc,played_at desc,b.platform,b.identity limit 30
  )
  select b.platform,b.player_id,m.account_id,b.metric,b.extra,s.tier,m.game_mode,m.map_name,b.played_at,b.n
  from winners b join public.pubg_player_matches m using (platform,player_id,match_id)
  left join lateral (
    select source.score,source.tier from (
        select b.score,b.tier,b.calculation_version,1 as source_priority
        from public.global_benchmarks b
        where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
          and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
          and b.filter_version=p_filter and b.population_evidence_version=p_population
          and b.match_type in ('official','competitive') and b.score is not null
        union all
        select f.score,f.tier,f.calculation_version,2 as source_priority
        from public.pubg_match_performance f
        where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
          and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
          and f.result_version=p_result and f.ranking_eligible
      ) source order by source.calculation_version desc,source.source_priority limit 1
  ) s on true
  order by b.metric desc,b.extra desc,b.played_at desc,b.platform,b.identity;
$$;
revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) to service_role;
