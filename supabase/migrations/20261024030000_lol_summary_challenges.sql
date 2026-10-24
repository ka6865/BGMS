begin;
set local lock_timeout = '2s';

-- 원문 만료 뒤에도 핵심 수치만 보존하며 JSON의 키 수와 저장 크기를 제한한다.
alter table public.lol_player_match_summaries
  add column challenges jsonb not null default '{}'::jsonb
  constraint lol_summary_challenges_bounds check (
    jsonb_typeof(challenges)='object'
    and jsonb_array_length(jsonb_path_query_array(challenges, '$.keyvalue()'))<=31
    and octet_length(challenges::text)<=4096
  );

create or replace function public.upsert_lol_player_match_summaries(p_match_id text, p_puuid text)
returns void language sql security invoker set search_path = '' as $$
  insert into public.lol_player_match_summaries (
    puuid, match_id, platform_id, queue_id, game_mode, played_at, duration_seconds, game_version,
    champion_id, champion_name, team_id, team_position, win, remake, kills, deaths, assists, cs,
    gold_earned, damage_to_champions, damage_taken, vision_score, wards_placed, wards_killed,
    detector_wards_placed, damage_to_objectives, damage_to_turrets, team_kills, champion_level,
    items, summoner_spells, perks, teammates, challenges
  )
  select a.puuid, m.match_id, m.platform_id, m.queue_id, m.request_json->'info'->>'gameMode',
    pg_catalog.to_timestamp((coalesce(
      (m.request_json->'info'->>'gameEndTimestamp')::numeric,
      (m.request_json->'info'->>'gameCreation')::numeric,
      (m.request_json->'info'->>'gameStartTimestamp')::numeric
    ) / 1000)::double precision),
    (m.request_json->'info'->>'gameDuration')::integer, m.game_version,
    (p->>'championId')::integer, p->>'championName', (p->>'teamId')::smallint,
    case when p->>'teamPosition' in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') then p->>'teamPosition' else '미분류' end,
    (p->>'win')::boolean,
    coalesce((p->>'gameEndedInEarlySurrender')::boolean, false) or exists (
      select 1 from jsonb_array_elements(m.request_json->'info'->'participants') t
      where t->>'teamId' = p->>'teamId' and (t->>'teamEarlySurrendered')::boolean is true
    ),
    (p->>'kills')::integer, (p->>'deaths')::integer, (p->>'assists')::integer,
    (p->>'totalMinionsKilled')::integer + (p->>'neutralMinionsKilled')::integer,
    (p->>'goldEarned')::integer, (p->>'totalDamageDealtToChampions')::integer,
    (p->>'totalDamageTaken')::integer, (p->>'visionScore')::integer,
    (p->>'wardsPlaced')::integer, (p->>'wardsKilled')::integer, (p->>'detectorWardsPlaced')::integer,
    (p->>'damageDealtToObjectives')::integer, (p->>'damageDealtToTurrets')::integer,
    (select case when count(*) = count(t->>'kills') then sum((t->>'kills')::integer)::integer end
      from jsonb_array_elements(m.request_json->'info'->'participants') t where t->>'teamId' = p->>'teamId'),
    (p->>'champLevel')::integer,
    array[(p->>'item0')::integer,(p->>'item1')::integer,(p->>'item2')::integer,(p->>'item3')::integer,
      (p->>'item4')::integer,(p->>'item5')::integer,(p->>'item6')::integer],
    array[(p->>'summoner1Id')::integer,(p->>'summoner2Id')::integer],
    jsonb_build_object('keystone',p#>'{perks,styles,0,selections,0,perk}',
      'primaryStyle',p#>'{perks,styles,0,style}','subStyle',p#>'{perks,styles,1,style}'),
    coalesce((select jsonb_agg(jsonb_build_object('riotId', mate->>'riotIdGameName' || '#' || (mate->>'riotIdTagline'),
      'win',(mate->>'win')::boolean,'puuid',mate->>'puuid') order by n) from (
        select mate, n from jsonb_array_elements(m.request_json->'info'->'participants') with ordinality t(mate,n)
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
  from public.lol_matches m
  cross join lateral jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p
  join public.lol_accounts a on a.puuid = p->>'puuid'
  where (p_match_id is null or m.match_id = p_match_id)
    and (p_puuid is null or (a.puuid = p_puuid and exists (
      select 1 from public.lol_match_participants mp where mp.match_id = m.match_id and mp.puuid = p_puuid
    )))
    and m.queue_id <> 0 and m.request_json->'info'->>'gameType' is distinct from 'CUSTOM_GAME'
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

-- 동일 추출기로 남아 있는 원문만 백필하고 만료된 경기 요약은 보존한다.
select public.upsert_lol_player_match_summaries(null,null);

commit;
