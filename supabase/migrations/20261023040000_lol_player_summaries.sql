begin;
set local lock_timeout = '2s';

create table public.lol_player_match_summaries (
  puuid text not null references public.lol_accounts(puuid) on delete cascade,
  match_id text not null,
  platform_id text not null,
  queue_id integer not null,
  game_mode text,
  played_at timestamptz not null,
  duration_seconds integer,
  game_version text,
  champion_id integer,
  champion_name text,
  team_id smallint,
  team_position text,
  win boolean,
  remake boolean,
  kills integer, deaths integer, assists integer, cs integer,
  gold_earned integer, damage_to_champions integer, damage_taken integer,
  vision_score integer, wards_placed integer, wards_killed integer, detector_wards_placed integer,
  damage_to_objectives integer, damage_to_turrets integer, team_kills integer, champion_level integer,
  items integer[], summoner_spells integer[], perks jsonb,
  teammates jsonb not null default '[]'::jsonb check (jsonb_typeof(teammates) = 'array' and jsonb_array_length(teammates) <= 4),
  created_at timestamptz not null default now(),
  primary key (puuid, match_id)
);
create index lol_player_summaries_recent on public.lol_player_match_summaries (puuid, played_at desc);
create index lol_player_summaries_queue_recent on public.lol_player_match_summaries (puuid, queue_id, played_at desc);
alter table public.lol_player_match_summaries enable row level security;
revoke all on public.lol_player_match_summaries from public, anon, authenticated;
grant select, insert, update, delete on public.lol_player_match_summaries to service_role;

-- 같은 추출기를 저장 경로와 기존 원문 백필에 사용한다.
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
      'win',(mate->>'win')::boolean) order by n) from (
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

create or replace function public.get_lol_player_match_summaries(p_puuid text, p_limit integer, p_before timestamptz)
returns setof public.lol_player_match_summaries
language sql stable security invoker set search_path = '' as $$
  select s.* from public.lol_player_match_summaries s
  where s.puuid = p_puuid and (p_before is null or s.played_at < p_before)
  order by s.played_at desc, s.match_id desc
  limit greatest(1, least(coalesce(p_limit,20),100));
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

create or replace function public.cleanup_lol_expired_data()
returns table (cache_rows bigint, match_rows bigint, account_rows bigint, lease_rows bigint)
language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.lol_api_cache where expires_at <= pg_catalog.clock_timestamp(); get diagnostics cache_rows = row_count;
  delete from public.lol_matches where expires_at <= pg_catalog.clock_timestamp(); get diagnostics match_rows = row_count;
  account_rows := 0;
  delete from public.lol_collection_leases where lease_until <= pg_catalog.clock_timestamp(); get diagnostics lease_rows = row_count;
  return next;
end $$;

create or replace function public.preview_lol_expired_data()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with cutoff as (select pg_catalog.clock_timestamp() as at), counts as (
    select
      (select pg_catalog.count(*) from public.lol_api_cache, cutoff
       where expires_at <= cutoff.at) as cache_rows,
      (select pg_catalog.count(*) from public.lol_matches, cutoff
       where expires_at <= cutoff.at) as match_rows,
      0::bigint as account_rows,
      (select pg_catalog.count(*) from public.lol_collection_leases, cutoff
       where lease_until <= cutoff.at) as lease_rows
  )
  select pg_catalog.jsonb_build_object(
    'cache_rows', cache_rows,
    'match_rows', match_rows,
    'account_rows', account_rows,
    'lease_rows', lease_rows
  ) from counts;
$$;

create or replace function public.cleanup_lol_expired_batch(p_limit integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_cache_rows bigint;
  v_match_rows bigint;
  v_account_rows bigint;
  v_lease_rows bigint;
  v_remaining jsonb;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'p_limit must be between 1 and 1000' using errcode = '22023';
  end if;
  delete from public.lol_api_cache c
  where c.ctid in (
    select ctid from public.lol_api_cache
    where expires_at <= v_now order by expires_at, cache_key
    limit p_limit for update skip locked
  );
  get diagnostics v_cache_rows = row_count;
  -- 경기별 참가자 cascade 삭제 수는 부모 경기 배치 상한에 포함되지 않는다.
  delete from public.lol_matches m
  where m.ctid in (
    select ctid from public.lol_matches
    where expires_at <= v_now order by expires_at, match_id
    limit p_limit for update skip locked
  );
  get diagnostics v_match_rows = row_count;
  v_account_rows := 0;
  delete from public.lol_collection_leases l
  where l.ctid in (
    select ctid from public.lol_collection_leases
    where lease_until <= v_now order by lease_until, lease_key
    limit p_limit for update skip locked
  );
  get diagnostics v_lease_rows = row_count;
  v_remaining := public.preview_lol_expired_data();
  return pg_catalog.jsonb_build_object(
    'deleted', pg_catalog.jsonb_build_object(
      'cache_rows', v_cache_rows, 'match_rows', v_match_rows,
      'account_rows', v_account_rows, 'lease_rows', v_lease_rows
    ),
    'remaining', v_remaining
  );
end;
$$;

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
    'pending', public.preview_lol_expired_data()
  ) from bounds b;
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
    where not coalesce(lower(t->>'riotId')=any(v_riot_ids),false)
  ) where v_riot_ids is not null and exists (
    select 1 from jsonb_array_elements(s.teammates) t where lower(t->>'riotId')=any(v_riot_ids)
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

select public.upsert_lol_player_match_summaries(null,null);

revoke all on function public.upsert_lol_player_match_summaries(text,text),
  public.get_lol_player_match_summaries(text,integer,timestamptz), public.delete_lol_account_data(text)
  from public, anon, authenticated;
grant execute on function public.upsert_lol_player_match_summaries(text,text),
  public.get_lol_player_match_summaries(text,integer,timestamptz), public.delete_lol_account_data(text) to service_role;

commit;
