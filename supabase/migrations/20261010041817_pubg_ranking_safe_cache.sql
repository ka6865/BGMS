-- 비공개 닉네임의 대소문자 표기도 동일한 계정으로 제외한다. 계산·순위 계약은 유지한다.
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
      and not ((m.platform||':'||lower(m.player_id))=any(p_excluded)
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

-- 비공개 판단은 캐시 밖에서 매번 수행한다. 관리자·지원 문의의 모든 저장 경로를 함께 반영한다.
create or replace function public.pubg_ranking_private_keys()
returns text[] language plpgsql stable security invoker set search_path='' as $$
declare settings jsonb; keys text[];
begin
  select coalesce(nullif(value,'')::jsonb,'[]'::jsonb) into settings
  from public.system_settings where key='private_players_list';
  settings:=coalesce(settings,'[]'::jsonb);
  if jsonb_typeof(settings)<>'array' or exists (
    select 1 from jsonb_array_elements(settings) e
    where jsonb_typeof(e)<>'object'
      or coalesce(lower(e->>'platform'),'') not in ('steam','kakao','all')
      or (coalesce(btrim(e->>'lower_nickname'),btrim(e->>'nickname'),'')=''
          and coalesce(btrim(e->>'account_id'),'')='')
  ) then raise exception 'Invalid ranking privacy settings'; end if;
  select coalesce(array_agg(distinct key order by key),'{}'::text[]) into keys
  from (
    select platform||':'||lower(btrim(coalesce(nullif(e->>'lower_nickname',''),e->>'nickname'))) as key
    from jsonb_array_elements(settings) e
    cross join lateral unnest(case when lower(e->>'platform')='all' then array['steam','kakao'] else array[lower(e->>'platform')] end) platform
    where coalesce(nullif(e->>'lower_nickname',''),e->>'nickname','')<>''
    union all
    select platform||':account:'||btrim(e->>'account_id')
    from jsonb_array_elements(settings) e
    cross join lateral unnest(case when lower(e->>'platform')='all' then array['steam','kakao'] else array[lower(e->>'platform')] end) platform
    where coalesce(btrim(e->>'account_id'),'')<>''
  ) excluded;
  return keys;
end $$;

-- 과거 경기의 계정 연결이 나중에 생겨도 캐시에 남은 공개 결과를 반환하지 않는다.
create or replace function public.pubg_ranking_cached_entries_public(p_entries jsonb,p_excluded text[])
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists (
    select 1 from jsonb_to_recordset(p_entries) e(platform text,player_id text,account_id text,played_at timestamptz)
    where (e.platform||':'||lower(e.player_id))=any(p_excluded)
      or (e.platform||':account:'||e.account_id)=any(p_excluded)
      or not exists (select 1 from public.pubg_player_matches m
        where m.platform=e.platform and m.player_id=e.player_id and m.played_at=e.played_at
          and m.account_id is not distinct from e.account_id)
      or exists (
        select 1 from public.pubg_player_matches m
        where m.platform=e.platform and m.player_id=e.player_id and m.played_at=e.played_at
          and m.account_id is not distinct from e.account_id
          and ((m.platform||':account:'||m.account_id)=any(p_excluded)
            or (m.account_id is null and exists (
              select 1 from public.pubg_player_match_discovery d
              where d.platform=m.platform and d.match_id=m.match_id
                and (d.platform||':account:'||d.account_id)=any(p_excluded)))
            or (m.account_id is null and exists (
              select 1 from public.pubg_player_cache c
              where c.platform=m.platform and c.lower_nickname=lower(m.player_id)
                and (c.platform||':account:'||c.id)=any(p_excluded))))
      )
  );
$$;

create or replace function public.get_pubg_rankings_cached(
  p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer
) returns jsonb language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  private_keys text[]; current_excluded text[]; modes text[]; ranking_key text;
  cached jsonb; entries jsonb; generated_at timestamptz; cache_expires_at timestamptz;
  started_at timestamptz:=clock_timestamp(); aggregation_started timestamptz; aggregation_ms numeric:=0;
  attempt integer; is_public boolean;
begin
  if p_tab is null or p_tab not in ('damage','kills','tier')
    or p_match_type is null or p_match_type not in ('all','official','competitive')
    or p_modes is null or cardinality(p_modes)=0 or array_position(p_modes,null) is not null
    or not p_modes <@ array['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp']::text[]
    or p_calculation is null or p_filter is null or p_population is null or p_result is null
  then raise exception 'Invalid ranking query'; end if;
  select array_agg(distinct mode order by mode) into modes from unnest(p_modes) mode;
  private_keys:=public.pubg_ranking_private_keys();
  ranking_key:='rankings:v1:'||md5(jsonb_build_array(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,private_keys)::text);
  for attempt in 1..2 loop
    -- 트랜잭션 안에서 다른 캐시 키의 잠금을 추가로 잡지 않는다.
    if attempt>1 and public.pubg_ranking_private_keys() is distinct from private_keys
    then raise exception 'Ranking privacy changed during query'; end if;
    select payload into cached from public.pubg_response_cache c
    where c.cache_key=ranking_key and c.expires_at>clock_timestamp();
    if cached is null then
      -- 같은 조건의 다른 서버도 잠금 대기 후 완성된 결과를 재사용한다.
      perform pg_advisory_xact_lock(hashtextextended(ranking_key,0));
      select payload into cached from public.pubg_response_cache c
      where c.cache_key=ranking_key and c.expires_at>clock_timestamp();
    end if;
    if cached is not null then
      select public.pubg_ranking_private_keys(),public.pubg_ranking_cached_entries_public(cached->'entries',private_keys)
      into current_excluded,is_public;
      if current_excluded is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
      if is_public then
        return cached||jsonb_build_object('cache_hit',true,
          'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',0);
      end if;
      perform pg_advisory_xact_lock(hashtextextended(ranking_key,0));
      -- 잠금 대기 중 다른 요청이 비공개 대상을 제외하고 다시 채웠을 수 있다.
      select payload into cached from public.pubg_response_cache c
      where c.cache_key=ranking_key and c.expires_at>clock_timestamp();
      select public.pubg_ranking_private_keys(),public.pubg_ranking_cached_entries_public(cached->'entries',private_keys)
      into current_excluded,is_public;
      if current_excluded is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
      if cached is not null and is_public then
        return cached||jsonb_build_object('cache_hit',true,
          'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',0);
      end if;
    end if;
    aggregation_started:=clock_timestamp();
    select coalesce(jsonb_agg(to_jsonb(r)-'ordinality' order by ordinality),'[]'::jsonb) into entries
    from public.get_pubg_rankings(p_tab,modes,p_match_type,p_calculation,p_filter,p_population,p_result,private_keys) with ordinality r;
    aggregation_ms:=aggregation_ms+round(extract(epoch from clock_timestamp()-aggregation_started)*1000);
    select public.pubg_ranking_private_keys(),public.pubg_ranking_cached_entries_public(entries,private_keys)
    into current_excluded,is_public;
    if current_excluded is distinct from private_keys then raise exception 'Ranking privacy changed during query'; end if;
    if not is_public then continue; end if;
    generated_at:=clock_timestamp();
    select least(generated_at+interval '60 seconds',coalesce(min(e.played_at)+interval '7 days',generated_at+interval '60 seconds'))
      into cache_expires_at from jsonb_to_recordset(entries) e(played_at timestamptz);
    cached:=jsonb_build_object('entries',entries,'generated_at',generated_at);
    insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
    values(ranking_key,cached,cache_expires_at,generated_at)
    on conflict (cache_key) do update set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at;
    return cached||jsonb_build_object('cache_hit',false,
      'database_ms',round(extract(epoch from clock_timestamp()-started_at)*1000),'aggregation_ms',aggregation_ms);
  end loop;
  raise exception 'Ranking privacy changed during query';
end $$;

revoke all on function public.pubg_ranking_private_keys() from public,anon,authenticated;
revoke all on function public.pubg_ranking_cached_entries_public(jsonb,text[]) from public,anon,authenticated;
revoke all on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.pubg_ranking_private_keys() to service_role;
grant execute on function public.pubg_ranking_cached_entries_public(jsonb,text[]) to service_role;
grant execute on function public.get_pubg_rankings_cached(text,text[],text,integer,integer,integer,integer) to service_role;
