begin;
set local lock_timeout = '2s';

-- 경계값은 해당 값으로 시작하는 버킷에 포함하며 마지막 버킷은 상한이 없다.
create or replace function public.lol_benchmark_bounds(p_metric text)
returns double precision[] language sql immutable security invoker set search_path = '' as $$
  select case
    when p_metric in ('kill_participation','damage_share','death_share','objective_damage_share','turret_damage_share','damage_taken_share')
      then array[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1]::double precision[]
    when p_metric='cs_per_min' then array[2,4,6,8,10,12]::double precision[]
    when p_metric='gold_per_min' then array[200,300,400,500,600,800]::double precision[]
    when p_metric='vision_per_min' then array[0.5,1,1.5,2,3,4]::double precision[]
    when p_metric='control_wards' then array[1,2,3,5,8,12]::double precision[]
    when p_metric='wards_killed_per_min' then array[0.1,0.2,0.3,0.5,1,2]::double precision[]
    when p_metric='kda' then array[1,2,3,4,5,8,12,20]::double precision[]
    when p_metric='games' then array[1]::double precision[] end;
$$;

create table public.lol_benchmark_processed_matches (
  match_id text primary key,
  patch text,
  queue_id integer,
  processed_at timestamptz not null default now(),
  skipped_reason text check (skipped_reason in ('custom','remake','short','missing_duration','invalid_patch','invalid_participants'))
);
create table public.lol_benchmark_aggregates (
  patch text not null,
  queue_id integer not null,
  team_position text not null check (team_position in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY','미분류')),
  champion_id integer not null check (champion_id >= 0),
  metric text not null check (metric in (
    'games','kill_participation','damage_share','death_share','cs_per_min','gold_per_min','vision_per_min',
    'control_wards','wards_killed_per_min','objective_damage_share','turret_damage_share','damage_taken_share','kda'
  )),
  sample_count bigint not null check (sample_count > 0),
  sum double precision not null,
  sum_sq double precision not null,
  histogram integer[] not null,
  wins bigint not null default 0 check (wins >= 0 and wins <= sample_count and (metric='games' or wins=0)),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,team_position,champion_id,metric),
  check (cardinality(histogram)=cardinality(public.lol_benchmark_bounds(metric))+1)
);
alter table public.lol_benchmark_processed_matches enable row level security;
alter table public.lol_benchmark_aggregates enable row level security;
revoke all on public.lol_benchmark_processed_matches, public.lol_benchmark_aggregates from public, anon, authenticated;
grant select, insert, update, delete on public.lol_benchmark_processed_matches, public.lol_benchmark_aggregates to service_role;

-- 문자열·음수·불리언을 0으로 바꾸지 않고 결측으로 제외한다.
create or replace function public.lol_benchmark_number(p_value jsonb)
returns double precision language sql immutable security invoker set search_path = '' as $$
  select case when jsonb_typeof(p_value)='number' then
    case when p_value::numeric between 0 and 1000000000000 then p_value::double precision end end;
$$;

