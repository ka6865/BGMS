begin;
set local lock_timeout = '2s';

create or replace function public.get_lol_account_names_by_puuids(p_puuids text[])
returns table (puuid text, game_name text, tag_line text, account_fetched_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_puuids is null or cardinality(p_puuids) > 100 or exists (
    select 1 from unnest(p_puuids) p where p is null or length(p) not between 1 and 128
  ) then raise exception 'invalid participant lookup' using errcode='22023'; end if;
  return query select a.puuid,a.game_name,a.tag_line,a.account_fetched_at
    from public.lol_accounts a where a.puuid=any(p_puuids) and a.platform_id='kr' and a.regional_route='asia';
end;
$$;

revoke all on function public.get_lol_account_names_by_puuids(text[]) from public, anon, authenticated;
grant execute on function public.get_lol_account_names_by_puuids(text[]) to service_role;

create or replace function public.upsert_lol_player_match_summaries(p_match_id text, p_puuid text)
returns void language sql security invoker set search_path = '' as $$
  insert into public.lol_player_match_summaries (
    puuid, match_id, platform_id, queue_id, game_mode, played_at, duration_seconds, game_version,
    champion_id, champion_name, team_id, team_position, win, remake, kills, deaths, assists, cs,
    gold_earned, damage_to_champions, damage_taken, vision_score, wards_placed, wards_killed,
    detector_wards_placed, damage_to_objectives, damage_to_turrets, team_kills, champion_level,
    items, summoner_spells, perks, teammates
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
      ) teammates), '[]'::jsonb)
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
    items=excluded.items, summoner_spells=excluded.summoner_spells, perks=excluded.perks, teammates=excluded.teammates;
$$;

create or replace function public.delete_lol_account_data(p_puuid text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_riot_id text; v_riot_ids text[]; v_match_ids text[];
  v_accounts bigint; v_ranked bigint; v_history bigint; v_summaries bigint;
  v_teammates bigint; v_participants bigint; v_matches bigint; v_cache bigint; v_leases bigint;
begin
  if p_puuid is null or length(p_puuid) not between 1 and 128 then
    raise exception 'invalid PUUID' using errcode='22023';
  end if;
  delete from public.lol_collection_leases where lease_type='collection';
  get diagnostics v_leases = row_count;
  select game_name || '#' || tag_line into v_riot_id from public.lol_accounts where puuid=p_puuid for update;
  select coalesce(array_agg(match_id),'{}'::text[]) into v_match_ids from public.lol_matches m
  where exists (select 1 from jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p where p->>'puuid'=p_puuid)
    or exists (select 1 from public.lol_match_participants p where p.match_id=m.match_id and p.puuid=p_puuid);
  select array_agg(distinct lower(riot_id)) into v_riot_ids from (
    select v_riot_id as riot_id
    union all
    select (p->>'riotIdGameName') || '#' || (p->>'riotIdTagline')
    from public.lol_matches m, jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p
    where m.match_id=any(v_match_ids) and p->>'puuid'=p_puuid
  ) ids where riot_id is not null;
  select count(*) into v_ranked from public.lol_ranked_entries where puuid=p_puuid;
  select count(*) into v_history from public.lol_ranked_history where puuid=p_puuid;
  select count(*) into v_summaries from public.lol_player_match_summaries where puuid=p_puuid;
  -- DTO 내부의 과거 이름과 동료 참조도 제거하려고 짧은 캐시는 모두 무효화한다.
  delete from public.lol_api_cache;
  get diagnostics v_cache = row_count;
  update public.lol_player_match_summaries s set teammates=(
    select coalesce(jsonb_agg(t order by n),'[]'::jsonb)
    from jsonb_array_elements(s.teammates) with ordinality x(t,n)
    where t->>'puuid' is distinct from p_puuid and not coalesce(lower(t->>'riotId')=any(v_riot_ids),false)
  ) where exists (
    select 1 from jsonb_array_elements(s.teammates) t where t->>'puuid'=p_puuid or lower(t->>'riotId')=any(v_riot_ids)
  );
  get diagnostics v_teammates = row_count;
  select count(*) into v_participants from public.lol_match_participants where match_id=any(v_match_ids);
  -- 원문의 식별자를 재사용하거나 다시 백필하지 않도록 관련 원문도 제거한다.
  delete from public.lol_matches where match_id=any(v_match_ids);
  get diagnostics v_matches = row_count;
  delete from public.lol_accounts where puuid=p_puuid;
  get diagnostics v_accounts = row_count;
  return jsonb_build_object('account_rows',v_accounts,'ranked_rows',v_ranked,'history_rows',v_history,
    'summary_rows',v_summaries,'teammate_rows',v_teammates,'participant_rows',v_participants,'match_rows',v_matches,'cache_rows',v_cache,'lease_rows',v_leases);
end;
$$;

-- 원문 JSON이 있는 경기만 공통 추출기로 백필하며 원문이 만료된 요약은 보존한다.
select public.upsert_lol_player_match_summaries(null,null);

commit;
