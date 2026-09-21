-- Keep ranking privacy aligned with the account registry even for legacy match
-- rows that predate pubg_player_matches.account_id. The player cache is the
-- local canonical nickname -> account mapping used by the public player flow.
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
        ))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_cache cache
          where cache.platform=m.platform
            and cache.lower_nickname=lower(m.player_id)
            and (m.platform||':account:'||cache.id)=any(p_excluded)
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

revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[]) to service_role;
