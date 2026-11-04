begin;
set local lock_timeout='2s';

create or replace function public.upsert_lol_player_match_summaries(p_match_id text, p_puuid text)
returns void language sql security invoker set search_path = '' as $$
  -- 계정별 백필은 참가자 인덱스로 범위를 정한 뒤 원문 JSON을 한 번만 읽는다.
  with target_ids as materialized (
    select m.match_id from public.lol_matches m where p_match_id is not null and m.match_id=p_match_id
      and (p_puuid is null or exists (select 1 from public.lol_match_participants mp where mp.match_id=m.match_id and mp.puuid=p_puuid))
    union all
    select mp.match_id from public.lol_match_participants mp
    where p_match_id is null and p_puuid is not null and mp.puuid=p_puuid
      and not exists (select 1 from public.lol_player_match_summaries s where s.puuid=p_puuid and s.match_id=mp.match_id)
    union all
    select m.match_id from public.lol_matches m where p_match_id is null and p_puuid is null
  ), selected_matches as materialized (
    select m.match_id,m.platform_id,m.queue_id,m.game_version,m.request_json->'info' as info
    from target_ids ids join public.lol_matches m on m.match_id=ids.match_id
    where m.queue_id<>0
  )
  insert into public.lol_player_match_summaries (
    puuid, match_id, platform_id, queue_id, game_mode, played_at, duration_seconds, game_version,
    champion_id, champion_name, team_id, team_position, win, remake, kills, deaths, assists, cs,
    gold_earned, damage_to_champions, damage_taken, vision_score, wards_placed, wards_killed,
    detector_wards_placed, damage_to_objectives, damage_to_turrets, team_kills, champion_level,
    items, summoner_spells, perks, teammates, challenges
  )
  select a.puuid, m.match_id, m.platform_id, m.queue_id, m.info->>'gameMode',
    pg_catalog.to_timestamp((coalesce(
      (m.info->>'gameEndTimestamp')::numeric,
      (m.info->>'gameCreation')::numeric,
      (m.info->>'gameStartTimestamp')::numeric
    ) / 1000)::double precision),
    (m.info->>'gameDuration')::integer, m.game_version,
    (p->>'championId')::integer, p->>'championName', (p->>'teamId')::smallint,
    case when p->>'teamPosition' in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') then p->>'teamPosition' else '미분류' end,
    (p->>'win')::boolean,
    coalesce((p->>'gameEndedInEarlySurrender')::boolean, false) or exists (
      select 1 from jsonb_array_elements(m.info->'participants') t
      where t->>'teamId' = p->>'teamId' and (t->>'teamEarlySurrendered')::boolean is true
    ),
    (p->>'kills')::integer, (p->>'deaths')::integer, (p->>'assists')::integer,
    (p->>'totalMinionsKilled')::integer + (p->>'neutralMinionsKilled')::integer,
    (p->>'goldEarned')::integer, (p->>'totalDamageDealtToChampions')::integer,
    (p->>'totalDamageTaken')::integer, (p->>'visionScore')::integer,
    (p->>'wardsPlaced')::integer, (p->>'wardsKilled')::integer, (p->>'detectorWardsPlaced')::integer,
    (p->>'damageDealtToObjectives')::integer, (p->>'damageDealtToTurrets')::integer,
    (select case when count(*) = count(t->>'kills') then sum((t->>'kills')::integer)::integer end
      from jsonb_array_elements(m.info->'participants') t where t->>'teamId' = p->>'teamId'),
    (p->>'champLevel')::integer,
    array[(p->>'item0')::integer,(p->>'item1')::integer,(p->>'item2')::integer,(p->>'item3')::integer,
      (p->>'item4')::integer,(p->>'item5')::integer,(p->>'item6')::integer],
    array[(p->>'summoner1Id')::integer,(p->>'summoner2Id')::integer],
    jsonb_build_object('keystone',p#>'{perks,styles,0,selections,0,perk}',
      'primaryStyle',p#>'{perks,styles,0,style}','subStyle',p#>'{perks,styles,1,style}'),
    coalesce((select jsonb_agg(jsonb_build_object('riotId', mate->>'riotIdGameName' || '#' || (mate->>'riotIdTagline'),
      'win',(mate->>'win')::boolean,'puuid',mate->>'puuid') order by n) from (
        select mate, n from jsonb_array_elements(m.info->'participants') with ordinality t(mate,n)
        where mate->>'teamId' = p->>'teamId' and mate->>'puuid' <> a.puuid
          and nullif(btrim(mate->>'riotIdGameName'),'') is not null and nullif(btrim(mate->>'riotIdTagline'),'') is not null
        order by n limit 4
      ) teammates), '[]'::jsonb),
    coalesce((select jsonb_object_agg(key,value)
      from jsonb_each(case when jsonb_typeof(p->'challenges')='object' then p->'challenges' else '{}'::jsonb end)
      where key=any(array[
        'laningPhaseGoldExpAdvantage','earlyLaningPhaseGoldExpAdvantage','maxCsAdvantageOnLaneOpponent',
        'maxLevelLeadLaneOpponent','visionScoreAdvantageLaneOpponent','laneMinionsFirst10Minutes',
        'jungleCsBefore10Minutes','turretPlatesTaken','soloKills',
        'damageTakenOnTeamPercentage','teamDamagePercentage','killParticipation',
        'kda','visionScorePerMinute','wardTakedowns',
        'controlWardsPlaced','stealthWardsPlaced','epicMonsterSteals',
        'dragonTakedowns','baronTakedowns','riftHeraldTakedowns',
        'firstTurretKilled','turretTakedowns','killsUnderOwnTurret',
        'tookLargeDamageSurvived','saveAllyFromDeath','effectiveHealAndShielding',
        'skillshotsDodged','skillshotsHit','goldPerMinute',
        'damagePerMinute'
      ]::text[]) and jsonb_typeof(value)='number' and octet_length(value::text)<=64), '{}'::jsonb)
  from selected_matches m
  cross join lateral jsonb_array_elements(coalesce(m.info->'participants','[]'::jsonb)) p
  join public.lol_accounts a on a.puuid = p->>'puuid'
  where (p_puuid is null or a.puuid=p_puuid)
    and m.info->>'gameType' is distinct from 'CUSTOM_GAME'
  on conflict (puuid, match_id) do update set
    platform_id=excluded.platform_id, queue_id=excluded.queue_id, game_mode=excluded.game_mode,
    played_at=excluded.played_at, duration_seconds=excluded.duration_seconds, game_version=excluded.game_version,
    champion_id=excluded.champion_id, champion_name=excluded.champion_name, team_id=excluded.team_id,
    team_position=excluded.team_position, win=excluded.win, remake=excluded.remake,
    kills=excluded.kills, deaths=excluded.deaths, assists=excluded.assists, cs=excluded.cs,
    gold_earned=excluded.gold_earned, damage_to_champions=excluded.damage_to_champions, damage_taken=excluded.damage_taken,
    vision_score=excluded.vision_score, wards_placed=excluded.wards_placed, wards_killed=excluded.wards_killed,
    detector_wards_placed=excluded.detector_wards_placed, damage_to_objectives=excluded.damage_to_objectives,
    damage_to_turrets=excluded.damage_to_turrets, team_kills=excluded.team_kills, champion_level=excluded.champion_level,
    items=excluded.items, summoner_spells=excluded.summoner_spells, perks=excluded.perks, teammates=excluded.teammates, challenges=excluded.challenges;
$$;

revoke all on function public.upsert_lol_player_match_summaries(text,text) from public, anon, authenticated;
grant execute on function public.upsert_lol_player_match_summaries(text,text) to service_role;


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
  ), bucket_counts as materialized (
    select position,champion_key,metric,bucket,count(*)::integer as n
    from samples group by position,champion_key,metric,bucket
  ), totals as (
    select position,champion_key,metric,count(*) as n,sum(value) as total,sum(value*value) as squared,
      sum(case when metric='games' then won else 0 end) as wins
    from samples group by position,champion_key,metric
  ), grouped as (
    select a.position,a.champion_key,a.metric,a.n,a.total,a.squared,a.wins,
      array_agg(coalesce(b.n,0) order by i) as histogram
    from totals a
    cross join lateral generate_series(1,cardinality(public.lol_benchmark_bounds(a.metric))+1) i
    left join bucket_counts b on b.position=a.position and b.champion_key=a.champion_key and b.metric=a.metric and b.bucket=i
    group by a.position,a.champion_key,a.metric,a.n,a.total,a.squared,a.wins
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

revoke all on function public.aggregate_lol_match_benchmarks(text) from public,anon,authenticated;
grant execute on function public.aggregate_lol_match_benchmarks(text) to service_role;

commit;