create or replace function public.aggregate_lol_match_benchmarks(p_match_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_raw jsonb; v_info jsonb; v_patch text; v_queue integer; v_duration double precision; v_reason text;
begin
  select skipped_reason into v_reason from public.lol_benchmark_processed_matches where match_id=p_match_id;
  if found then return jsonb_build_object('aggregated',false,'skipped',v_reason is not null,'reason',v_reason); end if;
  select request_json into v_raw from public.lol_matches where match_id=p_match_id;
  if not found or v_raw is null then
    raise exception 'LoL benchmark source missing' using errcode='22023';
  end if;
  v_info := v_raw->'info';
  v_patch := substring(v_info->>'gameVersion' from '^([0-9]+\.[0-9]+)(?:\.|$)');
  v_queue := coalesce(public.lol_benchmark_number(v_info->'queueId')::integer,0);
  v_duration := public.lol_benchmark_number(v_info->'gameDuration');
  v_reason := case
    when v_queue=0 or v_info->>'gameType'='CUSTOM_GAME' then 'custom'
    when v_duration is null then 'missing_duration'
    when v_duration<300 then 'short'
    when v_patch is null then 'invalid_patch'
    when jsonb_typeof(v_info->'participants') is distinct from 'array' then 'invalid_participants'
    when jsonb_array_length(v_info->'participants')<>10 then 'invalid_participants'
    when exists (select 1 from jsonb_array_elements(v_info->'participants') p
      where p->'gameEndedInEarlySurrender'='true'::jsonb or p->'teamEarlySurrendered'='true'::jsonb) then 'remake'
    when (select count(*) from jsonb_array_elements(v_info->'participants') p where p->>'teamId'='100')<>5
      or (select count(*) from jsonb_array_elements(v_info->'participants') p where p->>'teamId'='200')<>5 then 'invalid_participants'
    end;
  -- 먼저 고유 경기 행을 확보하여 동시 수집도 한 트랜잭션만 누적한다.
  insert into public.lol_benchmark_processed_matches(match_id,patch,queue_id,skipped_reason)
  values(p_match_id,v_patch,v_queue,v_reason) on conflict(match_id) do nothing;
  if not found then
    select skipped_reason into v_reason from public.lol_benchmark_processed_matches where match_id=p_match_id;
    return jsonb_build_object('aggregated',false,'skipped',v_reason is not null,'reason',v_reason);
  end if;
  if v_reason is not null then
    return jsonb_build_object('aggregated',false,'skipped',true,'reason',v_reason);
  end if;
  with players as (
    select p,
      case when p->>'teamPosition' in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') then p->>'teamPosition' else '미분류' end as position,
      public.lol_benchmark_number(p->'championId')::integer as champion,
      public.lol_benchmark_number(p->'kills') as kills, public.lol_benchmark_number(p->'deaths') as deaths,
      public.lol_benchmark_number(p->'assists') as assists,
      public.lol_benchmark_number(p->'totalDamageDealtToChampions') as damage,
      public.lol_benchmark_number(p->'damageDealtToObjectives') as objective,
      public.lol_benchmark_number(p->'damageDealtToTurrets') as turret,
      public.lol_benchmark_number(p->'totalDamageTaken') as taken
    from jsonb_array_elements(v_info->'participants') p
  ), teams as (
    select *,
      case when count(kills) over w=5 then sum(kills) over w end as team_kills,
      case when count(deaths) over w=5 then sum(deaths) over w end as team_deaths,
      case when count(damage) over w=5 then sum(damage) over w end as team_damage,
      case when count(objective) over w=5 then sum(objective) over w end as team_objective,
      case when count(turret) over w=5 then sum(turret) over w end as team_turret,
      case when count(taken) over w=5 then sum(taken) over w end as team_taken
    from players window w as (partition by p->>'teamId')
  ), samples as (
    select position, champion_key, metric, value, (p->'win'='true'::jsonb)::integer as won,
      1+(select count(*) from unnest(public.lol_benchmark_bounds(metric)) boundary where boundary<=value) as bucket
    from teams cross join lateral (values
      ('games',1::double precision),
      ('kill_participation',(kills+assists)/nullif(team_kills,0)),
      ('damage_share',damage/nullif(team_damage,0)), ('death_share',deaths/nullif(team_deaths,0)),
      ('cs_per_min',(public.lol_benchmark_number(p->'totalMinionsKilled')+public.lol_benchmark_number(p->'neutralMinionsKilled'))*60/v_duration),
      ('gold_per_min',public.lol_benchmark_number(p->'goldEarned')*60/v_duration),
      ('vision_per_min',public.lol_benchmark_number(p->'visionScore')*60/v_duration),
      ('control_wards',public.lol_benchmark_number(p->'detectorWardsPlaced')),
      ('wards_killed_per_min',public.lol_benchmark_number(p->'wardsKilled')*60/v_duration),
      ('objective_damage_share',objective/nullif(team_objective,0)), ('turret_damage_share',turret/nullif(team_turret,0)),
      ('damage_taken_share',taken/nullif(team_taken,0)),
      ('kda',case when deaths is not null then (kills+assists)/greatest(deaths,1) end)
    ) metrics(metric,value)
    cross join lateral (values (0),(champion)) champions(champion_key)
    where champion>0 and p->'win' in ('true'::jsonb,'false'::jsonb) and value is not null
  ), grouped as (
    select position,champion_key,metric,count(*) as n,sum(value) as total,sum(value*value) as squared,
      sum(case when metric='games' then won else 0 end) as wins,
      array(select (select count(*)::integer from samples s
        where s.position=a.position and s.champion_key=a.champion_key and s.metric=a.metric and s.bucket=i)
        from generate_series(1,cardinality(public.lol_benchmark_bounds(metric))+1) i) as histogram
    from samples a group by position,champion_key,metric
  )
  insert into public.lol_benchmark_aggregates as target
    (patch,queue_id,team_position,champion_id,metric,sample_count,sum,sum_sq,histogram,wins)
  select v_patch,v_queue,position,champion_key,metric,n,total,squared,histogram,wins from grouped
  order by position,champion_key,metric
  on conflict(patch,queue_id,team_position,champion_id,metric) do update set
    sample_count=target.sample_count+excluded.sample_count, sum=target.sum+excluded.sum, sum_sq=target.sum_sq+excluded.sum_sq,
    histogram=array(select target.histogram[i]+excluded.histogram[i] from generate_subscripts(target.histogram,1) i),
    wins=target.wins+excluded.wins, updated_at=pg_catalog.clock_timestamp();
  return jsonb_build_object('aggregated',true,'skipped',false,'reason',null);
end $$;

-- 수집에서는 만료되어도 아직 삭제되지 않은 원문을 재사용한다.
create or replace function public.get_lol_benchmark_match_source(p_match_id text,p_platform text,p_route text)
returns jsonb language sql security invoker set search_path = '' as $$
  select request_json from public.lol_matches
  where match_id=p_match_id and platform_id=p_platform and regional_route=p_route;
$$;

create or replace function public.get_lol_benchmark_summary(p_patch text,p_queue_id integer,p_team_position text,p_champion_id integer)
returns table(metric text,sample_count bigint,mean double precision,stddev double precision,histogram integer[],bounds double precision[],wins bigint)
language sql stable security invoker set search_path = '' as $$
  select a.metric,a.sample_count,a.sum/a.sample_count,
    sqrt(greatest(0,a.sum_sq/a.sample_count-power(a.sum/a.sample_count,2))),
    a.histogram,public.lol_benchmark_bounds(a.metric),a.wins
  from public.lol_benchmark_aggregates a
  where a.patch=p_patch and a.queue_id=p_queue_id and a.team_position=p_team_position and a.champion_id=p_champion_id
  order by a.metric;
$$;

create or replace function public.persist_lol_search_snapshot(
  p_lease_key text, p_token uuid, p_cache_key text, p_cache_payload jsonb,
  p_platform text, p_route text, p_version text, p_account jsonb, p_ranked jsonb, p_matches jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz; v_lease_until timestamptz; v_match jsonb; v_raw jsonb; v_info jsonb; v_participant jsonb;
  v_puuid text; v_match_id text; v_queue integer; v_played timestamptz; v_started timestamptz; v_data_version integer;
begin
  if p_platform not in ('kr','jp1','na1','br1','la1','la2','eun1','euw1','me1','tr1','ru','oc1','sg2','tw2','vn2')
    or p_route not in ('americas','asia','europe','sea') or length(p_version) > 32
    or jsonb_typeof(p_account) <> 'object' or jsonb_typeof(p_ranked) <> 'array' or jsonb_typeof(p_matches) <> 'array'
    or octet_length(p_cache_payload::text) > 262144 or p_lease_key is null or p_token is null then
    raise exception 'invalid LoL snapshot' using errcode = '22023';
  end if;
  select lease_until into v_lease_until from public.lol_collection_leases where lease_key=p_lease_key and lease_type='collection'
    and lease_token=p_token for update;
  v_now := pg_catalog.clock_timestamp();
  if not found or v_lease_until <= v_now then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;
  v_puuid := p_account->>'puuid';
  if v_puuid is null or length(v_puuid) not between 1 and 128 then raise exception 'invalid PUUID' using errcode='22023'; end if;
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route,profile_icon_id,summoner_level,account_fetched_at,profile_fetched_at,ranked_checked_at,last_accessed_at)
  values (v_puuid,p_account->>'game_name',p_account->>'tag_line',p_platform,p_route,nullif(p_account->>'profile_icon_id','')::integer,
    nullif(p_account->>'summoner_level','')::bigint,v_now,v_now,v_now,v_now)
  on conflict (puuid) do update set game_name=excluded.game_name,tag_line=excluded.tag_line,platform_id=excluded.platform_id,
    regional_route=excluded.regional_route,profile_icon_id=excluded.profile_icon_id,summoner_level=excluded.summoner_level,
    account_fetched_at=v_now,profile_fetched_at=v_now,ranked_checked_at=v_now,last_accessed_at=v_now;
  perform public.upsert_lol_player_match_summaries(null,v_puuid);
  delete from public.lol_ranked_entries where puuid=v_puuid and platform_id=p_platform;
  insert into public.lol_ranked_entries (puuid,platform_id,queue_type,tier,rank,league_points,wins,losses,fetched_at)
  select v_puuid,p_platform,r.queue_type,r.tier,r.rank,r.league_points,r.wins,r.losses,v_now
  from jsonb_to_recordset(p_ranked) as r(queue_type text,tier text,rank text,league_points integer,wins integer,losses integer);

  -- 계정 upsert의 행 잠금으로 같은 계정의 동시 이력 비교와 저장을 직렬화한다.
  insert into public.lol_ranked_history (puuid,queue_type,tier,rank,league_points,wins,losses,recorded_at)
  select current.puuid,current.queue_type,current.tier,current.rank,current.league_points,current.wins,current.losses,
    pg_catalog.clock_timestamp()
  from public.lol_ranked_entries current
  left join lateral (
    select history.tier,history.rank,history.league_points,history.wins,history.losses,history.id
    from public.lol_ranked_history history
    where history.puuid=current.puuid and history.queue_type=current.queue_type
    order by history.recorded_at desc,history.id desc limit 1
  ) previous on true
  where current.puuid=v_puuid and current.platform_id=p_platform
    and (previous.id is null or (current.tier,current.rank,current.league_points,current.wins,current.losses)
      is distinct from (previous.tier,previous.rank,previous.league_points,previous.wins,previous.losses));

  for v_match in select value from jsonb_array_elements(p_matches) loop
    v_raw := v_match->'raw'; v_info := v_raw->'info'; v_match_id := v_match->'summary'->>'matchId';
    if v_raw->'metadata'->>'matchId' is distinct from v_match_id or v_match_id is null or jsonb_typeof(v_info->'participants') is distinct from 'array' then
      raise exception 'invalid Riot match payload' using errcode='22023'; end if;
    v_queue := coalesce((v_info->>'queueId')::integer,0);
    v_data_version := coalesce(nullif(v_raw->'metadata'->>'dataVersion','')::integer,1);
    v_started := pg_catalog.to_timestamp((coalesce((v_info->>'gameStartTimestamp')::numeric,(v_info->>'gameCreation')::numeric,
      (v_info->>'gameEndTimestamp')::numeric - coalesce((v_info->>'gameDuration')::numeric,0)*1000) / 1000)::double precision);
    v_played := pg_catalog.to_timestamp((coalesce((v_info->>'gameEndTimestamp')::numeric,(v_info->>'gameStartTimestamp')::numeric,
      (v_info->>'gameCreation')::numeric) / 1000)::double precision);
    if v_info->>'gameStartTimestamp' is null and v_info->>'gameCreation' is null and v_info->>'gameEndTimestamp' is null then
      raise exception 'Riot match timestamp missing' using errcode='22023'; end if;
    insert into public.lol_matches (match_id,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,teams,data_version,summary_version,request_json,fetched_at,expires_at)
    values (v_match_id,p_platform,p_route,v_queue,nullif(v_info->>'mapId','')::integer,coalesce(v_info->>'gameVersion','Unknown'),
      v_started,coalesce((v_info->>'gameDuration')::integer,0),coalesce(v_info->'teams','[]'::jsonb),v_data_version,1,v_raw,v_now,v_now+interval '7 days')
    on conflict (match_id) do update set queue_id=excluded.queue_id,map_id=excluded.map_id,game_version=excluded.game_version,
      started_at=excluded.started_at,duration_seconds=excluded.duration_seconds,teams=excluded.teams,data_version=excluded.data_version,
      request_json=case when public.lol_matches.expires_at<=v_now then excluded.request_json else public.lol_matches.request_json end,
      fetched_at=case when public.lol_matches.expires_at<=v_now then excluded.fetched_at else public.lol_matches.fetched_at end,
      expires_at=case when public.lol_matches.expires_at<=v_now then excluded.expires_at else public.lol_matches.expires_at end
      where public.lol_matches.platform_id=excluded.platform_id and public.lol_matches.regional_route=excluded.regional_route;
    if not found then raise exception 'Riot match route conflict' using errcode='23505'; end if;
    perform public.aggregate_lol_match_benchmarks(v_match_id);
    for v_participant in select value from jsonb_array_elements(v_info->'participants') loop
      insert into public.lol_match_participants (match_id,participant_id,puuid,team_id,champion_id,team_position,win,kills,deaths,assists,cs,
        neutral_minions_killed,gold_earned,damage_to_champions,vision_score,wards_placed,wards_killed,damage_to_objectives,items,perks,played_at,queue_id)
      values (v_match_id,(v_participant->>'participantId')::smallint,nullif(v_participant->>'puuid',''),coalesce((v_participant->>'teamId')::smallint,0),
        coalesce((v_participant->>'championId')::integer,0),nullif(v_participant->>'teamPosition',''),coalesce((v_participant->>'win')::boolean,false),
        nullif(v_participant->>'kills','')::integer,nullif(v_participant->>'deaths','')::integer,nullif(v_participant->>'assists','')::integer,
        nullif(v_participant->>'totalMinionsKilled','')::integer,nullif(v_participant->>'neutralMinionsKilled','')::integer,
        nullif(v_participant->>'goldEarned','')::integer,nullif(v_participant->>'totalDamageDealtToChampions','')::integer,
        nullif(v_participant->>'visionScore','')::integer,nullif(v_participant->>'wardsPlaced','')::integer,nullif(v_participant->>'wardsKilled','')::integer,
        nullif(v_participant->>'damageDealtToObjectives','')::integer,
        array[(v_participant->>'item0')::integer,(v_participant->>'item1')::integer,(v_participant->>'item2')::integer,(v_participant->>'item3')::integer,
          (v_participant->>'item4')::integer,(v_participant->>'item5')::integer,(v_participant->>'item6')::integer],
        nullif(v_participant->'perks','null'::jsonb),v_played,v_queue)
      on conflict (match_id,participant_id) do update set puuid=excluded.puuid,team_id=excluded.team_id,champion_id=excluded.champion_id,
        team_position=excluded.team_position,win=excluded.win,kills=excluded.kills,deaths=excluded.deaths,assists=excluded.assists,cs=excluded.cs,
        neutral_minions_killed=excluded.neutral_minions_killed,gold_earned=excluded.gold_earned,damage_to_champions=excluded.damage_to_champions,
        vision_score=excluded.vision_score,wards_placed=excluded.wards_placed,wards_killed=excluded.wards_killed,
        damage_to_objectives=excluded.damage_to_objectives,items=excluded.items,perks=excluded.perks,played_at=excluded.played_at,queue_id=excluded.queue_id;
    end loop;
    perform public.upsert_lol_player_match_summaries(v_match_id,null);
  end loop;
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
  values (p_cache_key,'search',p_platform,p_route,p_version,
    jsonb_set(p_cache_payload,'{rankedHistory}',public.get_lol_ranked_history(v_puuid,30)),v_now,v_now+interval '2 minutes')
  on conflict (cache_key) do update set kind=excluded.kind,platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=v_now,expires_at=excluded.expires_at;
  delete from public.lol_collection_leases where lease_key=p_lease_key and lease_token=p_token;
  return true;
end $$;

create or replace function public.persist_lol_match_details(
  p_lease_key text,p_token uuid,p_cache_key text,p_cache_payload jsonb,p_platform text,p_route text,p_version text,
  p_match jsonb,p_participants jsonb,p_teams jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz; v_lease_until timestamptz; v_match_id text; v_info jsonb; v_participant jsonb; v_queue integer; v_played timestamptz; v_started timestamptz; v_data_version integer; v_match_expires_at timestamptz;
begin
  if jsonb_typeof(p_match)<>'object' or jsonb_typeof(p_participants)<>'array' or jsonb_typeof(p_teams)<>'array'
    or octet_length(p_cache_payload::text)>262144 then raise exception 'invalid match payload' using errcode='22023'; end if;
  select lease_until into v_lease_until from public.lol_collection_leases where lease_key=p_lease_key and lease_type='collection'
    and lease_token=p_token for update;
  v_now := pg_catalog.clock_timestamp();
  if not found or v_lease_until<=v_now then raise exception 'stale LoL collection lease' using errcode='40001'; end if;
  v_match_id := p_match->'metadata'->>'matchId'; v_info := p_match->'info';
  if v_match_id is null or jsonb_typeof(v_info->'participants') is distinct from 'array' then raise exception 'invalid Riot match payload' using errcode='22023'; end if;
  v_queue := coalesce((v_info->>'queueId')::integer,0); v_data_version := coalesce(nullif(p_match->'metadata'->>'dataVersion','')::integer,1);
  v_started := pg_catalog.to_timestamp((coalesce((v_info->>'gameStartTimestamp')::numeric,(v_info->>'gameCreation')::numeric,
    (v_info->>'gameEndTimestamp')::numeric - coalesce((v_info->>'gameDuration')::numeric,0)*1000)/1000)::double precision);
  v_played := pg_catalog.to_timestamp((coalesce((v_info->>'gameEndTimestamp')::numeric,(v_info->>'gameStartTimestamp')::numeric,
    (v_info->>'gameCreation')::numeric)/1000)::double precision);
  if v_info->>'gameStartTimestamp' is null and v_info->>'gameCreation' is null and v_info->>'gameEndTimestamp' is null then
    raise exception 'Riot match timestamp missing' using errcode='22023'; end if;
  insert into public.lol_matches (match_id,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,teams,data_version,summary_version,request_json,fetched_at,expires_at)
  values(v_match_id,p_platform,p_route,v_queue,nullif(v_info->>'mapId','')::integer,coalesce(v_info->>'gameVersion','Unknown'),
    v_started,coalesce((v_info->>'gameDuration')::integer,0),p_teams,
    v_data_version,1,p_match,v_now,v_now+interval '7 days')
  on conflict(match_id) do update set queue_id=excluded.queue_id,map_id=excluded.map_id,game_version=excluded.game_version,started_at=excluded.started_at,
    duration_seconds=excluded.duration_seconds,teams=excluded.teams,data_version=excluded.data_version,
    request_json=case when public.lol_matches.expires_at<=v_now then excluded.request_json else public.lol_matches.request_json end,
    fetched_at=case when public.lol_matches.expires_at<=v_now then excluded.fetched_at else public.lol_matches.fetched_at end,
    expires_at=case when public.lol_matches.expires_at<=v_now then excluded.expires_at else public.lol_matches.expires_at end
    where public.lol_matches.platform_id=excluded.platform_id and public.lol_matches.regional_route=excluded.regional_route;
  if not found then raise exception 'Riot match route conflict' using errcode='23505'; end if;
  perform public.aggregate_lol_match_benchmarks(v_match_id);
  select expires_at into v_match_expires_at from public.lol_matches where match_id=v_match_id;
  delete from public.lol_match_participants where match_id=v_match_id;
  for v_participant in select value from jsonb_array_elements(p_participants) loop
    insert into public.lol_match_participants (match_id,participant_id,puuid,team_id,champion_id,team_position,win,kills,deaths,assists,cs,
      neutral_minions_killed,gold_earned,damage_to_champions,vision_score,wards_placed,wards_killed,damage_to_objectives,items,perks,played_at,queue_id)
    values(v_match_id,(v_participant->>'participantId')::smallint,nullif(v_participant->>'puuid',''),coalesce((v_participant->>'teamId')::smallint,0),
      coalesce((v_participant->>'championId')::integer,0),nullif(v_participant->>'teamPosition',''),coalesce((v_participant->>'win')::boolean,false),
      nullif(v_participant->>'kills','')::integer,nullif(v_participant->>'deaths','')::integer,nullif(v_participant->>'assists','')::integer,
      nullif(v_participant->>'totalMinionsKilled','')::integer,nullif(v_participant->>'neutralMinionsKilled','')::integer,
      nullif(v_participant->>'goldEarned','')::integer,nullif(v_participant->>'totalDamageDealtToChampions','')::integer,nullif(v_participant->>'visionScore','')::integer,
      nullif(v_participant->>'wardsPlaced','')::integer,nullif(v_participant->>'wardsKilled','')::integer,nullif(v_participant->>'damageDealtToObjectives','')::integer,
      array[(v_participant->>'item0')::integer,(v_participant->>'item1')::integer,(v_participant->>'item2')::integer,(v_participant->>'item3')::integer,
        (v_participant->>'item4')::integer,(v_participant->>'item5')::integer,(v_participant->>'item6')::integer],
      nullif(v_participant->'perks','null'::jsonb),v_played,v_queue);
  end loop;
  perform public.upsert_lol_player_match_summaries(v_match_id,null);
  insert into public.lol_api_cache(cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
  values(p_cache_key,'match_details',p_platform,p_route,p_version,p_cache_payload,v_now,least(v_match_expires_at,v_now+interval '7 days'))
  on conflict(cache_key) do update set kind=excluded.kind,platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=v_now,expires_at=excluded.expires_at;
  delete from public.lol_collection_leases where lease_key=p_lease_key and lease_token=p_token;
  return true;
end $$;

create or replace function public.get_lol_ops_status()
returns jsonb language sql volatile security invoker set search_path = '' as $$
  with bounds as (
    select (pg_catalog.timezone('Asia/Seoul', pg_catalog.clock_timestamp()))::date as today,
      pg_catalog.clock_timestamp() as now_at
  ), metrics as (
    select d.day, d.metric, d.value from public.lol_ops_daily d, bounds b
    where d.day between b.today - 6 and b.today
  ), rate_limits as (
    select r.host, r.budget_day, r.used_count, r.blocked_until
    from public.lol_rate_limit_state r where r.host in ('global', 'asia', 'kr')
  ), table_sizes as (
    select 'lol_accounts'::text as table_name,
      (select pg_catalog.count(*) from public.lol_accounts) as rows,
      pg_catalog.pg_total_relation_size('public.lol_accounts'::regclass) as total_bytes
    union all select 'lol_ranked_entries',
      (select pg_catalog.count(*) from public.lol_ranked_entries),
      pg_catalog.pg_total_relation_size('public.lol_ranked_entries'::regclass)
    union all select 'lol_ranked_history',
      (select pg_catalog.count(*) from public.lol_ranked_history),
      pg_catalog.pg_total_relation_size('public.lol_ranked_history'::regclass)
    union all select 'lol_player_match_summaries',
      (select pg_catalog.count(*) from public.lol_player_match_summaries),
      pg_catalog.pg_total_relation_size('public.lol_player_match_summaries'::regclass)
    union all select 'lol_benchmark_processed_matches',
      (select pg_catalog.count(*) from public.lol_benchmark_processed_matches),
      pg_catalog.pg_total_relation_size('public.lol_benchmark_processed_matches'::regclass)
    union all select 'lol_benchmark_aggregates',
      (select pg_catalog.count(*) from public.lol_benchmark_aggregates),
      pg_catalog.pg_total_relation_size('public.lol_benchmark_aggregates'::regclass)
    union all select 'lol_matches',
      (select pg_catalog.count(*) from public.lol_matches),
      pg_catalog.pg_total_relation_size('public.lol_matches'::regclass)
    union all select 'lol_match_participants',
      (select pg_catalog.count(*) from public.lol_match_participants),
      pg_catalog.pg_total_relation_size('public.lol_match_participants'::regclass)
    union all select 'lol_api_cache',
      (select pg_catalog.count(*) from public.lol_api_cache),
      pg_catalog.pg_total_relation_size('public.lol_api_cache'::regclass)
    union all select 'lol_rate_limit_state',
      (select pg_catalog.count(*) from public.lol_rate_limit_state),
      pg_catalog.pg_total_relation_size('public.lol_rate_limit_state'::regclass)
    union all select 'lol_collection_leases',
      (select pg_catalog.count(*) from public.lol_collection_leases),
      pg_catalog.pg_total_relation_size('public.lol_collection_leases'::regclass)
    union all select 'lol_ops_daily',
      (select pg_catalog.count(*) from public.lol_ops_daily),
      pg_catalog.pg_total_relation_size('public.lol_ops_daily'::regclass)
  )
  select pg_catalog.jsonb_build_object(
    'today', b.today,
    'todayRiotCalls', coalesce((
      select pg_catalog.sum(m.value) from metrics m
      where m.day = b.today and m.metric like 'riot\_%' escape '\'
    ), 0),
    'metrics', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'day', m.day, 'metric', m.metric, 'value', m.value
      ) order by m.day, m.metric) from metrics m
    ), '[]'::jsonb),
    'rateLimits', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'host', r.host, 'budgetDay', r.budget_day,
        'usedCount', r.used_count, 'blockedUntil', nullif(r.blocked_until,'-infinity'::timestamptz)
      ) order by r.host) from rate_limits r
    ), '[]'::jsonb),
    'cooldownActive', exists (
      select 1 from rate_limits r where r.blocked_until > b.now_at
    ),
    'tables', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table', t.table_name, 'rows', t.rows, 'totalBytes', t.total_bytes
      ) order by t.table_name) from table_sizes t
    ),
    'benchmarks', (select jsonb_build_object('processed',count(*),
      'skipped',count(*) filter (where skipped_reason is not null)) from public.lol_benchmark_processed_matches),
    'pending', public.preview_lol_expired_data()
  ) from bounds b;
$$;

revoke all on function public.lol_benchmark_bounds(text),public.lol_benchmark_number(jsonb),
  public.aggregate_lol_match_benchmarks(text),public.get_lol_benchmark_summary(text,integer,text,integer),
  public.get_lol_benchmark_match_source(text,text,text) from public, anon, authenticated;
grant execute on function public.lol_benchmark_bounds(text),public.lol_benchmark_number(jsonb),
  public.aggregate_lol_match_benchmarks(text),public.get_lol_benchmark_summary(text,integer,text,integer),
  public.get_lol_benchmark_match_source(text,text,text) to service_role;

-- 원문이 남아 있는 경기만 백필할 수 있다.
select public.aggregate_lol_match_benchmarks(match_id) from public.lol_matches where request_json is not null order by match_id;
commit;
